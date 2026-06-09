import {
  articles,
  buildConditionalHeaders,
  type Db,
  type DiscoveredFeed,
  discoverFeeds,
  ERROR_THRESHOLD,
  feeds,
  fetchFeed,
  folders,
  getDb,
  ingestFeed,
} from "@boreas/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";

const subscribeSchema = z.object({ url: z.string().url() });

/**
 * Issue d'une tentative d'abonnement à une URL de flux : succès (Feed créé +
 * backfill) ou code d'erreur. Partagée par le chemin direct et le candidat
 * unique de l'auto-découverte (#12).
 */
type SubscribeOutcome =
  | {
      ok: true;
      feed: { id: string; url: string; title: string | null };
      articleCount: number;
    }
  | {
      ok: false;
      error: "already_subscribed" | "invalid_feed" | "fetch_failed";
    };

/**
 * Abonnement à une **URL de flux** : refuse les doublons, crée le Feed, délègue
 * le backfill à `ingestFeed`, et rollback si le flux est injoignable ou vide.
 * Extrait de l'ancien corps de `POST /feeds` (#6) pour être réutilisé par
 * l'auto-découverte (#12) sans dupliquer la logique ni le rollback.
 */
async function subscribeToFeedUrl(
  url: string,
  db: Db,
  env: Env,
): Promise<SubscribeOutcome> {
  // Dédup d'abonnement : un Feed déjà suivi est refusé.
  const [existing] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(eq(feeds.url, url))
    .limit(1);
  if (existing) {
    return { ok: false, error: "already_subscribed" };
  }

  // Crée le Feed puis backfill ses articles via le module d'ingestion partagé.
  const feedId = crypto.randomUUID();
  await db.insert(feeds).values({ id: feedId, url });

  // ingestFeed ne lève pas sur un fetch KO (il renvoie status:"error"), mais une
  // panne D1/R2 en cours d'insertion peut remonter : on la traite comme un échec
  // d'abonnement plutôt que de laisser une 500 + un Feed orphelin.
  let result: Awaited<ReturnType<typeof ingestFeed>> | null = null;
  try {
    result = await ingestFeed(feedId, db, env.BUCKET, env.HMAC_SECRET);
  } catch (err) {
    console.error("[feeds] ingestion levée à l'abonnement", feedId, err);
  }

  if (!result || result.status === "error" || result.itemCount === 0) {
    // Rollback de l'abonnement. On supprime d'abord les articles éventuellement
    // insérés avant l'erreur : la FK `articles.feed_id` est en ON DELETE no
    // action, donc supprimer le Feed seul échouerait s'il en reste.
    await db.delete(articles).where(eq(articles.feed_id, feedId));
    await db.delete(feeds).where(eq(feeds.id, feedId));
    // Flux joignable et parsé mais sans item = illisible (invalid_feed) ; tout
    // échec de fetch/parse (status "error", ou exception) = fetch KO.
    return {
      ok: false,
      error:
        result && result.status !== "error" && result.itemCount === 0
          ? "invalid_feed"
          : "fetch_failed",
    };
  }

  return {
    ok: true,
    feed: { id: feedId, url, title: result.title },
    articleCount: result.inserted,
  };
}

/**
 * Récupère le HTML d'une URL de site et en extrait les flux candidats (#12).
 * Réutilise `fetchFeed` (mêmes garde-fous redirections/timeout/taille que
 * l'ingestion). Renvoie `null` si la page est injoignable (→ 502) ; un tableau
 * (possiblement vide) sinon. Le HTML est décodé selon le charset annoncé, avec
 * repli UTF-8 — les attributs des `<link>` découverts sont de toute façon ASCII.
 */
async function discoverFromUrl(url: string): Promise<DiscoveredFeed[] | null> {
  let bytes: Uint8Array;
  let finalUrl = url;
  let charset: string | undefined;
  try {
    const result = await fetchFeed(url, buildConditionalHeaders(null, null));
    if (!result.response.ok || !result.bytes) return null;
    bytes = result.bytes;
    charset = charsetFromContentType(
      result.response.headers.get("content-type"),
    );
    // L'URL finale (après redirections permanentes) sert de base de résolution
    // des href relatifs.
    finalUrl = result.permanentUrl ?? url;
  } catch (err) {
    console.error("[feeds] fetch de découverte échoué", url, err);
    return null;
  }

  return discoverFeeds(decodeHtml(bytes, charset), finalUrl);
}

/** Extrait le `charset=` d'un en-tête Content-Type, sinon `undefined`. */
function charsetFromContentType(
  contentType: string | null,
): string | undefined {
  return contentType?.match(/charset=([^;]+)/i)?.[1]?.trim();
}

/** Décode des octets HTML en chaîne ; repli UTF-8 si le charset est inconnu. */
function decodeHtml(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Routes Feed (montées sur /api/feeds), sous le middleware de session.
 *
 * L'abonnement (#6) et le refresh manuel passent par le même module `ingestion`
 * partagé (`ingestFeed`, ADR 0002) que le consommateur de Queue du Cron (#10).
 */
export const feedsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Liste des Feeds avec leur santé (#11) : la sidebar du SPA y lit le badge
 * « en erreur ». `status` est **dérivé** de `consecutive_failures`
 * (≥ `ERROR_THRESHOLD` = en erreur) plutôt que stocké, pour éviter une donnée
 * redondante. Trié par titre (puis URL) pour un ordre stable.
 */
feedsRoutes.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: feeds.id,
      url: feeds.url,
      title: feeds.title,
      consecutiveFailures: feeds.consecutive_failures,
      lastError: feeds.last_error,
      lastCheckAt: feeds.last_check_at,
      folderId: feeds.folder_id,
    })
    .from(feeds)
    .orderBy(asc(feeds.title), asc(feeds.url));

  return c.json({
    feeds: rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      status: row.consecutiveFailures >= ERROR_THRESHOLD ? "error" : "ok",
      lastError: row.lastError,
      lastCheckAt: row.lastCheckAt,
      // Folder de rattachement (null = non classé). La sidebar (#13) regroupe.
      folderId: row.folderId,
    })),
  });
});

// Codes d'échec d'abonnement → statut HTTP.
const SUBSCRIBE_ERROR_STATUS = {
  already_subscribed: 409,
  invalid_feed: 422,
  fetch_failed: 502,
} as const;

/**
 * Abonnement par **URL de flux** ou **URL de site** (auto-découverte, #12).
 *
 * On tente d'abord un abonnement direct (chemin #6, inchangé) : si l'URL est un
 * flux, c'est réglé. Sinon (page HTML, flux illisible) on **bascule en
 * découverte** : on récupère le HTML et on lit ses `<link rel="alternate">`.
 *   - 1 candidat → abonnement direct au flux trouvé ;
 *   - N candidats → on renvoie la liste pour le sélecteur du SPA (aucun Feed créé) ;
 *   - 0 candidat → on renvoie l'erreur d'origine de l'abonnement direct.
 *
 * Conséquence assumée : une URL de site provoque un fetch d'ingestion (qui
 * échoue → rollback) **puis** un fetch de découverte. Le surcoût (action
 * interactive, rare) est le prix de garder le chemin flux-direct #6 intact.
 */
feedsRoutes.post("/", async (c) => {
  const parsed = subscribeSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const url = parsed.data.url.trim();
  const db = getDb(c.env.DB);

  // 1. Tentative d'abonnement direct (URL de flux).
  const direct = await subscribeToFeedUrl(url, db, c.env);
  if (direct.ok) {
    return c.json(
      { feed: direct.feed, articleCount: direct.articleCount },
      201,
    );
  }
  // Un doublon est définitif : inutile de découvrir.
  if (direct.error === "already_subscribed") {
    return c.json({ error: "already_subscribed" }, 409);
  }

  // 2. Fallback : l'URL n'est pas un flux exploitable → auto-découverte.
  const candidates = await discoverFromUrl(url);
  // Page injoignable : on remonte l'erreur d'origine de l'abonnement direct.
  if (!candidates) {
    return c.json(
      { error: direct.error },
      SUBSCRIBE_ERROR_STATUS[direct.error],
    );
  }
  // Page lue mais aucun flux annoncé.
  if (candidates.length === 0) {
    return c.json({ error: "no_feed_found" }, 422);
  }

  // 3. Un seul candidat → abonnement direct ; plusieurs → sélection côté SPA.
  if (candidates.length === 1 && candidates[0]) {
    const sub = await subscribeToFeedUrl(candidates[0].url, db, c.env);
    if (sub.ok) {
      return c.json({ feed: sub.feed, articleCount: sub.articleCount }, 201);
    }
    return c.json({ error: sub.error }, SUBSCRIBE_ERROR_STATUS[sub.error]);
  }

  return c.json({ candidates }, 200);
});

/**
 * Auto-découverte sans abonnement (#12) : renvoie les flux candidats annoncés
 * par une URL de site. Liste possiblement vide ; 502 si la page est injoignable.
 */
feedsRoutes.post("/discover", async (c) => {
  const parsed = subscribeSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const candidates = await discoverFromUrl(parsed.data.url.trim());
  if (!candidates) {
    return c.json({ error: "fetch_failed" }, 502);
  }
  return c.json({ candidates });
});

/**
 * Refresh manuel d'un Feed (fetch serveur immédiat) : rejoue l'ingestion et
 * renvoie le nombre de nouveaux articles. 404 si le Feed est inconnu.
 */
feedsRoutes.post("/:id/refresh", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  const [feed] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(eq(feeds.id, id))
    .limit(1);
  if (!feed) {
    return c.json({ error: "not_found" }, 404);
  }

  const result = await ingestFeed(id, db, c.env.BUCKET, c.env.HMAC_SECRET);
  return c.json({ inserted: result.inserted, status: result.status });
});

// Renommage et/ou déplacement de Feed : `title` non vide pour renommer ;
// `folderId` (uuid) pour assigner un Folder, `null` pour désassigner. Au moins
// un champ requis (`.refine`) — sinon le PATCH n'aurait rien à faire.
const updateFeedSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    folderId: z.string().min(1).nullable().optional(),
  })
  .refine((d) => d.title !== undefined || d.folderId !== undefined, {
    message: "no_field",
  });

/**
 * Renomme un Feed et/ou le déplace entre Folders (US 12, #13). `folderId: null`
 * désassigne (le Feed repasse « non classé »). Un `folderId` fourni doit
 * désigner un Folder existant (sinon 422 `folder_not_found`) — la FK D1
 * l'imposerait aussi, mais on renvoie une erreur métier plutôt qu'une 500.
 * La réponse n'écho que les champs effectivement modifiés.
 */
feedsRoutes.patch("/:id", async (c) => {
  const parsed = updateFeedSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  // Valide la cible du déplacement avant d'écrire (folderId non-null seulement).
  if (parsed.data.folderId) {
    const [folder] = await db
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.id, parsed.data.folderId))
      .limit(1);
    if (!folder) {
      return c.json({ error: "folder_not_found" }, 422);
    }
  }

  // `parsed.data` ne porte que les champs fournis : on mappe `folderId` (API)
  // vers la colonne `folder_id` et on n'écrit que ce qui est présent.
  const set: { title?: string; folder_id?: string | null } = {};
  if (parsed.data.title !== undefined) set.title = parsed.data.title;
  if (parsed.data.folderId !== undefined) set.folder_id = parsed.data.folderId;

  const updated = await db
    .update(feeds)
    .set(set)
    .where(eq(feeds.id, id))
    .returning({ id: feeds.id });

  if (updated.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ id, ...parsed.data });
});
