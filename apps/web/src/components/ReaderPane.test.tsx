import "fake-indexeddb/auto";
import type { ArticleListItem } from "@boreas/api-contracts";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../lib/api";
import { toArticle } from "../lib/articles";
import { readOutbox } from "../lib/sync/outbox-store";
import { getReplica, resetReplicaSingleton } from "../lib/sync/replica";
import {
  applyDelta,
  deleteReplica,
  writeArticleContent,
} from "../lib/sync/replica-store";
import type { ApiHandlerContext } from "../test/api-mock";
import { stubApi } from "../test/api-mock";
import { renderWithApp } from "../test/render";
import { ReaderPane } from "./ReaderPane";

// `apiFetch` mocké (table de routes) ; `syncReplica` neutralisé (le flush
// best-effort ne doit pas toucher au réseau dans ces tests).
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("../lib/sync/replica", async (importActual) => {
  const actual = await importActual<typeof import("../lib/sync/replica")>();
  return { ...actual, syncReplica: vi.fn(async () => {}) };
});

const mockedFetch = vi.mocked(apiFetch);

function item(
  over: Partial<ArticleListItem> & { id: string },
): ArticleListItem {
  return {
    id: over.id,
    feedId: over.feedId ?? "f1",
    feedName: over.feedName ?? "Flux 1",
    title: over.title ?? `Titre ${over.id}`,
    summary: over.summary ?? null,
    link: over.link ?? null,
    publishedAt: over.publishedAt ?? null,
    fetchedAt: over.fetchedAt ?? "2026-06-05T12:00:00Z",
    read: over.read ?? false,
    saved: over.saved ?? false,
  };
}

async function seedReplica(articles: ArticleListItem[]): Promise<void> {
  const db = await getReplica();
  await applyDelta(db, {
    upserts: { articles, feeds: [], folders: [] },
    tombstones: [],
  });
}

beforeEach(async () => {
  await deleteReplica();
  resetReplicaSingleton();
  mockedFetch.mockReset();
});

afterEach(() => {
  resetReplicaSingleton();
});

describe("ReaderPane — détail local-first (#75, AC#3)", () => {
  it("ouvre un article jamais ouvert HORS-LIGNE depuis le réplica + content", async () => {
    // Hors-ligne : tout appel API rejette. Le détail doit venir du local.
    mockedFetch.mockRejectedValue(new Error("offline"));
    await seedReplica([item({ id: "a1", title: "Le vent du nord" })]);
    const db = await getReplica();
    await writeArticleContent(db, "a1", "<p>Contenu hors-ligne</p>");

    const { client } = renderWithApp(<ReaderPane articleId="a1" />);

    expect(
      await screen.findByRole("heading", { name: "Le vent du nord" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Contenu hors-ligne")).toBeInTheDocument();
    // Aucun appel API : le détail est purement local.
    expect(mockedFetch).not.toHaveBeenCalled();

    // Ce non-lu déclenche la mutation Read d'ouverture (#75), asynchrone et non
    // observée par les assertions ci-dessus. On attend sa résolution complète :
    // sinon, sous le timing CI, sa transition `success` re-rend ReaderPane hors
    // d'un `act(...)` et React émet un warning. `waitFor` sonde dans `act`, donc
    // la transition est forcément flushée dans `act` quand le compteur tombe à 0.
    await waitFor(() => expect(client.isMutating()).toBe(0));
  });

  it("retombe sur l'API quand l'article n'est pas dans le corpus local", async () => {
    stubApi(mockedFetch, {
      "GET /articles/:id": ({ params }: ApiHandlerContext) => ({
        id: params.id as string,
        feedId: "f-distant",
        feedName: "Flux distant",
        title: "Article distant",
        link: null,
        publishedAt: null,
        content: "<p>via API</p>",
        saved: false,
        unread: false,
      }),
    });

    renderWithApp(<ReaderPane articleId="x1" />);

    expect(
      await screen.findByRole("heading", { name: "Article distant" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("via API")).toBeInTheDocument();
  });
});

describe("ReaderPane — Read à l'ouverture côté client (#75, AC#4)", () => {
  it("marque Read au réplica + empile l'outbox en ouvrant un non-lu", async () => {
    mockedFetch.mockRejectedValue(new Error("offline"));
    await seedReplica([item({ id: "a1", read: false })]);
    const db = await getReplica();
    await writeArticleContent(db, "a1", "<p>x</p>");

    const { client } = renderWithApp(
      <ReaderPane
        articleId="a1"
        listItem={toArticle(item({ id: "a1", read: false }))}
      />,
    );

    // Attend le rendu du contenu (import lazy d'`ArticleContent`) pour que sa
    // résolution Suspense soit flushée dans `act(...)` et ne traîne pas après la
    // fin du test — sinon React émet « update ... not wrapped in act(...) »
    // (cf. les autres tests qui attendent le contenu).
    await screen.findByText("x");

    // Le réplica passe Read (vue non-lus local-first) et l'outbox empile le patch.
    await waitFor(async () => {
      expect((await db.get("articles", "a1"))?.read).toBe(true);
    });
    const outbox = await readOutbox(db);
    expect(outbox).toEqual([
      expect.objectContaining({
        kind: "patch",
        articleId: "a1",
        field: "read",
        value: true,
      }),
    ]);
    // Le `waitFor` ci-dessus n'observe que l'écriture réplica (faite dans
    // `onMutate`, avant la fin de la mutation). On attend le règlement complet,
    // sinon la transition `success` re-rend ReaderPane hors `act(...)`.
    await waitFor(() => expect(client.isMutating()).toBe(0));
  });

  it("n'empile RIEN en ouvrant un article déjà lu", async () => {
    mockedFetch.mockRejectedValue(new Error("offline"));
    await seedReplica([item({ id: "a1", read: true })]);
    const db = await getReplica();
    await writeArticleContent(db, "a1", "<p>x</p>");

    renderWithApp(
      <ReaderPane
        articleId="a1"
        listItem={toArticle(item({ id: "a1", read: true }))}
      />,
    );

    await screen.findByText("x");
    // Pas de mutation Read superflue → outbox vide.
    expect(await readOutbox(db)).toHaveLength(0);
  });
});
