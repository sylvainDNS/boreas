import {
  type OpmlImportResponse,
  opmlImportSchema,
} from "@boreas/api-contracts";
import { buildOpml, parseOpml } from "@boreas/opml";
import {
  chunk,
  enqueueFeedIds,
  feeds,
  folders,
  getDb,
  insertChunkSize,
  lastFeedRankInContainer,
  ranksAfter,
  resubscribeFeeds,
  whereInChunkSize,
} from "@boreas/shared";
import { desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";

// Tailles de lot des écritures groupées, dérivées des limites D1 centralisées
// (`@boreas/shared`), en tenant compte du nombre de **paramètres liés** par ligne
// — pas du nombre de colonnes qu'on renseigne explicitement.
// INSERT feeds : 7 paramètres par ligne. On fournit 5 valeurs (id, url, title,
// folder_id, rank — #110), et Drizzle ajoute deux paramètres liés pour les défauts
// JS injectés à l'INSERT : `consecutive_failures` (.default(0)) et `updated_at`
// ($defaultFn, #69). (`created_at`, lui, a un défaut `sql\`…\`` rendu inline, donc
// sans paramètre.) Sous-estimer ce compte fait dépasser la limite SQLite de 100
// variables → « too many SQL variables » sur un import volumineux.
const FEED_INSERT_CHUNK = insertChunkSize(7);
// INSERT folders : 4 paramètres par ligne (id, name, rank + le `$defaultFn`
// d'`updated_at` lié à l'INSERT, #69). `rank` (#108) est désormais fourni
// explicitement à chaque ligne.
const FOLDER_INSERT_CHUNK = insertChunkSize(4);

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
 * Feed **désabonné** (#14) fait l'objet d'un **Resubscribe** (module partagé
 * `resubscribeFeeds`, mais sans ingestion synchrone — déférée à la Queue), un
 * flux inconnu est créé. Le backfill de tous les
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
  const parsed = opmlImportSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
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
    } satisfies OpmlImportResponse);
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
    // Rangs (#108, ADR 0020) : les Folders importés sont placés en **fin de liste**,
    // après le dernier rang existant, dans l'ordre d'apparition dans l'OPML.
    const [lastFolder] = await db
      .select({ rank: folders.rank })
      .from(folders)
      .orderBy(desc(folders.rank))
      .limit(1);
    // `ranksAfter` renvoie exactement `missing.length` clés ; on les apparie aux
    // noms par `zip` pour que chaque ligne porte une `rank: string` non nullable
    // (une colonne NOT NULL) sans cast masquant un `undefined`.
    const newRanks = ranksAfter(lastFolder?.rank ?? null, missing.length);
    const newFolders = missing.map((name, i) => {
      const rank = newRanks[i];
      if (rank === undefined)
        throw new Error("rank manquant pour un Folder OPML");
      return { id: crypto.randomUUID(), name, rank };
    });
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

  // 3. Classe chaque entrée : ignorée (active), à réabonner (désabonnée), ou à
  // créer (inconnue). `parseOpml` a déjà dédupliqué par URL.
  // Spécifications d'insertion **avant** attribution du rang : le rang est scopé
  // au conteneur (ADR 0020), on le calcule en lot par conteneur cible plus bas.
  const toInsertSpecs: {
    id: string;
    url: string;
    title: string | null;
    folder_id: string | null;
  }[] = [];
  // Resubscribe regroupés par Folder cible : `null` = ne pas toucher au
  // rattachement existant (l'OPML ne range pas ce flux), une valeur = (ré)assigner.
  const resubscribeByFolder = new Map<string | null, string[]>();
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
      const group = resubscribeByFolder.get(folderId) ?? [];
      group.push(existing.id);
      resubscribeByFolder.set(folderId, group);
      continue;
    }

    toInsertSpecs.push({
      id: crypto.randomUUID(),
      url: entry.url,
      title: entry.title,
      folder_id: folderId,
    });
  }

  // Rangs (#110, ADR 0020) scopés **par conteneur** : chaque Feed importé est placé
  // en fin de SON conteneur cible (Folder ou zone sans-dossier), dans l'ordre
  // d'apparition dans l'OPML. On regroupe les specs par conteneur, on lit une fois
  // le dernier rang du conteneur, puis `ranksAfter` produit autant de clés que de
  // feeds à y ajouter — appariées par `zip` pour une `rank: string` non nullable.
  const specsByContainer = new Map<string | null, typeof toInsertSpecs>();
  for (const spec of toInsertSpecs) {
    const group = specsByContainer.get(spec.folder_id) ?? [];
    group.push(spec);
    specsByContainer.set(spec.folder_id, group);
  }
  const toInsert: ((typeof toInsertSpecs)[number] & { rank: string })[] = [];
  for (const [containerId, specs] of specsByContainer) {
    const lastRank = await lastFeedRankInContainer(db, containerId);
    const ranks = ranksAfter(lastRank, specs.length);
    specs.forEach((spec, i) => {
      const rank = ranks[i];
      if (rank === undefined)
        throw new Error("rank manquant pour un Feed OPML");
      toInsert.push({ ...spec, rank });
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

  // 4b. Resubscribe groupés par Folder cible. Le reset de santé/polling est
  // possédé par le module partagé (`resubscribeFeeds`, #42) ; on appelle une fois
  // par groupe sans les fusionner — `folder_id` n'est (ré)assigné que si l'OPML
  // range le flux (clé non-null), pour ne pas désassigner sans raison.
  let reactivated = 0;
  for (const [folderId, ids] of resubscribeByFolder) {
    // Quand l'OPML (ré)assigne le Feed à un Folder (`folderId` non-null), il
    // change de conteneur : son rang historique, scopé à l'ancien conteneur,
    // n'a plus de sens (ADR 0020, #110). On réattribue des rangs distincts en
    // fin du conteneur cible — par Feed (et non en lot) pour éviter une collision
    // entre les Feeds du même groupe. On lit le dernier rang du conteneur cible
    // **avant** `resubscribeFeeds` (qui y déplace les Feeds) pour que les Feeds en
    // cours de déplacement, encore porteurs de leur ancien rang, ne le faussent pas.
    const ranks = folderId
      ? ranksAfter(await lastFeedRankInContainer(db, folderId), ids.length)
      : null;
    await resubscribeFeeds(db, ids, folderId ? { folderId } : undefined);
    if (ranks) {
      for (const [i, id] of ids.entries()) {
        const rank = ranks[i];
        if (rank === undefined)
          throw new Error("rank manquant pour un Feed OPML réabonné");
        await db.update(feeds).set({ rank }).where(eq(feeds.id, id));
      }
    }
    toBackfill.push(...ids);
    reactivated += ids.length;
  }

  await enqueueFeedIds(c.env.INGESTION_QUEUE, toBackfill);

  return c.json({
    imported,
    reactivated,
    skipped,
    foldersCreated,
  } satisfies OpmlImportResponse);
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
