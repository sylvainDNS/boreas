import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildConditionalHeaders,
  computeNextCheckAt,
  fetchFeed,
} from "../src/ingestion";

describe("buildConditionalHeaders", () => {
  it("n'ajoute aucun en-tête conditionnel sans validateur connu", () => {
    const headers = buildConditionalHeaders(null, null);
    expect(headers["if-none-match"]).toBeUndefined();
    expect(headers["if-modified-since"]).toBeUndefined();
    // Les en-têtes de base (UA / Accept) restent présents.
    expect(headers["user-agent"]).toContain("Boreas");
    expect(headers.accept).toContain("rss");
  });

  it("rejoue l'ETag en If-None-Match", () => {
    const headers = buildConditionalHeaders('"abc123"', null);
    expect(headers["if-none-match"]).toBe('"abc123"');
    expect(headers["if-modified-since"]).toBeUndefined();
  });

  it("rejoue le Last-Modified en If-Modified-Since", () => {
    const lm = "Wed, 21 Oct 2026 07:28:00 GMT";
    const headers = buildConditionalHeaders(null, lm);
    expect(headers["if-modified-since"]).toBe(lm);
    expect(headers["if-none-match"]).toBeUndefined();
  });

  it("rejoue les deux validateurs quand ils sont connus", () => {
    const headers = buildConditionalHeaders('"e"', "lm");
    expect(headers["if-none-match"]).toBe('"e"');
    expect(headers["if-modified-since"]).toBe("lm");
  });
});

describe("computeNextCheckAt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("place l'échéance au moins à now + intervalle (0 échec)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const now = new Date("2026-06-05T12:00:00Z");
    expect(computeNextCheckAt(30, 0, now)).toBe("2026-06-05T12:30:00Z");
  });

  it("ajoute un jitter borné à 25 % de l'intervalle", () => {
    // random=1 (borne haute) → +30 min + 25 % de 30 min = +37 min 30 s.
    vi.spyOn(Math, "random").mockReturnValue(1);
    const now = new Date("2026-06-05T12:00:00Z");
    expect(computeNextCheckAt(30, 0, now)).toBe("2026-06-05T12:37:30Z");
  });

  it("double l'intervalle à chaque échec consécutif (backoff #11)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const now = new Date("2026-06-05T12:00:00Z");
    // 1 échec → ×2 = 60 min ; 2 échecs → ×4 = 120 min ; 3 échecs → ×8 = 240 min.
    expect(computeNextCheckAt(30, 1, now)).toBe("2026-06-05T13:00:00Z");
    expect(computeNextCheckAt(30, 2, now)).toBe("2026-06-05T14:00:00Z");
    expect(computeNextCheckAt(30, 3, now)).toBe("2026-06-05T16:00:00Z");
  });

  it("plafonne le backoff à 24 h", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const now = new Date("2026-06-05T12:00:00Z");
    // 30 min × 2^10 = ~512 h, plafonné à 24 h.
    expect(computeNextCheckAt(30, 10, now)).toBe("2026-06-06T12:00:00Z");
  });

  it("renvoie un horodatage au format SQL (sans millisecondes)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = computeNextCheckAt(30, 0, new Date("2026-06-05T12:00:00Z"));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe("fetchFeed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Mock de `fetch` qui renvoie une réponse par appel, dans l'ordre fourni. */
  function stubFetchSequence(responses: Response[]): ReturnType<typeof vi.fn> {
    const fn = vi.fn();
    for (const r of responses) fn.mockResolvedValueOnce(r);
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("suit une redirection 301 et remonte l'URL permanente", async () => {
    const fn = stubFetchSequence([
      new Response(null, {
        status: 301,
        headers: { location: "https://new.example.com/feed.xml" },
      }),
      new Response("<rss></rss>", { status: 200 }),
    ]);
    const result = await fetchFeed("https://old.example.com/feed.xml", {});
    expect(result.response.status).toBe(200);
    expect(result.permanentUrl).toBe("https://new.example.com/feed.xml");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("suit une redirection 302 sans marquer l'URL comme permanente", async () => {
    stubFetchSequence([
      new Response(null, {
        status: 302,
        headers: { location: "https://tmp.example.com/feed.xml" },
      }),
      new Response("<rss></rss>", { status: 200 }),
    ]);
    const result = await fetchFeed("https://old.example.com/feed.xml", {});
    expect(result.response.status).toBe(200);
    expect(result.permanentUrl).toBeNull();
  });

  it("annule la permanence si un saut temporaire suit un 301", async () => {
    stubFetchSequence([
      new Response(null, {
        status: 301,
        headers: { location: "https://a.example.com/feed.xml" },
      }),
      new Response(null, {
        status: 302,
        headers: { location: "https://b.example.com/feed.xml" },
      }),
      new Response("<rss></rss>", { status: 200 }),
    ]);
    const result = await fetchFeed("https://old.example.com/feed.xml", {});
    expect(result.permanentUrl).toBeNull();
  });

  it("lève au-delà de 5 redirections", async () => {
    const redirect = () =>
      new Response(null, {
        status: 301,
        headers: { location: "https://loop.example.com/next" },
      });
    const fn = vi.fn().mockImplementation(() => Promise.resolve(redirect()));
    vi.stubGlobal("fetch", fn);
    await expect(
      fetchFeed("https://loop.example.com/feed.xml", {}),
    ).rejects.toThrow("too_many_redirects");
  });

  it("refuse une redirection vers un schéma non-http (garde anti-SSRF)", async () => {
    stubFetchSequence([
      new Response(null, {
        status: 301,
        headers: { location: "file:///etc/passwd" },
      }),
    ]);
    await expect(
      fetchFeed("https://evil.example.com/feed.xml", {}),
    ).rejects.toThrow("bad_redirect");
  });

  it("lit le corps d'une réponse 2xx (timeout couvre le corps)", async () => {
    stubFetchSequence([new Response("<rss>ok</rss>", { status: 200 })]);
    const result = await fetchFeed("https://example.com/feed.xml", {});
    expect(result.bytes).not.toBeNull();
    expect(new TextDecoder().decode(result.bytes ?? undefined)).toBe(
      "<rss>ok</rss>",
    );
  });

  it("ne lit pas le corps d'un statut non-2xx", async () => {
    stubFetchSequence([new Response("boom", { status: 500 })]);
    const result = await fetchFeed("https://example.com/feed.xml", {});
    expect(result.response.status).toBe(500);
    expect(result.bytes).toBeNull();
  });

  it("lève si le Content-Length dépasse la limite", async () => {
    stubFetchSequence([
      new Response("x", {
        status: 200,
        headers: { "content-length": String(11 * 1024 * 1024) },
      }),
    ]);
    await expect(
      fetchFeed("https://big.example.com/feed.xml", {}),
    ).rejects.toThrow("too_large");
  });

  it("renvoie directement une réponse non-redirect (304)", async () => {
    stubFetchSequence([new Response(null, { status: 304 })]);
    const result = await fetchFeed("https://example.com/feed.xml", {});
    expect(result.response.status).toBe(304);
    expect(result.permanentUrl).toBeNull();
  });

  it("avorte le fetch après le timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const promise = fetchFeed("https://slow.example.com/feed.xml", {});
    const assertion = expect(promise).rejects.toThrow(/abort/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});
