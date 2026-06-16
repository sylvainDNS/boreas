import "fake-indexeddb/auto";
import type {
  ArticleListResponse,
  SyncFeed,
  SyncFolder,
} from "@boreas/api-contracts";
import { renderHook, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArticleListView } from "../components/ArticleListView";
import type { ApiHandlerContext } from "../test/api-mock";
import { stubApi } from "../test/api-mock";
import { createAppWrapper, renderWithApp } from "../test/render";
import { apiFetch } from "./api";
import { toArticle } from "./articles";
import { resetReplicaSingleton } from "./sync/replica";
import { applyDelta, deleteReplica, openReplica } from "./sync/replica-store";
import type { ArticleView } from "./use-article-view";
import { useArticleView } from "./use-article-view";

// `vi.mock` reste dans le fichier de test (hoisting Vitest, convention du repo).
vi.mock("./api", async (importActual) => {
  const actual = await importActual<typeof import("./api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

beforeEach(async () => {
  // Réplica vierge entre tests : toutes les vues lisent le store local (#73).
  await deleteReplica();
  resetReplicaSingleton();
});

afterEach(() => {
  mockedFetch.mockReset();
  resetReplicaSingleton();
});

/**
 * Pré-remplit le réplica local (articles + feeds + folders). Toutes les vues
 * étant local-first (#73), c'est la source de vérité de la liste **et** des
 * compteurs ; l'API n'est mockée que pour les mutations et les queries annexes
 * (feeds/folders, encore servies par l'API pour la résolution du libellé).
 */
async function seedReplica(
  articles: ArticleListResponse["articles"],
  feeds: SyncFeed[] = [],
  folders: SyncFolder[] = [],
): Promise<void> {
  const db = await openReplica();
  await applyDelta(db, {
    upserts: { articles, feeds, folders },
    tombstones: [],
  });
  db.close();
}

/** Item de liste wire minimal, surchargeable. */
function item(
  id: string,
  overrides: Partial<ArticleListResponse["articles"][number]> = {},
): ArticleListResponse["articles"][number] {
  return {
    id,
    feedId: "f1",
    feedName: "Flux 1",
    title: `Titre ${id}`,
    summary: "résumé",
    link: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    read: false,
    saved: false,
    ...overrides,
  };
}

/** Feed répliqué minimal, surchargeable. */
function syncFeed(over: Partial<SyncFeed> & { id: string }): SyncFeed {
  return {
    id: over.id,
    url: over.url ?? `https://src.example/${over.id}.xml`,
    title: over.title ?? `Flux ${over.id}`,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId: over.folderId ?? null,
    unsubscribed: over.unsubscribed ?? false,
  };
}

describe("useArticleView", () => {
  it("scope all : filter=all lit le réplica ; toggle showRead → non-lus depuis le réplica (#73)", async () => {
    // Réplica : un lu + un non-lu. Tout est local-first (liste ET compteurs).
    await seedReplica(
      [item("a-read", { read: true }), item("a-unread", { read: false })],
      [syncFeed({ id: "f1" })],
    );

    const urls: string[] = [];
    // Aucune route liste/counts mockée : un appel à l'API ferait échouer le test
    // (cf. stubApi qui rejette les routes inattendues) — c'est la garantie AC#4.
    stubApi(mockedFetch, {});
    mockedFetch.mockImplementation((path: string) => {
      urls.push(path);
      return Promise.reject(new Error(`appel API inattendu : ${path}`));
    });

    const { result } = renderHook(() => useArticleView({ kind: "all" }), {
      wrapper: createAppWrapper(),
    });

    // showRead actif par défaut → filtre `all` : lus + non-lus depuis le réplica.
    await waitFor(() => expect(result.current.articles).toHaveLength(2));
    expect(result.current.title).toBe("Tous les non-lus");
    // Compteur global exact, calculé localement (un seul non-lu).
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    expect(result.current.showRead).toBe(true);

    // Bascule : masque les lus → filtre `unread`, lu depuis le réplica.
    act(() => result.current.onToggleShowRead?.());
    await waitFor(() =>
      expect(result.current.articles.map((a) => a.id)).toEqual(["a-unread"]),
    );
    expect(result.current.showRead).toBe(false);
    // Aucun appel liste/counts : les vues ne touchent plus le réseau (AC#4).
    expect(urls.some((u) => u.startsWith("/articles"))).toBe(false);
  });

  it("scope all : onRefresh poste /refresh ; onMarkAllRead poste scope global", async () => {
    await seedReplica([item("a1")], [syncFeed({ id: "f1" })]);
    const calls: { path: string; body: unknown }[] = [];
    stubApi(mockedFetch, {
      "POST /refresh": ({ url }: ApiHandlerContext) => {
        calls.push({ path: url, body: undefined });
        return { enqueued: 1 };
      },
      // mark-all-read est local-first : la mutation flushe via syncReplica, dont
      // le pull tombe sur /sync (page vide) ; mark-read part par l'outbox au flush.
      "GET /sync": {
        upserts: { articles: [], feeds: [], folders: [] },
        tombstones: [],
        cursor: null,
        complete: true,
        stale: false,
      },
      "POST /articles/mark-read": ({ body, url }: ApiHandlerContext) => {
        calls.push({ path: url, body });
        return { updated: 1 };
      },
    });

    const { result } = renderHook(() => useArticleView({ kind: "all" }), {
      wrapper: createAppWrapper(),
    });
    await waitFor(() => expect(result.current.articles).toHaveLength(1));

    act(() => result.current.onRefresh?.());
    act(() => result.current.onMarkAllRead?.());

    await waitFor(() =>
      expect(calls.map((c) => c.path)).toEqual(
        expect.arrayContaining(["/refresh", "/articles/mark-read"]),
      ),
    );
    expect(calls.find((c) => c.path === "/articles/mark-read")?.body).toEqual({
      scope: "global",
    });
  });

  it("scope feed : libellé, articles du feed, markAllRead scope feed, pas de showRead/refresh", async () => {
    await seedReplica(
      [item("a-f1", { feedId: "f1" }), item("a-f2", { feedId: "f2" })],
      [syncFeed({ id: "f1", title: "Mon flux" }), syncFeed({ id: "f2" })],
    );
    const markBodies: unknown[] = [];
    stubApi(mockedFetch, {
      "GET /feeds": {
        feeds: [
          {
            id: "f1",
            url: "https://x",
            title: "Mon flux",
            folderId: null,
            status: "ok",
            lastError: null,
          },
        ],
      },
      "GET /sync": {
        upserts: { articles: [], feeds: [], folders: [] },
        tombstones: [],
        cursor: null,
        complete: true,
        stale: false,
      },
      "POST /articles/mark-read": ({ body }: ApiHandlerContext) => {
        markBodies.push(body);
        return { updated: 2 };
      },
    });

    const { result } = renderHook(
      () => useArticleView({ kind: "feed", feedId: "f1" }),
      { wrapper: createAppWrapper() },
    );

    await waitFor(() => expect(result.current.title).toBe("Mon flux"));
    // La vue par Feed ne montre que les articles de f1 (réplica filtré localement).
    await waitFor(() =>
      expect(result.current.articles.map((a) => a.id)).toEqual(["a-f1"]),
    );
    expect(result.current.showRead).toBeUndefined();
    expect(result.current.onToggleShowRead).toBeUndefined();
    expect(result.current.onRefresh).toBeUndefined();

    act(() => result.current.onMarkAllRead?.());
    await waitFor(() =>
      expect(markBodies).toContainEqual({ scope: "feed", feedId: "f1" }),
    );
  });

  it("scope feed : flux introuvable", async () => {
    stubApi(mockedFetch, {
      "GET /feeds": { feeds: [] },
    });

    const { result } = renderHook(
      () => useArticleView({ kind: "feed", feedId: "ghost" }),
      { wrapper: createAppWrapper() },
    );

    await waitFor(() => expect(result.current.title).toBe("Flux introuvable"));
    expect(result.current.emptyLabel).toBe("Ce flux n'existe pas ou plus.");
  });

  it("scope folder : nom, articles agrégés, unreadCount local via byFolder, markAllRead scope folder", async () => {
    await seedReplica(
      [
        item("a-fa", { feedId: "fa" }),
        item("a-fb", { feedId: "fb" }),
        item("a-fc", { feedId: "fc" }),
      ],
      [
        syncFeed({ id: "fa", folderId: "fo1" }),
        syncFeed({ id: "fb", folderId: "fo1" }),
        syncFeed({ id: "fc", folderId: "fo2" }),
      ],
      [
        { id: "fo1", name: "Tech" },
        { id: "fo2", name: "Autre" },
      ],
    );
    const markBodies: unknown[] = [];
    stubApi(mockedFetch, {
      "GET /folders": { folders: [{ id: "fo1", name: "Tech" }] },
      "GET /sync": {
        upserts: { articles: [], feeds: [], folders: [] },
        tombstones: [],
        cursor: null,
        complete: true,
        stale: false,
      },
      "POST /articles/mark-read": ({ body }: ApiHandlerContext) => {
        markBodies.push(body);
        return { updated: 2 };
      },
    });

    const { result } = renderHook(
      () => useArticleView({ kind: "folder", folderId: "fo1" }),
      { wrapper: createAppWrapper() },
    );

    await waitFor(() => expect(result.current.title).toBe("Tech"));
    // Agrégat local des feeds du dossier (fa + fb), fc exclu.
    await waitFor(() =>
      expect(result.current.articles.map((a) => a.id).sort()).toEqual([
        "a-fa",
        "a-fb",
      ]),
    );
    // unreadCount = compteur local byFolder (2 non-lus dans fo1).
    await waitFor(() => expect(result.current.unreadCount).toBe(2));

    act(() => result.current.onMarkAllRead?.());
    await waitFor(() =>
      expect(markBodies).toContainEqual({ scope: "folder", folderId: "fo1" }),
    );
  });

  it("scope folder : dossier introuvable", async () => {
    stubApi(mockedFetch, {
      "GET /folders": { folders: [] },
    });

    const { result } = renderHook(
      () => useArticleView({ kind: "folder", folderId: "ghost" }),
      { wrapper: createAppWrapper() },
    );

    await waitFor(() =>
      expect(result.current.title).toBe("Dossier introuvable"),
    );
    expect(result.current.emptyLabel).toBe("Ce dossier n'existe pas ou plus.");
  });

  it("scope saved : ne montre que les Saved (réplica), pas de toggleRead/markAllRead/showRead", async () => {
    await seedReplica(
      [item("s1", { saved: true }), item("not-saved", { saved: false })],
      [syncFeed({ id: "f1" })],
    );
    stubApi(mockedFetch, {});

    const { result } = renderHook(() => useArticleView({ kind: "saved" }), {
      wrapper: createAppWrapper(),
    });

    await waitFor(() =>
      expect(result.current.articles.map((a) => a.id)).toEqual(["s1"]),
    );
    expect(result.current.title).toBe("Saved");
    expect(result.current.onToggleRead).toBeUndefined();
    expect(result.current.onMarkAllRead).toBeUndefined();
    expect(result.current.showRead).toBeUndefined();
    expect(result.current.onToggleSaved).toBeDefined();
  });

  it("pagination : onEndReached charge la page suivante depuis le réplica", async () => {
    // Un corpus > 1 page (PAGE_SIZE=30) répliqué localement : la pagination
    // keyset locale doit servir la 2ᵉ page sans appel réseau.
    const articles = Array.from({ length: 35 }, (_, i) =>
      item(`art-${String(i).padStart(2, "0")}`, {
        publishedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    await seedReplica(articles, [syncFeed({ id: "f1" })]);
    stubApi(mockedFetch, {});

    const { result } = renderHook(() => useArticleView({ kind: "all" }), {
      wrapper: createAppWrapper(),
    });

    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    expect(result.current.articles).toHaveLength(30);
    act(() => result.current.onEndReached());
    await waitFor(() => expect(result.current.articles).toHaveLength(35));
  });

  it("scope saved : unsave retire l'article de la vue (réplica relu)", async () => {
    await seedReplica([item("s1", { saved: true })], [syncFeed({ id: "f1" })]);
    // La mutation Saved écrit le réplica (saved=false) puis flushe ; le pull /sync
    // est vide. La vue saved relit le réplica → l'article désauvé en disparaît.
    stubApi(mockedFetch, {
      "GET /sync": {
        upserts: { articles: [], feeds: [], folders: [] },
        tombstones: [],
        cursor: null,
        complete: true,
        stale: false,
      },
      "PATCH /articles/:id": ({ params, body }: ApiHandlerContext) => ({
        id: params.id as string,
        ...(body as Record<string, unknown>),
      }),
    });

    const { result } = renderHook(() => useArticleView({ kind: "saved" }), {
      wrapper: createAppWrapper(),
    });

    await waitFor(() => expect(result.current.articles).toHaveLength(1));
    act(() => result.current.onToggleSaved?.("s1", false));
    await waitFor(() => expect(result.current.articles).toHaveLength(0));
  });
});

/** `ArticleView` minimal surchargeable (la liste attend le modèle de vue). */
function baseView(articles: ArticleView["articles"] = []): ArticleView {
  return {
    title: "Tous les non-lus",
    emptyLabel: "Tout est lu 🎉",
    articles,
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    onEndReached: () => {},
    onToggleSaved: () => {},
  };
}

describe("<ArticleListView view />", () => {
  it("smoke : rend titre et état vide depuis le view fourni", async () => {
    renderWithApp(<ArticleListView view={baseView()} />);
    expect(
      await screen.findByRole("heading", { name: "Tous les non-lus" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Tout est lu 🎉")).toBeInTheDocument();
  });

  it("ouvrir un Article pousse `?article` dans l'URL (back système → liste)", async () => {
    stubApi(mockedFetch, {
      "GET /articles/:id": ({ params }: ApiHandlerContext) => ({
        id: params.id as string,
        feedId: "f1",
        feedName: "Flux 1",
        title: "Titre a1",
        link: null,
        publishedAt: null,
        content: "<p>corps</p>",
        saved: false,
        unread: true,
      }),
    });
    const view = baseView([toArticle(item("a1"))]);
    const { user, router, client } = renderWithApp(
      <ArticleListView view={view} />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Lire : Titre a1" }),
    );
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ article: "a1" }),
    );
    // Attend le contenu (import lazy d'`ArticleContent`) pour flusher sa
    // résolution Suspense dans `act(...)`, puis le règlement de la mutation Read
    // d'ouverture (#75) : sans quoi un re-rendu de ReaderPane traîne hors
    // `act(...)` et React émet « update ... not wrapped in act(...) ».
    await screen.findByText("corps");
    await waitFor(() => expect(client.isMutating()).toBe(0));
  });

  it("deep-link : Article hors de la liste chargée → lecteur via la query détail", async () => {
    stubApi(mockedFetch, {
      "GET /articles/:id": ({ params }: ApiHandlerContext) => ({
        id: params.id as string,
        feedId: "f-distant",
        feedName: "Flux distant",
        title: "Article distant",
        link: null,
        publishedAt: "2026-01-01T00:00:00.000Z",
        content: "<p>contenu plein</p>",
        saved: false,
        unread: false,
      }),
    });
    // Liste vide : l'article ouvert n'y figure pas (refresh sur article paginé).
    renderWithApp(<ArticleListView view={baseView()} />, {
      initialPath: "/?article=x1",
    });

    expect(
      await screen.findByRole("heading", { name: "Article distant" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Flux distant")).toBeInTheDocument();
    // Attend le contenu plein (import lazy d'`ArticleContent`) : flushe sa
    // résolution Suspense dans `act(...)` (évite le warning React) et vérifie que
    // le deep-link affiche bien le corps via la query détail.
    expect(await screen.findByText("contenu plein")).toBeInTheDocument();
  });

  it("deep-link : sauvegarder met à jour l'étoile du lecteur (cache détail patché)", async () => {
    stubApi(mockedFetch, {
      "GET /articles/:id": ({ params }: ApiHandlerContext) => ({
        id: params.id as string,
        feedId: "f-distant",
        feedName: "Flux distant",
        title: "Article distant",
        link: null,
        publishedAt: null,
        content: "<p>contenu plein</p>",
        saved: false,
        unread: false,
      }),
      "PATCH /articles/:id": ({ params, body }: ApiHandlerContext) => ({
        id: params.id as string,
        ...(body as Record<string, unknown>),
      }),
    });
    // Article hors liste : `saved` provient du cache détail, jamais d'un cache
    // de liste — le flip doit donc patcher la query détail (régression #review).
    const { user, client } = renderWithApp(
      <ArticleListView view={baseView()} />,
      {
        initialPath: "/?article=x1",
      },
    );

    // Attend le contenu lazy avant d'interagir : flushe la résolution Suspense
    // d'`ArticleContent` dans `act(...)` (évite le warning React).
    await screen.findByText("contenu plein");
    await user.click(
      await screen.findByRole("button", { name: "☆ Sauvegarder" }),
    );
    expect(
      await screen.findByRole("button", { name: "★ Sauvegardé" }),
    ).toBeInTheDocument();
    // `findByRole` résout sur le flip optimiste (`onMutate`) ; la mutation
    // continue de se régler ensuite (PATCH + invalidations). On l'attend pour que
    // sa transition finale soit flushée dans `act(...)` (évite le warning React).
    await waitFor(() => expect(client.isMutating()).toBe(0));
  });
});
