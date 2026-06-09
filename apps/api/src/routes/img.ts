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

  // 2) Miss : fetch de la source, validation, mise en cache, puis service.
  try {
    const upstream = await fetch(src);
    if (!upstream.ok) {
      return upstreamError();
    }

    const contentType = upstream.headers.get("content-type") ?? "";
    // On ne sert/cache que des images. Comparaison insensible à la casse : le
    // type MIME l'est (RFC 2045), certains serveurs renvoient `IMAGE/JPEG`.
    if (!contentType.toLowerCase().startsWith("image/")) {
      return upstreamError();
    }

    // Rejet anticipé sur le `Content-Length` déclaré : évite de bufferiser en
    // mémoire une réponse honnêtement énorme avant d'en connaître la taille.
    const declaredLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      return upstreamError();
    }

    const bytes = await upstream.arrayBuffer();
    // Filet pour un `Content-Length` absent ou mensonger.
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return upstreamError();
    }

    try {
      await c.env.BUCKET.put(key, bytes, {
        httpMetadata: { contentType },
      });
    } catch (err) {
      console.error("[img] écriture du cache R2 échouée", err);
      // Échec de cache non fatal : on sert quand même l'image fetchée.
    }

    return new Response(bytes, { headers: imageHeaders(contentType) });
  } catch (err) {
    console.error("[img] fetch de la source échoué", err);
    return upstreamError();
  }
});
