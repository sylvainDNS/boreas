import type {
  ArticleCountsResponse,
  ArticleListResponse,
} from "@boreas/api-contracts";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleListView } from "../components/ArticleListView";
import type { ApiHandlerContext } from "../test/api-mock";
import { stubApi } from "../test/api-mock";
import { createAppWrapper } from "../test/render";
import { apiFetch } from "./api";
import type { ArticleView } from "./use-article-view";
import { useArticleView } from "./use-article-view";

// `vi.mock` reste dans le fichier de test (hoisting Vitest, convention du repo).
vi.mock("./api", async (importActual) => {
  const actual = await importActual<typeof import("./api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

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
    read: false,
    saved: false,
    ...overrides,
  };
}

/** Page de liste. */
function page(
  articles: ArticleListResponse["articles"],
  nextCursor: string | null = null,
): ArticleListResponse {
  return { articles, nextCursor };
}

const emptyCounts: ArticleCountsResponse = {
  total: 0,
  byFeed: [],
  byFolder: [],
};

describe("useArticleView", () => {
  it("scope all : titre, filtre, compteur, toggle showRead → filter=unread", async () => {
    const urls: string[] = [];
    stubApi(mockedFetch, {
      "GET /articles": ({ url }: ApiHandlerContext) => {
        urls.push(url);
        return page([item("a1")]);
      },
      "GET /articles/counts": {
        ...emptyCounts,
        total: 7,
      } satisfies ArticleCountsResponse,
    });

    const { result } = renderHook(() => useArticleView({ kind: "all" }), {
      wrapper: createAppWrapper(),
    });

    await waitFor(() => expect(result.current.articles).toHaveLength(1));
    expect(result.current.title).toBe("Tous les non-lus");
    expect(result.current.unreadCount).toBe(7);
    // showRead actif par défaut → filter=all
    expect(result.current.showRead).toBe(true);
    expect(urls.some((u) => u.includes("filter=all"))).toBe(true);

    // Bascule : masque les lus → nouvelle requête filter=unread
    act(() => result.current.onToggleShowRead?.());
    await waitFor(() =>
      expect(urls.some((u) => u.includes("filter=unread"))).toBe(true),
    );
    expect(result.current.showRead).toBe(false);
    expect(result.current.emptyLabel).toBe("Tout est lu 🎉");
  });

  it("scope all : onRefresh poste /refresh ; onMarkAllRead poste scope global", async () => {
    const calls: { path: string; body: unknown }[] = [];
    stubApi(mockedFetch, {
      "GET /articles": page([item("a1")]),
      "GET /articles/counts": emptyCounts,
      "POST /refresh": ({ url }: ApiHandlerContext) => {
        calls.push({ path: url, body: undefined });
        return { enqueued: 1 };
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

  it("scope feed : libellé, scope feedId, markAllRead scope feed, pas de showRead/refresh", async () => {
    const urls: string[] = [];
    const markBodies: unknown[] = [];
    stubApi(mockedFetch, {
      "GET /articles": ({ url }: ApiHandlerContext) => {
        urls.push(url);
        return page([item("a1")]);
      },
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
    expect(urls.some((u) => u.includes("feedId=f1"))).toBe(true);
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
      "GET /articles": page([]),
      "GET /feeds": { feeds: [] },
    });

    const { result } = renderHook(
      () => useArticleView({ kind: "feed", feedId: "ghost" }),
      { wrapper: createAppWrapper() },
    );

    await waitFor(() => expect(result.current.title).toBe("Flux introuvable"));
    expect(result.current.emptyLabel).toBe("Ce flux n'existe pas ou plus.");
  });

  it("scope folder : nom, unreadCount via byFolder, markAllRead scope folder", async () => {
    const urls: string[] = [];
    const markBodies: unknown[] = [];
    stubApi(mockedFetch, {
      "GET /articles": ({ url }: ApiHandlerContext) => {
        urls.push(url);
        return page([item("a1")]);
      },
      "GET /folders": { folders: [{ id: "fo1", name: "Tech" }] },
      "GET /articles/counts": {
        total: 0,
        byFeed: [],
        byFolder: [{ folderId: "fo1", count: 4 }],
      } satisfies ArticleCountsResponse,
      "POST /articles/mark-read": ({ body }: ApiHandlerContext) => {
        markBodies.push(body);
        return { updated: 4 };
      },
    });

    const { result } = renderHook(
      () => useArticleView({ kind: "folder", folderId: "fo1" }),
      { wrapper: createAppWrapper() },
    );

    await waitFor(() => expect(result.current.title).toBe("Tech"));
    await waitFor(() => expect(result.current.unreadCount).toBe(4));
    expect(urls.some((u) => u.includes("folderId=fo1"))).toBe(true);

    act(() => result.current.onMarkAllRead?.());
    await waitFor(() =>
      expect(markBodies).toContainEqual({ scope: "folder", folderId: "fo1" }),
    );
  });

  it("scope folder : dossier introuvable", async () => {
    stubApi(mockedFetch, {
      "GET /articles": page([]),
      "GET /folders": { folders: [] },
      "GET /articles/counts": emptyCounts,
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

  it("scope saved : filter=saved, pas de toggleRead/markAllRead/showRead", async () => {
    const urls: string[] = [];
    stubApi(mockedFetch, {
      "GET /articles": ({ url }: ApiHandlerContext) => {
        urls.push(url);
        return page([item("s1", { saved: true })]);
      },
    });

    const { result } = renderHook(() => useArticleView({ kind: "saved" }), {
      wrapper: createAppWrapper(),
    });

    await waitFor(() => expect(result.current.articles).toHaveLength(1));
    expect(result.current.title).toBe("Saved");
    expect(urls.some((u) => u.includes("filter=saved"))).toBe(true);
    expect(result.current.onToggleRead).toBeUndefined();
    expect(result.current.onMarkAllRead).toBeUndefined();
    expect(result.current.showRead).toBeUndefined();
    expect(result.current.onToggleSaved).toBeDefined();
  });

  it("pagination : onEndReached charge la page suivante (cursor)", async () => {
    const urls: string[] = [];
    stubApi(mockedFetch, {
      "GET /articles": ({ url }: ApiHandlerContext) => {
        urls.push(url);
        if (url.includes("cursor=c1")) return page([item("a2")]);
        return page([item("a1")], "c1");
      },
      "GET /articles/counts": emptyCounts,
    });

    const { result } = renderHook(() => useArticleView({ kind: "all" }), {
      wrapper: createAppWrapper(),
    });

    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    act(() => result.current.onEndReached());
    await waitFor(() => expect(result.current.articles).toHaveLength(2));
    expect(urls.some((u) => u.includes("cursor=c1"))).toBe(true);
  });

  it("scope saved : unsave retire l'article de la vue", async () => {
    // Stub avec état serveur : une fois désauvé, l'article ne fait plus partie
    // de la liste `filter=saved` (le `onSettled` réaligne la vue sur le serveur).
    const saved = new Set(["s1"]);
    stubApi(mockedFetch, {
      "GET /articles": () =>
        page([...saved].map((id) => item(id, { saved: true }))),
      "PATCH /articles/:id": ({ params, body }: ApiHandlerContext) => {
        const patch = body as { saved?: boolean };
        if (patch.saved === false) saved.delete(params.id);
        return { id: params.id, ...patch };
      },
    });

    const { result } = renderHook(() => useArticleView({ kind: "saved" }), {
      wrapper: createAppWrapper(),
    });

    await waitFor(() => expect(result.current.articles).toHaveLength(1));
    act(() => result.current.onToggleSaved?.("s1", false));
    await waitFor(() => expect(result.current.articles).toHaveLength(0));
  });
});

describe("<ArticleListView view />", () => {
  it("smoke : rend titre et état vide depuis le view fourni", () => {
    const view: ArticleView = {
      title: "Tous les non-lus",
      emptyLabel: "Tout est lu 🎉",
      articles: [],
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      onEndReached: () => {},
      onToggleSaved: () => {},
    };
    render(<ArticleListView view={view} />);
    expect(
      screen.getByRole("heading", { name: "Tous les non-lus" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Tout est lu 🎉")).toBeInTheDocument();
  });
});
