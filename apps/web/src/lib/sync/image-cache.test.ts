import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_CACHE,
  imageUrlsFromHtml,
  reconcileImageCache,
  warmImageCache,
} from "./image-cache";

describe("image-cache — imageUrlsFromHtml", () => {
  it("extrait les src des images proxy /api/img", () => {
    const html =
      '<p>Texte</p><img src="/api/img?u=AAA&sig=xxx" alt="a">' +
      '<figure><img src="/api/img?u=BBB&sig=yyy"></figure>';
    expect(imageUrlsFromHtml(html)).toEqual([
      "/api/img?u=AAA&sig=xxx",
      "/api/img?u=BBB&sig=yyy",
    ]);
  });

  it("ne renvoie QUE les src /api/img (ignore les images externes non proxifiées)", () => {
    const html =
      '<img src="https://cdn.example.com/x.png">' +
      '<img src="/api/img?u=AAA&sig=xxx">' +
      '<img src="data:image/png;base64,Zm9v">';
    expect(imageUrlsFromHtml(html)).toEqual(["/api/img?u=AAA&sig=xxx"]);
  });

  it("dédoublonne les src identiques (URL déterministe HMAC stable)", () => {
    const html =
      '<img src="/api/img?u=AAA&sig=xxx">' +
      '<img src="/api/img?u=AAA&sig=xxx">';
    expect(imageUrlsFromHtml(html)).toEqual(["/api/img?u=AAA&sig=xxx"]);
  });

  it("renvoie un tableau vide pour un HTML sans image / null / vide", () => {
    expect(imageUrlsFromHtml("<p>aucune image</p>")).toEqual([]);
    expect(imageUrlsFromHtml("")).toEqual([]);
    expect(imageUrlsFromHtml(null)).toEqual([]);
  });
});

// --- warmImageCache : pré-chauffage du Cache Storage (mock de `caches`) ---

interface MockCache {
  matched: Set<string>;
  added: string[];
  add: ReturnType<typeof vi.fn>;
}

/** Installe un faux `globalThis.caches` ; renvoie le cache mocké + un restore. */
function mockCaches(alreadyCached: string[] = []): {
  cache: MockCache;
  openName: () => string | undefined;
  restore: () => void;
} {
  const cache: MockCache = {
    matched: new Set(alreadyCached),
    added: [],
    add: vi.fn(),
  };
  cache.add.mockImplementation(async (url: string) => {
    cache.added.push(url);
    cache.matched.add(url);
  });
  const fakeCache = {
    match: vi.fn(async (url: string) =>
      cache.matched.has(url) ? new Response("cached") : undefined,
    ),
    add: cache.add,
  };
  let opened: string | undefined;
  const open = vi.fn(async (name: string) => {
    opened = name;
    return fakeCache;
  });
  const original = (globalThis as { caches?: CacheStorage }).caches;
  (globalThis as { caches?: unknown }).caches = { open };
  return {
    cache,
    openName: () => opened,
    restore: () => {
      (globalThis as { caches?: unknown }).caches = original;
    },
  };
}

describe("image-cache — warmImageCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ouvre le cache partagé IMAGE_CACHE et ajoute les URLs absentes", async () => {
    const { cache, openName, restore } = mockCaches();
    await warmImageCache(["/api/img?u=A", "/api/img?u=B"]);
    expect(openName()).toBe(IMAGE_CACHE);
    expect(cache.added.sort()).toEqual(["/api/img?u=A", "/api/img?u=B"]);
    restore();
  });

  it("ne re-télécharge pas une URL déjà en cache (match)", async () => {
    const { cache, restore } = mockCaches(["/api/img?u=A"]);
    await warmImageCache(["/api/img?u=A", "/api/img?u=B"]);
    expect(cache.added).toEqual(["/api/img?u=B"]);
    restore();
  });

  it("best-effort : avale l'échec d'un add sans rejeter (offline)", async () => {
    const { cache, restore } = mockCaches();
    cache.add.mockRejectedValue(new Error("offline"));
    await expect(
      warmImageCache(["/api/img?u=A", "/api/img?u=B"]),
    ).resolves.toBeUndefined();
    restore();
  });

  it("no-op si Cache Storage indisponible (pas de caches)", async () => {
    const original = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = undefined;
    await expect(warmImageCache(["/api/img?u=A"])).resolves.toBeUndefined();
    (globalThis as { caches?: unknown }).caches = original;
  });

  it("no-op sur une liste vide (pas d'ouverture de cache)", async () => {
    const { openName, restore } = mockCaches();
    await warmImageCache([]);
    expect(openName()).toBeUndefined();
    restore();
  });
});

// --- reconcileImageCache : GC du Cache Storage par comptage de références (#81) ---

interface MockReconcileCache {
  keysUrls: string[];
  deleted: string[];
}

/** Faux `caches` dont le cache expose `keys()` (Request) et `delete(Request)`. */
function mockCachesForReconcile(cachedUrls: string[]): {
  state: MockReconcileCache;
  restore: () => void;
} {
  const state: MockReconcileCache = { keysUrls: cachedUrls, deleted: [] };
  const fakeCache = {
    keys: vi.fn(async () =>
      // Clés = Request d'URL **absolue** (comme le vrai Cache Storage).
      state.keysUrls.map((u) => new Request(`https://app.test${u}`)),
    ),
    delete: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      state.deleted.push(`${url.pathname}${url.search}`);
      return true;
    }),
  };
  const original = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = {
    open: vi.fn(async () => fakeCache),
  };
  return {
    state,
    restore: () => {
      (globalThis as { caches?: unknown }).caches = original;
    },
  };
}

describe("image-cache — reconcileImageCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supprime les images non référencées par aucun contenu restant", async () => {
    const { state, restore } = mockCachesForReconcile([
      "/api/img?u=A&sig=x",
      "/api/img?u=B&sig=y",
      "/api/img?u=C&sig=z",
    ]);
    // Seules A et C restent référencées (B a quitté le corpus → évincée).
    await reconcileImageCache(["/api/img?u=A&sig=x", "/api/img?u=C&sig=z"]);
    expect(state.deleted).toEqual(["/api/img?u=B&sig=y"]);
    restore();
  });

  it("conserve une image encore référencée par au moins un contenu (comptage par union)", async () => {
    const { state, restore } = mockCachesForReconcile(["/api/img?u=A&sig=x"]);
    // A est référencée → on ne supprime rien.
    await reconcileImageCache(["/api/img?u=A&sig=x"]);
    expect(state.deleted).toEqual([]);
    restore();
  });

  it("évince TOUT quand plus aucun contenu ne reste (référencées = ∅)", async () => {
    const { state, restore } = mockCachesForReconcile([
      "/api/img?u=A&sig=x",
      "/api/img?u=B&sig=y",
    ]);
    await reconcileImageCache([]);
    expect(state.deleted.sort()).toEqual([
      "/api/img?u=A&sig=x",
      "/api/img?u=B&sig=y",
    ]);
    restore();
  });

  it("no-op si Cache Storage indisponible (pas de caches)", async () => {
    const original = (globalThis as { caches?: unknown }).caches;
    (globalThis as { caches?: unknown }).caches = undefined;
    await expect(
      reconcileImageCache(["/api/img?u=A"]),
    ).resolves.toBeUndefined();
    (globalThis as { caches?: unknown }).caches = original;
  });
});
