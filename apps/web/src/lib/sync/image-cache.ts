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
 * On parse via `DOMParser` (contexte page) plutôt qu'en regex : il gère les entités
 * et attributs mal formés sans faux positifs. On ne retient que les `src`
 * commençant par `/api/img` — les images externes non proxifiées (rare, le
 * sanitizer les réécrit) ou `data:` sont ignorées : elles ne passent pas par le SW.
 */
export function imageUrlsFromHtml(html: string | null | undefined): string[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const urls = new Set<string>();
  for (const img of doc.querySelectorAll("img")) {
    // `getAttribute` (et non `img.src`) : on veut la valeur **brute** relative
    // `/api/img?…` telle qu'écrite par le sanitizer, pas une résolution absolue
    // (qui dépendrait du `base` du document de parsing).
    const src = img.getAttribute("src");
    if (src?.startsWith(IMG_PROXY_PREFIX)) urls.add(src);
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
