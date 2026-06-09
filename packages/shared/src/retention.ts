import { and, eq, isNotNull, lt, type SQL } from "drizzle-orm";
import type { Db } from "./db";
import { articles, settings } from "./db";
import { deleteArticlesAndContent } from "./ingestion";
import { sqlUtcNow } from "./timestamp";

/**
 * Rétention (#15, ADR 0004/0009/0010) : garde la base légère sans intervention.
 * Orchestré par le Worker Cron après l'enqueue des feeds dus (`scheduled`).
 *
 *   purge des Articles Read & non-Saved expirés (+ leurs objets R2)
 *   → balayage des orphelins R2 en filet de sécurité.
 *
 * L'horloge de purge est `fetched_at` ; la fenêtre est `settings.purge_window_days`.
 * Les Saved ne sont **jamais** purgés, quelle que soit leur ancienneté.
 */

// Repli quand `settings.purge_window_days` est introuvable (base non seedée).
const DEFAULT_PURGE_WINDOW_DAYS = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Préfixe R2 des objets de contenu HTML extrait (`articles/{id}.html`, ADR 0004).
// Les images proxifiées (`images/{hash}`, ADR 0009) arriveront avec #16 ; leur GC
// fin (comptage de références) est différé à cette issue.
const CONTENT_PREFIX = "articles/";

// R2 plafonne une suppression groupée à 1000 clés par appel.
const R2_DELETE_CHUNK = 1000;

// Période de grâce du balayage : un objet uploadé il y a moins d'1 h n'est jamais
// considéré orphelin. L'ingestion écrit l'objet R2 **avant** d'insérer la ligne D1
// (`upsertNewArticles` : tous les `put` puis l'`insert`) ; sans cette grâce, un
// sweep concurrent à une ingestion en vol pourrait lire l'ensemble des
// `content_key` avant l'insert et supprimer un objet pourtant sur le point d'être
// référencé — perte du contenu d'un article vivant. 1 h dépasse largement toute
// durée d'ingestion plausible.
const SWEEP_GRACE_MS = 60 * 60 * 1000;

/** Fenêtre de rétention (jours) du singleton `settings`, avec repli. */
async function getPurgeWindowDays(db: Db): Promise<number> {
  const [row] = await db
    .select({ days: settings.purge_window_days })
    .from(settings)
    .limit(1);
  return row?.days ?? DEFAULT_PURGE_WINDOW_DAYS;
}

/**
 * Purge les Articles `read & !saved & fetched_at < now − fenêtre`, en effaçant
 * aussi leurs objets R2 (via `deleteArticlesAndContent`, cohérence deux-stores).
 * Renvoie le nombre de lignes supprimées.
 *
 * Les Saved sont exclus par construction (`saved = false`) : aucun Saved n'est
 * jamais purgé. Le filtre `read = true` épargne aussi les non-lus, même anciens.
 */
export async function purgeExpiredArticles(
  db: Db,
  bucket: R2Bucket,
  now: Date = new Date(),
): Promise<number> {
  const windowDays = await getPurgeWindowDays(db);
  // `fetched_at` est posé via `sqlUtcNow` (même format) → comparaison lexicale sûre.
  const cutoff = sqlUtcNow(new Date(now.getTime() - windowDays * MS_PER_DAY));
  return deleteArticlesAndContent(
    db,
    bucket,
    and(
      eq(articles.read, true),
      eq(articles.saved, false),
      lt(articles.fetched_at, cutoff),
    ) as SQL,
  );
}

/**
 * Balaie les objets R2 sous `prefix` qui ne sont plus référencés par aucune
 * ligne D1 (`articles.content_key`), filet de sécurité pour les objets dont la
 * suppression inline avait échoué (panne R2 ponctuelle, ADR 0004). Renvoie le
 * nombre d'orphelins supprimés.
 *
 * Les objets uploadés depuis moins de `SWEEP_GRACE_MS` sont épargnés : ils
 * peuvent appartenir à une ingestion en vol (put R2 fait, insert D1 pas encore),
 * dont la ligne ne figure pas encore dans l'ensemble des `content_key` lu ici.
 */
export async function sweepOrphanContent(
  db: Db,
  bucket: R2Bucket,
  now: Date = new Date(),
  prefix: string = CONTENT_PREFIX,
): Promise<number> {
  const referenced = new Set(
    (
      await db
        .select({ key: articles.content_key })
        .from(articles)
        .where(isNotNull(articles.content_key))
    )
      .map((r) => r.key)
      .filter((k): k is string => k !== null),
  );

  // Accumule les clés orphelines en paginant le listing R2, puis supprime par
  // lots de 1000 (limite `delete`).
  const freshCutoffMs = now.getTime() - SWEEP_GRACE_MS;
  const orphans: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const obj of listed.objects) {
      // Épargne les objets trop récents (ingestion possiblement en vol).
      if (obj.uploaded.getTime() > freshCutoffMs) continue;
      if (!referenced.has(obj.key)) orphans.push(obj.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  for (let i = 0; i < orphans.length; i += R2_DELETE_CHUNK) {
    try {
      await bucket.delete(orphans.slice(i, i + R2_DELETE_CHUNK));
    } catch (err) {
      console.error("[retention] suppression d'orphelins R2 échouée", err);
    }
  }
  return orphans.length;
}

/**
 * Orchestre la rétention : purge d'abord (qui peut générer des orphelins R2 si
 * un delete inline échoue), puis balaie les orphelins. Chaque étape est isolée
 * pour qu'un échec de l'une n'empêche pas l'autre. Renvoie les compteurs.
 */
export async function runRetention(
  db: Db,
  bucket: R2Bucket,
  now: Date = new Date(),
): Promise<{ purged: number; sweptOrphans: number }> {
  let purged = 0;
  let sweptOrphans = 0;

  try {
    purged = await purgeExpiredArticles(db, bucket, now);
  } catch (err) {
    console.error("[retention] purge échouée", err);
  }

  try {
    sweptOrphans = await sweepOrphanContent(db, bucket, now);
  } catch (err) {
    console.error("[retention] balayage des orphelins échoué", err);
  }

  console.log("[retention] terminée", { purged, sweptOrphans });
  return { purged, sweptOrphans };
}
