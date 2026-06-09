import { env, SELF } from "cloudflare:test";
import {
  imageCacheKey,
  issueSession,
  signImageUrl,
} from "@boreas/shared/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "../src/lib/session";

const SECRET = "test-secret";
const ORIGIN = "https://api.test";

function authed(init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...init?.headers,
      cookie: `${SESSION_COOKIE}=${issueSession(SECRET)}`,
    },
  };
}

/** 1×1 PNG transparent (bytes déterministes pour comparer le corps servi). */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

/**
 * Stube le `fetch` sortant du Worker (la source de l'image). `cloudflare:test`
 * de cette version n'expose pas `fetchMock` ; le Worker partageant l'isolat du
 * test, on stube le `fetch` global. `SELF.fetch` (appel du Worker) reste intact.
 */
function mockOutboundFetch(
  body: BodyInit,
  init: { status?: number; contentType?: string } = {},
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(body, {
        status: init.status ?? 200,
        headers: { "content-type": init.contentType ?? "image/png" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Construit l'URL proxy signée pour une source donnée. */
function proxyUrl(src: string): string {
  return `${ORIGIN}${signImageUrl(SECRET, src)}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/img — proxy d'images", () => {
  it("rejette une URL non signée (sig absent) en 400", async () => {
    const u = Buffer.from("https://magazine.example/a.jpg", "utf8").toString(
      "base64url",
    );
    const res = await SELF.fetch(`${ORIGIN}/api/img?u=${u}`, authed());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("rejette une signature falsifiée en 400 (anti-SSRF)", async () => {
    const u = Buffer.from("https://magazine.example/a.jpg", "utf8").toString(
      "base64url",
    );
    const res = await SELF.fetch(
      `${ORIGIN}/api/img?u=${u}&sig=falsifiee`,
      authed(),
    );
    expect(res.status).toBe(400);
  });

  it("sert depuis R2 sans fetch quand l'image est en cache", async () => {
    const src = "https://magazine.example/photos/cached.png";
    await env.BUCKET.put(imageCacheKey(src), PNG_BYTES, {
      httpMetadata: { contentType: "image/png" },
    });
    const fetchSpy = mockOutboundFetch("ne devrait pas être appelé", {
      contentType: "text/plain",
    });

    const res = await SELF.fetch(proxyUrl(src), authed());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    // Garde-fous défense en profondeur sur l'objet servi (SVG ouvert en document).
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepte un content-type image en majuscules (insensible à la casse)", async () => {
    const src = "https://magazine.example/photos/upper.png";
    mockOutboundFetch(PNG_BYTES, { contentType: "IMAGE/PNG" });
    const res = await SELF.fetch(proxyUrl(src), authed());
    expect(res.status).toBe(200);
  });

  it("rejette une URL signée mais non http(s) en 400 (anti-SSRF)", async () => {
    const fetchSpy = mockOutboundFetch(PNG_BYTES, { contentType: "image/png" });
    const res = await SELF.fetch(proxyUrl("file:///etc/passwd"), authed());
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejette une redirection vers une cible non http(s) en 502 (anti-SSRF)", async () => {
    const src = "https://magazine.example/photos/redir.png";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "file:///etc/passwd" },
          }),
      ),
    );
    const res = await SELF.fetch(proxyUrl(src), authed());
    expect(res.status).toBe(502);
    expect(await env.BUCKET.get(imageCacheKey(src))).toBeNull();
  });

  it("suit une redirection http(s) légitime puis sert l'image", async () => {
    const src = "https://magazine.example/photos/moved.png";
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === src) {
        return new Response(null, {
          status: 301,
          headers: { location: "https://cdn.example/real.png" },
        });
      }
      return new Response(PNG_BYTES, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await SELF.fetch(proxyUrl(src), authed());
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("renvoie 502 et ne cache pas un corps vide (réponse tronquée)", async () => {
    const src = "https://magazine.example/photos/empty.png";
    mockOutboundFetch(new Uint8Array([]), { contentType: "image/png" });
    const res = await SELF.fetch(proxyUrl(src), authed());
    expect(res.status).toBe(502);
    expect(await env.BUCKET.get(imageCacheKey(src))).toBeNull();
  });

  it("fetch + cache R2 sur miss, puis sert depuis le cache au 2e appel", async () => {
    const src = "https://magazine.example/photos/fresh.png";
    const fetchSpy = mockOutboundFetch(PNG_BYTES, { contentType: "image/png" });

    const res1 = await SELF.fetch(proxyUrl(src), authed());
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res1.arrayBuffer())).toEqual(PNG_BYTES);

    // Le cache R2 a bien été peuplé.
    const cached = await env.BUCKET.get(imageCacheKey(src));
    expect(cached).not.toBeNull();

    // 2e appel : servi depuis R2, pas de nouveau fetch sortant.
    const res2 = await SELF.fetch(proxyUrl(src), authed());
    expect(res2.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("renvoie 502 si la source répond non-OK", async () => {
    const src = "https://magazine.example/photos/gone.png";
    mockOutboundFetch("introuvable", { status: 404, contentType: "image/png" });
    const res = await SELF.fetch(proxyUrl(src), authed());
    expect(res.status).toBe(502);
  });

  it("renvoie 502 si la source n'est pas une image", async () => {
    const src = "https://magazine.example/photos/notimage";
    mockOutboundFetch("<html></html>", { contentType: "text/html" });
    const res = await SELF.fetch(proxyUrl(src), authed());
    expect(res.status).toBe(502);
    // Rien ne doit avoir été mis en cache.
    expect(await env.BUCKET.get(imageCacheKey(src))).toBeNull();
  });

  it("exige une session (401 sans cookie)", async () => {
    const res = await SELF.fetch(proxyUrl("https://magazine.example/a.png"));
    expect(res.status).toBe(401);
  });
});
