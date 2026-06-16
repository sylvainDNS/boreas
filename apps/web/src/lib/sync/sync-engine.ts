import type {
  ArticleContentResponse,
  SyncResponse,
} from "@boreas/api-contracts";
import {
  imageUrlsFromHtml,
  reconcileImageCache,
  warmImageCache,
} from "./image-cache";
import { countOutbox, flushOutbox, type PushOutbox } from "./outbox-store";
import {
  applyDelta,
  clearReplica,
  garbageCollectContent,
  missingContentIds,
  type ReplicaDb,
  readSyncCursor,
  unreadOrSavedIds,
  writeArticleContent,
  writeSyncCursor,
} from "./replica-store";

/**
 * Moteur de sync (#72/#74, ADR 0018) : **seul** module à parler au backend pour
 * le réplica. Une passe **pousse l'outbox AVANT de pull** le delta
 * (push-avant-pull) : les mutations locales (Read/Saved/mark-all-read) partent en
 * premier, puis on rapatrie le delta descendant. L'UI ne lit que le réplica (pas
 * de switch online/offline).
 */

/** Fonction de transport : pull une page de delta pour un `since` donné. */
export type PullDelta = (since: number) => Promise<SyncResponse>;

/**
 * Fonction de transport du contenu (#75) : récupère le HTML d'un lot d'ids
 * (`POST /api/articles/content`, sans effet Read). Le moteur l'appelle par lots
 * bornés pour pré-télécharger le corpus offline (non-lus ∪ Saved).
 */
export type FetchContent = (ids: string[]) => Promise<ArticleContentResponse>;

/**
 * Taille de lot du pré-téléchargement de contenu : borne la taille du corps
 * `POST /content` et le volume R2 par requête, sans plafonner le corpus total
 * (réparti sur plusieurs lots).
 */
const CONTENT_BATCH_SIZE = 50;

/**
 * Pré-télécharge le HTML manquant du corpus offline (non-lus ∪ Saved) et le range
 * dans le store `content` (#75, ADR 0018). N'appelle le réseau que pour les ids
 * **absents** du store (pas de re-téléchargement), par lots bornés. Best-effort :
 * une erreur réseau (hors-ligne) est **avalée** — la sync (delta déjà appliqué)
 * ne doit pas échouer ; le contenu sera rapatrié à une passe ultérieure. Exécuté
 * aussi depuis le handler `push` du SW (#80) : c'est lui qui rend l'article
 * lisible hors-ligne avant l'affichage de la notification.
 *
 * **Pré-chauffage des images (#77, ADR 0018)** : pour chaque HTML fraîchement
 * téléchargé, on extrait ses `src` proxifiés (`/api/img…`) et on les pré-chauffe
 * dans le Cache Storage du SW (cache-first), de sorte qu'ouvrir l'article
 * hors-ligne affiche **ses images**. C'est branché ICI — donc uniquement pour les
 * articles dont le HTML vient d'être rapatrié (corpus non-lus ∪ Saved), jamais
 * pour ceux hors corpus. Aussi best-effort : `warmImageCache` avale ses échecs.
 */
async function prefetchContent(
  db: ReplicaDb,
  fetchContent: FetchContent,
): Promise<void> {
  try {
    const corpus = await unreadOrSavedIds(db);
    const missing = await missingContentIds(db, corpus);
    // (1) On persiste d'abord **tout** le HTML (donnée critique de lecture offline),
    // en accumulant au passage les `src` d'images proxifiées. Le pré-chauffage des
    // images — best-effort et secondaire — ne doit PAS s'intercaler entre les lots
    // de contenu : sinon fermer l'onglet en cours de chauffage laisserait du HTML
    // lisible non sauvegardé, alors que des images l'auraient été.
    const imageUrls = new Set<string>();
    for (let i = 0; i < missing.length; i += CONTENT_BATCH_SIZE) {
      const batch = missing.slice(i, i + CONTENT_BATCH_SIZE);
      const items = await fetchContent(batch);
      for (const item of items) {
        await writeArticleContent(db, item.id, item.html);
        // Pas de réécriture du `src` : on ne fait que collecter les URLs à chauffer.
        for (const url of imageUrlsFromHtml(item.html)) imageUrls.add(url);
      }
    }
    // (2) Contenu intégralement persisté → pré-chauffage du Cache Storage des images
    // (best-effort, offline → skip), une seule passe dédoublonnée sur tout le corpus.
    await warmImageCache([...imageUrls]);
  } catch {
    // Hors-ligne / erreur réseau : on garde le delta déjà appliqué et on
    // re-tentera le pré-téléchargement à la prochaine passe (focus/online).
  }
}

/**
 * Défaut de `push` : **lève** dès qu'une entrée doit être poussée. Un push no-op
 * « réussirait » chaque entrée et `flushOutbox` la supprimerait → **perte
 * silencieuse** des mutations locales (Read/Saved/mark-all-read). Avec ce défaut,
 * un appelant qui oublie `push` échoue bruyamment au lieu de vider l'outbox sans
 * rien envoyer. L'unique appelant de prod (`replica.ts`) passe toujours
 * `pushOutboxEntry` ; les passes de pull pur ont une outbox vide → le push n'est
 * jamais invoqué, ce défaut n'est donc jamais atteint chez elles.
 */
const pushRequired: PushOutbox = () => {
  throw new Error(
    "runSync: argument `push` manquant alors que l'outbox contient des entrées à flusher",
  );
};

/**
 * **Passe de GC** (#81, ADR 0018) — exécutée après application du delta, avant le
 * pré-téléchargement : évince le HTML des articles devenus **Read non-Saved**
 * (sortis du corpus `non-lus ∪ Saved`), puis **réconcilie le Cache Storage** des
 * images = supprime celles qui ne sont **référencées par aucun** contenu restant.
 *
 * `garbageCollectContent` renvoie les HTML conservés ; on en recalcule
 * l'ensemble des `src` proxifiés via `imageUrlsFromHtml` (la même extraction que
 * le pré-chauffage), puis `reconcileImageCache` n'évince du cache que les clés
 * **absentes** de cet ensemble (comptage de références par l'union — une image
 * citée par plusieurs articles survit tant qu'un seul la cite). Les **métadonnées
 * restent** (store `articles` intact). Best-effort : `reconcileImageCache` est
 * no-op sans `caches`. Idempotent (relancé, n'évince rien de plus).
 */
async function garbageCollect(db: ReplicaDb): Promise<void> {
  const keptHtml = await garbageCollectContent(db);
  const referenced = new Set<string>();
  for (const html of keptHtml) {
    for (const url of imageUrlsFromHtml(html)) referenced.add(url);
  }
  await reconcileImageCache(referenced);
}

/**
 * Défaut de `fetchContent` : **no-op** (à la différence de `pushRequired`). Le
 * pré-téléchargement du contenu est **best-effort** et `prefetchContent` avale déjà
 * toute erreur : omettre le transport n'entraîne donc **aucune perte de données**,
 * ça désactive simplement le pré-chauffage offline. Un défaut qui lèverait serait
 * une fausse symétrie avec `pushRequired` — le throw serait absorbé par le `catch`
 * de `prefetchContent`, donc jamais observable. L'appelant de prod (`replica.ts`)
 * passe toujours `pullArticleContent`.
 */
const noopFetchContent: FetchContent = async () => [];

/**
 * Exécute une passe de sync complète :
 *  1. **push de l'outbox** (#74) : flush des mutations locales vers l'API, AVANT
 *     le pull. Sur `401`/réseau, l'erreur remonte ici sans drop d'entrée (l'outbox
 *     survit pour la passe suivante / la ré-auth) et on **n'enchaîne pas** le pull.
 *  2. pull du delta depuis le curseur persisté (`null` ⇒ `since=0`, initiale),
 *     en enchaînant les pages tant que `complete` est faux ;
 *  3. application de chaque page au réplica + avancée du curseur ;
 *  4. sur `stale` (curseur périmé), wipe du réplica + resync complet depuis 0 ;
 *  5. **GC du contenu local** (#81) : évince le HTML des articles devenus
 *     Read-non-Saved (sortis du corpus) et réconcilie le cache d'images
 *     (suppression des images non référencées) — métadonnées préservées ;
 *  6. **pré-téléchargement du contenu** (#75) : HTML des non-lus ∪ Saved manquant,
 *     stocké en IndexedDB (best-effort, avalé hors-ligne) — la lecture devient
 *     possible hors-ligne sans avoir ouvert l'article. Le Read n'étant plus un
 *     effet du GET (#75), ce pré-chauffage ne passe AUCUN article en lu.
 *
 * Idempotente et sûre à rejouer (déclencheurs multiples) : un échec réseau du
 * pull remonte tel quel sans avancer le curseur au-delà de la dernière page
 * écrite ; un échec du seul pré-téléchargement n'échoue pas la passe.
 */
export async function runSync(
  db: ReplicaDb,
  pull: PullDelta,
  push: PushOutbox = pushRequired,
  fetchContent: FetchContent = noopFetchContent,
): Promise<void> {
  // L'appartenance d'un article au corpus offline (non-lus ∪ Saved) ne change que
  // sur une mutation de lecture locale (outbox en attente avant le flush) ou un
  // delta touchant des articles ; on capture donc l'outbox AVANT le flush pour
  // décider, plus bas, s'il vaut la peine de lancer le GC (sinon coûteux à vide).
  const hadPendingMutations = (await countOutbox(db)) > 0;

  // --- (1) Push de l'outbox AVANT le pull (push-avant-pull, ADR 0018) ---
  // En cas d'échec (401/réseau), `flushOutbox` propage : on ne pull pas, et les
  // entrées non-poussées restent en outbox pour la prochaine passe.
  await flushOutbox(db, push);

  // --- (2-4) Pull paginé depuis le curseur courant ---
  let since = (await readSyncCursor(db)) ?? 0;
  let alreadyWiped = false;
  // Le delta a-t-il touché des articles (upserts/tombstones) ? Sinon, aucun
  // article n'a pu changer d'appartenance au corpus côté serveur cette passe.
  let deltaTouchedArticles = false;

  while (true) {
    const page = await pull(since);

    // Curseur périmé : le serveur ne garantit plus l'exhaustivité des
    // suppressions depuis ce `since` → on repart d'une sync initiale propre.
    // `alreadyWiped` borne la récursion à un seul wipe (pas de boucle si le
    // serveur renvoyait `stale` même pour since=0, ce qu'il ne fait pas).
    if (page.stale && !alreadyWiped) {
      await clearReplica(db);
      alreadyWiped = true;
      since = 0;
      continue;
    }

    if (page.upserts.articles.length > 0 || page.tombstones.length > 0) {
      deltaTouchedArticles = true;
    }

    await applyDelta(db, {
      upserts: page.upserts,
      tombstones: page.tombstones,
    });

    // On n'avance le curseur que si la page en porte un (page vide ⇒ `null` ⇒
    // on garde le curseur précédent intact).
    if (page.cursor !== null) {
      await writeSyncCursor(db, page.cursor);
      since = page.cursor;
    }

    if (page.complete) break;
  }

  // --- (5) GC du contenu local (#81) : évince le HTML des articles passés
  //         Read-non-Saved et réconcilie le cache d'images. Avant le
  //         pré-téléchargement pour ne pas re-chauffer une image qu'on va évincer.
  //         Best-effort (un échec idb n'échoue pas la passe — le delta/curseur sont
  //         déjà persistés ; on réessaiera). On **saute** le scan O(corpus) si rien
  //         n'a pu changer l'appartenance au corpus cette passe (onglet idle, delta
  //         vide et aucune mutation locale en attente).
  if (hadPendingMutations || deltaTouchedArticles) {
    try {
      await garbageCollect(db);
    } catch {
      // GC best-effort : réessayé à la prochaine passe.
    }
  }

  // --- (6) Pré-téléchargement du contenu offline (#75), best-effort. Le delta
  //         ci-dessus a déjà synchronisé les métadonnées ; ce contenu lourd
  //         (HTML + images) rend les articles lisibles hors-ligne. ---
  await prefetchContent(db, fetchContent);
}
