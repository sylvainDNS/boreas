import {
  type DiscoverResponse,
  type FeedRefreshResponse,
  type FeedsResponse,
  type FeedUnsubscribedResponse,
  type FeedUpdatedResponse,
  type OkResponse,
  type SubscribeCandidatesResponse,
  type SubscribeErrorCode,
  type SubscribeSubscribedResponse,
  subscribeSchema,
  updateFeedSchema,
} from "@boreas/api-contracts";
import {
  articles,
  buildConditionalHeaders,
  type Db,
  type DiscoveredFeed,
  deleteArticlesAndContent,
  discoverFeeds,
  ERROR_THRESHOLD,
  feeds,
  fetchFeed,
  folders,
  getDb,
  ingestFeed,
  lastFeedRankInContainer,
  nowEpochMs,
  rankBetween,
  resubscribeFeed,
  sqlUtcNow,
  writeTombstones,
} from "@boreas/shared";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../env";

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
      error: SubscribeErrorCode;
    };

/**
 * Abonnement à une **URL de flux** : refuse les doublons, crée le Feed, délègue
 * le backfill à `ingestFeed`, et rollback si le flux est injoignable ou vide.
 * Extrait de l'ancien corps de `POST /feeds` (#6) pour être réutilisé par
 * l'auto-découverte (#12) sans dupliquer la logique ni le rollback.
 *
 * `folderId` (#117) cible le **conteneur** d'accueil : non-null → le Feed naît
 * (ou se réabonne) dans ce Folder, avec un rang en **fin de ce conteneur** ;
 * `null` → zone « sans dossier » à la création, et au réabonnement le dossier
 * existant est **conservé** (pas de désassignation). L'appelant a déjà validé
 * l'existence du Folder.
 */
async function subscribeToFeedUrl(
  url: string,
  db: Db,
  env: Env,
  folderId: string | null = null,
): Promise<SubscribeOutcome> {
  // Dédup d'abonnement. Un Feed déjà **actif** est refusé (doublon). Un Feed
  // **désabonné** (#14, ADR 0010) est **Resubscribe** plutôt que refusé : se
  // réabonner est réversible, on relance son polling en conservant ses Saved.
  const [existing] = await db
    .select({ id: feeds.id, unsubscribedAt: feeds.unsubscribed_at })
    .from(feeds)
    .where(eq(feeds.url, url))
    .limit(1);
  if (existing) {
    if (existing.unsubscribedAt === null) {
      return { ok: false, error: "already_subscribed" };
    }
    return resubscribeAndBackfill(existing.id, url, db, env, folderId);
  }

  // Crée le Feed puis backfill ses articles via le module d'ingestion partagé.
  const feedId = crypto.randomUUID();
  // Rang scopé au conteneur (ADR 0020) : on place le nouvel abonné en **fin du
  // conteneur cible** — la zone « sans dossier » (`folderId` null) par défaut,
  // ou le Folder demandé (#117). Les Feeds des autres conteneurs ne bornent pas
  // ce rang.
  const rank = rankBetween(await lastFeedRankInContainer(db, folderId), null);
  await db.insert(feeds).values({ id: feedId, url, rank, folder_id: folderId });

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
 * Resubscribe d'un Feed désabonné (#14, #42, ADR 0010) : `resubscribeFeed`
 * efface `unsubscribed_at` et réinitialise polling/santé (l'invariant vit dans
 * `@boreas/shared`), puis on rejoue l'ingestion **synchrone** pour re-backfiller.
 * Contrairement à l'abonnement initial, **aucun rollback** si l'ingestion
 * échoue : la ligne Feed et ses Articles Saved préexistent et doivent survivre —
 * un fetch KO laissera simplement le Feed réabonné en statut « en erreur ».
 *
 * `folderId` (#117) : non-null → le Feed est **réassigné** à ce Folder et rangé
 * en **fin du conteneur cible** (Option A, #110) dans le même UPDATE atomique
 * que la réactivation ; `null` → son dossier existant est **conservé** (pas de
 * désassignation au réabonnement).
 */
async function resubscribeAndBackfill(
  feedId: string,
  url: string,
  db: Db,
  env: Env,
  folderId: string | null = null,
): Promise<SubscribeOutcome> {
  // Réassignation au conteneur cible uniquement si un Folder est demandé : on
  // calcule alors le rang de fin de ce conteneur pour un UPDATE atomique
  // folder+rang. Sans folderId, on ne touche ni le dossier ni le rang.
  const resubscribeOpts =
    folderId !== null
      ? {
          folderId,
          rank: rankBetween(await lastFeedRankInContainer(db, folderId), null),
        }
      : {};
  await resubscribeFeed(db, feedId, resubscribeOpts);

  let result: Awaited<ReturnType<typeof ingestFeed>> | null = null;
  try {
    result = await ingestFeed(feedId, db, env.BUCKET, env.HMAC_SECRET);
  } catch (err) {
    console.error("[feeds] ingestion levée au réabonnement", feedId, err);
  }

  return {
    ok: true,
    feed: { id: feedId, url, title: result?.title ?? null },
    articleCount: result?.inserted ?? 0,
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

/**
 * Existence d'un Folder par id (#117) : un seul endroit pour la garde métier
 * partagée par l'abonnement (`POST /`) et le déplacement (`PATCH /:id`), qui
 * renvoient tous deux 422 `folder_not_found` avant d'écrire — la FK D1
 * l'imposerait aussi, mais on préfère une erreur métier à une 500. Centraliser
 * évite que les deux routes divergent sur « ce qu'est un Folder existant ».
 */
async function folderExists(db: Db, folderId: string): Promise<boolean> {
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.id, folderId))
    .limit(1);
  return folder !== undefined;
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
 * redondante. Trié par conteneur puis par rang manuel (ADR 0020) : la sidebar
 * regroupe par Folder et respecte l'ordre choisi au sein de chacun.
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
      rank: feeds.rank,
    })
    .from(feeds)
    // Les Feeds désabonnés (#14) sont masqués de la sidebar.
    .where(isNull(feeds.unsubscribed_at))
    // Tri par conteneur (`folder_id`) puis par rang manuel au sein du conteneur
    // (ADR 0020), `id` en départage pour un ordre **total déterministe** même si
    // deux Feeds d'un même conteneur partageaient un rang (rééquilibrage en cours,
    // conflit multi-appareils ADR 0018, ou backfill historique non couvert).
    .orderBy(asc(feeds.folder_id), asc(feeds.rank), asc(feeds.id));

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
      // Rang manuel au sein du conteneur (ADR 0020).
      rank: row.rank,
    })),
  } satisfies FeedsResponse);
});

// Codes d'échec d'abonnement → statut HTTP. `satisfies Record<SubscribeErrorCode>`
// lie cette table à l'enum du contrat : ajouter un code d'erreur sans son statut
// (ou inversement) casse au typecheck.
const SUBSCRIBE_ERROR_STATUS = {
  already_subscribed: 409,
  invalid_feed: 422,
  fetch_failed: 502,
  // Folder cible inexistant (abonnement dans un dossier, #117).
  folder_not_found: 422,
} as const satisfies Record<SubscribeErrorCode, number>;

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

  // Conteneur d'accueil (#117) : `null` explicite == absent == « sans dossier ».
  const folderId = parsed.data.folderId ?? null;

  // On valide l'existence du Folder cible AVANT tout abonnement/découverte : ni
  // Feed créé ni fetch sortant si le conteneur n'existe pas.
  if (folderId !== null && !(await folderExists(db, folderId))) {
    return c.json({ error: "folder_not_found" }, 422);
  }

  // 1. Tentative d'abonnement direct (URL de flux).
  const direct = await subscribeToFeedUrl(url, db, c.env, folderId);
  if (direct.ok) {
    return c.json(
      {
        feed: direct.feed,
        articleCount: direct.articleCount,
      } satisfies SubscribeSubscribedResponse,
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
    // Le candidat unique atterrit dans le conteneur cible (#117) comme un
    // abonnement direct. Le cas multi-candidats ne crée rien : `folderId` y est
    // sans objet (le SPA rappellera POST avec le flux choisi + son folderId).
    const sub = await subscribeToFeedUrl(
      candidates[0].url,
      db,
      c.env,
      folderId,
    );
    if (sub.ok) {
      return c.json(
        {
          feed: sub.feed,
          articleCount: sub.articleCount,
        } satisfies SubscribeSubscribedResponse,
        201,
      );
    }
    return c.json({ error: sub.error }, SUBSCRIBE_ERROR_STATUS[sub.error]);
  }

  return c.json({ candidates } satisfies SubscribeCandidatesResponse, 200);
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
  return c.json({ candidates } satisfies DiscoverResponse);
});

/**
 * Refresh manuel d'un Feed (fetch serveur immédiat) : rejoue l'ingestion et
 * renvoie le nombre de nouveaux articles. 404 si le Feed est inconnu.
 */
feedsRoutes.post("/:id/refresh", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  // Un Feed désabonné (#14) est masqué et son polling arrêté : on refuse le
  // refresh manuel (404) plutôt que de le ré-ingérer et ressusciter ses articles.
  const [feed] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.id, id), isNull(feeds.unsubscribed_at)))
    .limit(1);
  if (!feed) {
    return c.json({ error: "not_found" }, 404);
  }

  const result = await ingestFeed(id, db, c.env.BUCKET, c.env.HMAC_SECRET);
  return c.json({
    inserted: result.inserted,
    status: result.status,
  } satisfies FeedRefreshResponse);
});

/**
 * Renomme un Feed et/ou le déplace entre Folders (US 12, #13). `folderId: null`
 * désassigne (le Feed repasse « non classé »). Un `folderId` fourni doit
 * désigner un Folder existant (sinon 422 `folder_not_found`) — la FK D1
 * l'imposerait aussi, mais on renvoie une erreur métier plutôt qu'une 500.
 * La réponse n'écho que les champs effectivement modifiés.
 *
 * Le rang étant scopé au conteneur (ADR 0020), un **déplacement** (changement
 * effectif de `folder_id`) réattribue un rang en **fin du conteneur cible**
 * (Option A, #110) : le rang d'origine n'a plus de sens dans un autre conteneur.
 * La pose à une position précise viendra avec le drag-and-drop (#112). Un
 * renommage seul, ou un `folderId` identique au conteneur courant, ne touche pas
 * le rang.
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
  if (parsed.data.folderId && !(await folderExists(db, parsed.data.folderId))) {
    return c.json({ error: "folder_not_found" }, 422);
  }

  // `parsed.data` ne porte que les champs fournis : on mappe `folderId` (API)
  // vers la colonne `folder_id` et on n'écrit que ce qui est présent. Renommage
  // et déplacement sont des mutations de domaine → bump `updated_at` (#69).
  const set: {
    title?: string;
    folder_id?: string | null;
    rank?: string;
    updated_at: number;
  } = { updated_at: nowEpochMs() };
  if (parsed.data.title !== undefined) set.title = parsed.data.title;

  // Déplacement de conteneur : on réattribue un rang en fin du conteneur cible
  // (ADR 0020, Option A) — mais seulement si le conteneur change réellement, pour
  // ne pas re-ranker un `folderId` identique au courant. On lit le `folder_id`
  // courant (qui sert aussi de signal d'existence : 404 sinon).
  if (parsed.data.folderId !== undefined) {
    const [current] = await db
      .select({ folderId: feeds.folder_id })
      .from(feeds)
      .where(eq(feeds.id, id))
      .limit(1);
    if (!current) {
      return c.json({ error: "not_found" }, 404);
    }
    set.folder_id = parsed.data.folderId;
    if (current.folderId !== parsed.data.folderId) {
      // Réattribution en fin du conteneur cible (Folder ou zone sans-dossier).
      const lastRank = await lastFeedRankInContainer(db, parsed.data.folderId);
      set.rank = rankBetween(lastRank, null);
    }
  }

  // Réordonnancement intra-conteneur (#111) : un `rank` explicite est écrit
  // **verbatim** et, posé **après** la branche `folderId`, **écrase** toute
  // réattribution auto de fin de conteneur (#110). Le client (`rankBetween` des
  // voisins, ADR 0020) connaît la position voulue ; le serveur ne recalcule pas.
  // Préfigure le drop inter-conteneur à position précise (#112) : `{folderId,
  // rank}` déplace ET positionne en un seul PATCH.
  if (parsed.data.rank !== undefined) set.rank = parsed.data.rank;

  const updated = await db
    .update(feeds)
    .set(set)
    .where(eq(feeds.id, id))
    .returning({ id: feeds.id });

  if (updated.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ id, ...parsed.data } satisfies FeedUpdatedResponse);
});

/**
 * Désabonnement (#14, ADR 0010) — action **non destructive** : marque le Feed
 * `unsubscribed_at` (il sort du Cron, de la sidebar et des vues non-lus), purge
 * ses Articles **non-Saved** et leurs objets R2, mais **conserve les Saved** et
 * la ligne Feed (contexte des Saved). Réversible via un ré-abonnement. 404 si le
 * Feed est inconnu ou déjà désabonné.
 */
feedsRoutes.post("/:id/unsubscribe", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  // Le désabonnement est une mutation de domaine (le Feed change d'état) qui
  // bumpe `updated_at` (#69, ADR 0018) : le Feed « descend » au delta sync via
  // ce bump et NON via un tombstone — il garde sa ligne (contexte des Saved).
  const updated = await db
    .update(feeds)
    .set({ unsubscribed_at: sqlUtcNow(), updated_at: nowEpochMs() })
    .where(and(eq(feeds.id, id), isNull(feeds.unsubscribed_at)))
    .returning({ id: feeds.id });
  if (updated.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }

  // Purge les Articles non-Saved du Feed + leurs objets R2 ; les Saved restent.
  await deleteArticlesAndContent(
    db,
    c.env.BUCKET,
    and(eq(articles.feed_id, id), eq(articles.saved, false)) as SQL,
  );

  return c.json({ id, unsubscribed: true } satisfies FeedUnsubscribedResponse);
});

/**
 * Suppression (#14, ADR 0010) — action **destructive** (confirmée côté SPA) :
 * efface le Feed, **tous** ses Articles (Saved compris) et leurs objets R2.
 * On supprime d'abord les Articles (FK `articles.feed_id` en ON DELETE no
 * action) puis la ligne Feed. 404 si le Feed est inconnu.
 */
feedsRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);

  // On purge d'abord les Articles + objets R2 (FK `articles.feed_id` en ON DELETE
  // no action), puis on supprime la ligne Feed en signalant son existence via
  // `returning()` : pas de SELECT préalable ni de fenêtre TOCTOU.
  // `deleteArticlesAndContent` tombe déjà ses articles (chokepoint #69) ; on trace
  // le Feed lui-même **avant** le hard-delete, comme ce chokepoint : un crash entre
  // les deux ne peut alors pas laisser un Feed supprimé sans tombstone (il
  // subsisterait à jamais sur le réplica local). Idempotent et sans effet
  // observable si le Feed n'existe pas (le réplica évince une entité jamais reçue),
  // d'où le 404 dérivé du seul `delete` (Delete destructif, ADR 0018).
  await deleteArticlesAndContent(db, c.env.BUCKET, eq(articles.feed_id, id));
  await writeTombstones(db, "feed", [id]);
  const deleted = await db
    .delete(feeds)
    .where(eq(feeds.id, id))
    .returning({ id: feeds.id });
  if (deleted.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json({ ok: true } satisfies OkResponse);
});
