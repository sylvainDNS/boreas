import { imageCacheKey, verifyImageUrl } from "@boreas/shared/crypto";
import { Hono } from "hono";
import type { Env } from "../env";

/**
 * Proxy d'images (#16, ADR 0009).
 *
 * `GET /api/img?u=<b64url(src)>&sig=<hmac>` : les `src` ont été réécrits et signés
 * à l'ingestion par le `html-sanitizer` (#7). Le proxy ne sert que des URLs dont la
 * signature HMAC est valide — toute URL non signée/falsifiée est rejetée, ce qui
 * neutralise le SSRF. L'image est servie depuis R2 si présente (`images/{hash}`),
 * sinon fetchée puis mise en cache. Le cache assure la durabilité des images d'un
 * Saved même si la source les retire.
 *
 * Servir via ce proxy (plutôt qu'en hotlink) masque aussi l'IP/l'activité de lecture
 * vis-à-vis des éditeurs et règle le mixed-content (tout en HTTPS same-origin).
 */
export const imgRoutes = new Hono<{ Bindings: Env }>();

/** Plafond de taille d'une image mise en cache (garde-fou anti-abus du cache R2). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Délai max d'un fetch source, en-têtes **et** corps compris (anti-slowloris). */
const FETCH_TIMEOUT_MS = 15_000;

/** Plafond de redirections suivies (les images de CDN en chaînent rarement). */
const MAX_REDIRECTS = 4;

/** Statuts de redirection à suivre manuellement (cf. `redirect: "manual"`). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** URL signée immuable → cache agressif côté navigateur/CDN. */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * En-têtes d'une image servie. Outre le cache, deux garde-fous de défense en
 * profondeur couvrent le cas où l'URL serait ouverte comme document de premier
 * plan (« ouvrir l'image dans un nouvel onglet ») plutôt que rendue via `<img>` :
 * `nosniff` empêche le MIME sniffing, et la CSP `sandbox` neutralise tout script —
 * un SVG piégé par l'éditeur ne peut donc pas s'exécuter sur l'origine de l'API.
 */
function imageHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": CACHE_CONTROL,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
}

/** Vrai si l'URL est http(s) — défense en profondeur anti-SSRF avant tout fetch. */
function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Image source validée, prête à être servie et mise en cache. */
interface FetchedImage {
  contentType: string;
  bytes: ArrayBuffer;
}

/**
 * Fetch d'une image source avec les mêmes garde-fous anti-SSRF/DoS que
 * `fetchFeed` (#11) :
 * - **timeout** couvrant en-têtes ET corps (lu sous le même `AbortController`,
 *   sinon un corps envoyé au compte-gouttes bloquerait le Worker) ;
 * - **redirections suivies manuellement** avec revalidation http(s) de chaque
 *   saut : la signature ne couvre que l'URL initiale, donc une 30x vers une cible
 *   interne/non-http contournerait sinon le contrôle anti-SSRF ;
 * - **type** image/* et **taille** ≤ plafond, corps non vide.
 *
 * Renvoie `null` sur tout échec (non-2xx, non-image, trop gros/vide, redirection
 * invalide, dépassement de sauts, timeout) — l'appelant le traduit en 502, sans
 * rien mettre en cache.
 */
async function fetchImage(src: string): Promise<FetchedImage | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let currentUrl = src;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        if (!location) return null;
        const target = new URL(location, currentUrl).toString();
        // Anti-SSRF : on ne suit que des cibles http(s) (refuse file:, data:…).
        if (!isHttpUrl(target)) return null;
        currentUrl = target;
        continue;
      }

      if (!res.ok) return null;

      // On ne sert/cache que des images. Comparaison insensible à la casse : le
      // type MIME l'est (RFC 2045), certains serveurs renvoient `IMAGE/JPEG`.
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("image/")) return null;

      // Rejet anticipé sur le `Content-Length` déclaré : évite de bufferiser une
      // réponse honnêtement énorme avant d'en connaître la taille.
      const declaredLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
        return null;
      }

      const bytes = await res.arrayBuffer();
      // Filet pour un `Content-Length` absent/mensonger, et rejet d'un corps vide
      // (réponse tronquée) : sinon il serait caché en `immutable` pour un an sans
      // auto-réparation possible.
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
        return null;
      }

      return { contentType, bytes };
    }

    return null; // trop de redirections
  } catch (err) {
    console.error("[img] fetch de la source échoué", err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

imgRoutes.get("/", async (c) => {
  const upstreamError = () => c.json({ error: "upstream" }, 502);

  const src = verifyImageUrl(
    c.env.HMAC_SECRET,
    c.req.query("u") ?? "",
    c.req.query("sig") ?? "",
  );
  // URL absente, signature falsifiée ou schéma non http(s) : rejet sec, aucun
  // fetch (anti-SSRF — la signature n'engageant que `u`, on revérifie le schéma).
  if (!src || !isHttpUrl(src)) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const key = imageCacheKey(src);

  // 1) Cache R2 : sert l'objet stocké tel quel, avec son content-type d'origine.
  try {
    const hit = await c.env.BUCKET.get(key);
    if (hit) {
      return new Response(hit.body, {
        headers: imageHeaders(
          hit.httpMetadata?.contentType ?? "application/octet-stream",
        ),
      });
    }
  } catch (err) {
    console.error("[img] lecture du cache R2 échouée", err);
    // On poursuit vers le fetch : une panne de lecture R2 ne doit pas tout bloquer.
  }

  // 2) Miss : fetch de la source (garde-fous anti-SSRF/DoS), mise en cache, service.
  const fetched = await fetchImage(src);
  if (!fetched) {
    return upstreamError();
  }

  try {
    await c.env.BUCKET.put(key, fetched.bytes, {
      httpMetadata: { contentType: fetched.contentType },
    });
  } catch (err) {
    console.error("[img] écriture du cache R2 échouée", err);
    // Échec de cache non fatal : on sert quand même l'image fetchée.
  }

  return new Response(fetched.bytes, {
    headers: imageHeaders(fetched.contentType),
  });
});
