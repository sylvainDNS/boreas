/**
 * Cache d'images hors-ligne (#77, ADR 0018 « Contenu & images ») — la frontière
 * partagée entre le **producteur** (pré-chauffage, contexte page) et le
 * **consommateur** (route cache-first du service worker, `sw.ts`).
 *
 * Les images d'article sont servies via le proxy `/api/img?u=…&sig=…` (ADR 0009),
 * dont les URLs sont **déterministes et stables** (signature HMAC sur `u`) : un
 * cache **par URL** est donc sûr (pas de péremption à gérer, deux requêtes de la
 * même image ont la même clé). Elles vivent en **Cache Storage** du SW (PAS en
 * IndexedDB) et sont servies **cache-first** ; on les **pré-chauffe** en parsant
 * le HTML pré-téléchargé pour ses `src`, sans jamais réécrire ces `src` (la
 * résolution passe par le SW au rendu de `<img>`).
 */

/**
 * Nom **unique** du Cache Storage des images, importé **à la fois** par la route
 * SW (`sw.ts`) et par le pré-chauffage : une seule constante évite que producteur
 * et consommateur divergent sur le nom (ce qui ferait que les images pré-chauffées
 * ne soient jamais servies). Le bundler du SW inline cet import.
 */
export const IMAGE_CACHE = "boreas-images";

/** Préfixe du proxy d'images (ADR 0009) : seules ces URLs sont mises en cache. */
const IMG_PROXY_PREFIX = "/api/img";

/**
 * Extrait du HTML (sanitizé serveur) les `src` d'images **proxifiées** (`/api/img…`),
 * dédoublonnés dans l'ordre d'apparition. Logique **pure** (pas de Cache Storage),
 * donc testable sans `caches` : c'est elle qui détermine quelles images pré-chauffer.
 *
 * Deux chemins selon le contexte d'exécution :
 *  - **page** (`DOMParser` disponible) : on parse le DOM — il gère les entités et
 *    attributs mal formés sans faux positifs ; `getAttribute("src")` (et non
 *    `img.src`) garde la valeur **brute** relative `/api/img?…`, sans résolution
 *    absolue dépendant du `base` du document de parsing.
 *  - **service worker** (#80, `DOMParser` absent du `WorkerGlobalScope`) : le
 *    handler `push` lance la sync dans le SW, donc cette extraction doit y tourner.
 *    On retombe sur un parsing **regex** qui décode au passage les entités de la
 *    query-string (`&amp;` → `&`), faute de quoi la clé du Cache Storage chauffée
 *    (`/api/img?u=…&amp;sig=…`) divergerait du `<img src>` décodé par le
 *    navigateur au rendu, et l'image ne serait jamais servie hors-ligne.
 *
 * On ne retient que les `src` commençant par `/api/img` — les images externes non
 * proxifiées (rare, le sanitizer les réécrit) ou `data:` sont ignorées : elles ne
 * passent pas par le SW.
 */
export function imageUrlsFromHtml(html: string | null | undefined): string[] {
  if (!html) return [];
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const urls = new Set<string>();
    for (const img of doc.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (src?.startsWith(IMG_PROXY_PREFIX)) urls.add(src);
    }
    return [...urls];
  }
  return imageUrlsFromHtmlViaRegex(html);
}

/** Entités HTML rencontrées dans une query-string proxifiée, décodées en `&`. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&");
}

/**
 * Repli **service worker** d'`imageUrlsFromHtml` (DOMParser indisponible) : scanne
 * en **une passe** les attributs `src` quotés du HTML, décode les entités de la
 * query-string, et conserve les `/api/img…` dédoublonnés dans l'ordre.
 *
 * On scanne les `src` **directement** plutôt que de découper d'abord en balises
 * `<img …>` : un `>` présent dans un attribut antérieur (`alt`/`title`, autorisés
 * par le sanitizer et non échappés en sortie) tronquerait la balise et ferait
 * perdre le `src`. Le sanitizer ne proxifie que les `src` d'`<img>` vers
 * `/api/img` (aucun autre élément ne porte ce préfixe), donc filtrer sur
 * `/api/img` préserve la parité avec le chemin DOM (qui ne lit que les `<img>`).
 */
function imageUrlsFromHtmlViaRegex(html: string): string[] {
  const urls = new Set<string>();
  const srcAttr = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of html.matchAll(srcAttr)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    const src = decodeHtmlEntities(raw);
    if (src.startsWith(IMG_PROXY_PREFIX)) urls.add(src);
  }
  return [...urls];
}

/**
 * Borne le parallélisme du pré-chauffage : les URLs sont chauffées par **lots
 * successifs** de N (barrière à chaque lot via `Promise.all`), pour ne pas saturer
 * le réseau (un article peut citer des dizaines d'images) ni la file de requêtes du
 * navigateur. Ce n'est pas une fenêtre glissante — suffisant pour un travail
 * best-effort d'arrière-plan où `cache.add` est généralement rapide.
 */
const WARM_BATCH_SIZE = 6;

/**
 * Pré-chauffe le Cache Storage des images (#77, contexte page, appelé par le
 * moteur de sync après le pré-téléchargement du HTML). Pour chaque URL **pas déjà
 * en cache** (`cache.match`), un `cache.add(url)` la fetch et la stocke sous
 * `IMAGE_CACHE` — **le même cache** que la route SW, qui la servira ensuite
 * hors-ligne. Best-effort de bout en bout :
 *  - **no-op** si `caches` est indisponible (ex. SSR/tests sans Cache Storage) ;
 *  - chaque `add` est **isolé** dans un try/catch : un échec (offline, 502 proxy)
 *    saute l'URL sans faire échouer le reste ni la passe de sync appelante ;
 *  - parallélisme **borné** par lots successifs (`WARM_BATCH_SIZE`).
 *
 * On ne réécrit aucun `src` : les `<img src="/api/img?…">` du HTML restent
 * inchangés et seront interceptés par le SW au rendu.
 */
export async function warmImageCache(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  // Cache Storage absent (environnement sans SW) : on ne peut rien pré-chauffer.
  const cacheStorage = (globalThis as { caches?: CacheStorage }).caches;
  if (!cacheStorage) return;

  let cache: Cache;
  try {
    cache = await cacheStorage.open(IMAGE_CACHE);
  } catch {
    return; // ouverture impossible : best-effort, on abandonne le pré-chauffage.
  }

  // Pré-chauffage par lots successifs bornés (barrière `Promise.all` par lot).
  for (let i = 0; i < urls.length; i += WARM_BATCH_SIZE) {
    const batch = urls.slice(i, i + WARM_BATCH_SIZE);
    await Promise.all(batch.map((url) => warmOne(cache, url)));
  }
}

/**
 * Pré-chauffe **une** URL : skip si déjà en cache (évite un re-téléchargement
 * d'une image immuable), sinon `cache.add`. Toute erreur est avalée (best-effort).
 */
async function warmOne(cache: Cache, url: string): Promise<void> {
  try {
    const hit = await cache.match(url);
    if (hit) return;
    await cache.add(url);
  } catch {
    // Offline / 502 proxy / quota : on saute cette image, la passe suivante
    // (focus/online) la re-tentera. Une image manquante n'empêche pas la lecture.
  }
}

/**
 * **Réconciliation du cache d'images** (#81, ADR 0018) — le pendant du GC du
 * contenu (`garbageCollectContent`) côté Cache Storage : supprime de
 * `IMAGE_CACHE` toute image qui n'est **plus référencée par aucun** HTML
 * conservé. C'est le « GC images différé par #77 ».
 *
 * `referencedUrls` = l'ensemble des `src` proxifiés cités par les HTML encore en
 * store (calculé par le moteur via `imageUrlsFromHtml` sur le résultat du GC).
 * Une même image pouvant être citée par plusieurs articles, on **compte les
 * références par l'union** : on garde toute clé présente dans cet ensemble, on
 * n'évince que les **clés absentes**. On compare sur le **pathname + search**
 * (`/api/img?…`), forme stable des `src` (cf. `imageUrlsFromHtml`), car les clés
 * du cache sont des `Request` d'URL absolue.
 *
 * Best-effort de bout en bout, **no-op** si `caches` est indisponible (SSR/tests
 * sans Cache Storage) ; chaque `delete` est isolé (un échec ne bloque pas le
 * reste ni la passe de sync). Ne touche **que** `IMAGE_CACHE` (pas le precache du
 * shell ni quoi que ce soit d'autre).
 */
export async function reconcileImageCache(
  referencedUrls: Iterable<string>,
): Promise<void> {
  const cacheStorage = (globalThis as { caches?: CacheStorage }).caches;
  if (!cacheStorage) return;

  let cache: Cache;
  try {
    cache = await cacheStorage.open(IMAGE_CACHE);
  } catch {
    return; // ouverture impossible : best-effort, on abandonne la réconciliation.
  }

  const referenced = new Set(referencedUrls);
  let keys: readonly Request[];
  try {
    keys = await cache.keys();
  } catch {
    return;
  }

  for (const request of keys) {
    // Clé de cache = `Request` (URL absolue) ; on la ramène à la forme relative
    // `/api/img?…` des `src` du HTML pour comparer à l'ensemble des références.
    const url = new URL(request.url);
    const relative = `${url.pathname}${url.search}`;
    if (referenced.has(relative)) continue;
    try {
      await cache.delete(request);
    } catch {
      // Suppression impossible (course, quota) : best-effort, on passe à la suivante.
    }
  }
}
