import { buildOpml, parseOpml } from "@boreas/opml";
import {
  chunk,
  enqueueFeedIds,
  FEED_REACTIVATION_RESET,
  feeds,
  folders,
  getDb,
  insertChunkSize,
  whereInChunkSize,
} from "@boreas/shared";
import { inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";

const importSchema = z.object({ opml: z.string().min(1) });

// Tailles de lot des écritures groupées, dérivées des limites D1 centralisées
// (`@boreas/shared`), en tenant compte du nombre de colonnes/paramètres par ligne.
// INSERT feeds : 4 colonnes par ligne (id, url, title, folder_id).
const FEED_INSERT_CHUNK = insertChunkSize(4);
// INSERT folders : 2 colonnes par ligne (id, name).
const FOLDER_INSERT_CHUNK = insertChunkSize(2);
// UPDATE … WHERE id IN (…) : ~16 paramètres réservés au `set`, le reste pour les ids.
const FEED_UPDATE_CHUNK = whereInChunkSize(16);

/**
 * Routes OPML (montées sur /api/opml), sous le middleware de session. Permettent
 * la **migration en masse** depuis/vers un autre lecteur (#17) :
 *   - import : crée/réactive Folders et Feeds, fan-out le backfill via la Queue
 *     d'ingestion (ADR 0002), comme le refresh global ;
 *   - export : sérialise Feeds + Folders en OPML 2.0.
 */
export const opmlRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/opml/import — importe un OPML (corps JSON `{ opml }`, le SPA lit le
 * fichier côté client). Pour chaque flux : un abonnement **actif** est ignoré, un
 * Feed **désabonné** (#14) est réactivé (resets partagés avec `feeds.ts`, mais
 * sans ingestion synchrone), un flux inconnu est créé. Le backfill de tous les
 * Feeds touchés est déféré à la Queue (fan-out, ADR 0002).
 *
 * Les lectures/écritures se font **en lot** plutôt qu'un aller-retour D1 par flux
 * (un export Feedly/Inoreader contient couramment des centaines de flux) : un
 * SELECT des Folders existants, un SELECT des Feeds existants, puis inserts et
 * updates groupés. Les inserts sont `onConflictDoNothing` : si un flux a été créé
 * entre le SELECT et l'INSERT (import concurrent, abonnement simultané), la
 * contrainte `feeds.url` UNIQUE ne fait pas planter tout l'import — la ligne est
 * simplement ignorée et non re-enqueuée (on n'enqueue que les lignes réellement
 * insérées via `returning`).
 */
opmlRoutes.post("/import", async (c) => {
  const parsed = importSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const { feeds: entries } = parseOpml(parsed.data.opml);
  const db = getDb(c.env.DB);

  if (entries.length === 0) {
    return c.json({
      imported: 0,
      reactivated: 0,
      skipped: 0,
      foldersCreated: 0,
    });
  }

  // 1. Résolution des Folders en lot : réutilise les homonymes existants
  // (`folders.name` n'est pas unique → on prend le premier), crée les manquants.
  const folderNames = [
    ...new Set(
      entries
        .map((e) => e.folderName)
        .filter((name): name is string => name !== null),
    ),
  ];
  const folderIdByName = new Map<string, string>();
  let foldersCreated = 0;
  if (folderNames.length > 0) {
    const existing = await db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .where(inArray(folders.name, folderNames));
    for (const f of existing) {
      if (!folderIdByName.has(f.name)) folderIdByName.set(f.name, f.id);
    }
    const missing = folderNames.filter((name) => !folderIdByName.has(name));
    const newFolders = missing.map((name) => ({
      id: crypto.randomUUID(),
      name,
    }));
    for (const group of chunk(newFolders, FOLDER_INSERT_CHUNK)) {
      await db.insert(folders).values(group);
    }
    for (const f of newFolders) folderIdByName.set(f.name, f.id);
    foldersCreated = newFolders.length;
  }

  // 2. Charge les Feeds déjà connus (par URL) en une requête.
  const existingByUrl = new Map<
    string,
    { id: string; unsubscribedAt: string | null }
  >();
  for (const group of chunk(
    entries.map((e) => e.url),
    whereInChunkSize(1),
  )) {
    const rows = await db
      .select({
        id: feeds.id,
        url: feeds.url,
        unsubscribedAt: feeds.unsubscribed_at,
      })
      .from(feeds)
      .where(inArray(feeds.url, group));
    for (const r of rows) {
      existingByUrl.set(r.url, { id: r.id, unsubscribedAt: r.unsubscribedAt });
    }
  }

  // 3. Classe chaque entrée : ignorée (active), à réactiver (désabonnée), ou à
  // créer (inconnue). `parseOpml` a déjà dédupliqué par URL.
  const toInsert: {
    id: string;
    url: string;
    title: string | null;
    folder_id: string | null;
  }[] = [];
  // Réactivations regroupées par Folder cible : `null` = ne pas toucher au
  // rattachement existant (l'OPML ne range pas ce flux), une valeur = (ré)assigner.
  const reactivateByFolder = new Map<string | null, string[]>();
  let skipped = 0;

  for (const entry of entries) {
    const folderId = entry.folderName
      ? (folderIdByName.get(entry.folderName) ?? null)
      : null;
    const existing = existingByUrl.get(entry.url);

    if (existing) {
      if (existing.unsubscribedAt === null) {
        skipped += 1;
        continue;
      }
      const group = reactivateByFolder.get(folderId) ?? [];
      group.push(existing.id);
      reactivateByFolder.set(folderId, group);
      continue;
    }

    toInsert.push({
      id: crypto.randomUUID(),
      url: entry.url,
      title: entry.title,
      folder_id: folderId,
    });
  }

  const toBackfill: string[] = [];

  // 4a. Inserts groupés et idempotents : on n'enqueue que les lignes réellement
  // insérées (un conflit d'URL concurrent est ignoré, pas re-backfillé).
  let imported = 0;
  for (const group of chunk(toInsert, FEED_INSERT_CHUNK)) {
    const inserted = await db
      .insert(feeds)
      .values(group)
      .onConflictDoNothing()
      .returning({ id: feeds.id });
    for (const r of inserted) toBackfill.push(r.id);
    imported += inserted.length;
  }

  // 4b. Réactivations groupées par Folder cible. Le reset de santé/polling est
  // partagé avec le ré-abonnement (`FEED_REACTIVATION_RESET`) ; `folder_id` n'est
  // (ré)assigné que si l'OPML range le flux, pour ne pas désassigner sans raison.
  let reactivated = 0;
  for (const [folderId, ids] of reactivateByFolder) {
    const set = folderId
      ? { ...FEED_REACTIVATION_RESET, folder_id: folderId }
      : FEED_REACTIVATION_RESET;
    for (const group of chunk(ids, FEED_UPDATE_CHUNK)) {
      await db.update(feeds).set(set).where(inArray(feeds.id, group));
    }
    toBackfill.push(...ids);
    reactivated += ids.length;
  }

  await enqueueFeedIds(c.env.INGESTION_QUEUE, toBackfill);

  return c.json({ imported, reactivated, skipped, foldersCreated });
});

/**
 * GET /api/opml/export — sérialise les Feeds **actifs** et leurs Folders en OPML
 * 2.0. Les Feeds désabonnés (#14) sont exclus, comme dans la sidebar. Le
 * `Content-Disposition` impose un nom de fichier daté.
 */
opmlRoutes.get("/export", async (c) => {
  const db = getDb(c.env.DB);

  const feedRows = await db
    .select({
      url: feeds.url,
      title: feeds.title,
      folderId: feeds.folder_id,
    })
    .from(feeds)
    .where(isNull(feeds.unsubscribed_at));

  const folderRows = await db
    .select({ id: folders.id, name: folders.name })
    .from(folders);

  const xml = buildOpml(feedRows, folderRows);
  const date = new Date().toISOString().slice(0, 10);

  return c.body(xml, 200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Disposition": `attachment; filename="boreas-feeds-${date}.opml"`,
  });
});
