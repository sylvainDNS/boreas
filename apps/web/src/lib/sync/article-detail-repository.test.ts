import "fake-indexeddb/auto";
import type { SyncArticle } from "@boreas/api-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readArticleDetail } from "./article-detail-repository";
import {
  applyDelta,
  deleteReplica,
  openReplica,
  type ReplicaDb,
  writeArticleContent,
} from "./replica-store";

function article(over: Partial<SyncArticle> & { id: string }): SyncArticle {
  return {
    id: over.id,
    feedId: over.feedId ?? "feed-1",
    feedName: over.feedName ?? "Mon flux",
    title: over.title ?? `Titre ${over.id}`,
    summary: over.summary ?? null,
    link: over.link ?? "https://src.example/a",
    publishedAt: over.publishedAt ?? "2026-06-05T00:00:00Z",
    fetchedAt: over.fetchedAt ?? "2026-06-05T12:00:00Z",
    read: over.read ?? false,
    saved: over.saved ?? false,
  };
}

async function seed(articles: SyncArticle[]): Promise<void> {
  await applyDelta(db, {
    upserts: { articles, feeds: [], folders: [] },
    tombstones: [],
  });
}

let db: ReplicaDb;

beforeEach(async () => {
  await deleteReplica();
  db = await openReplica();
});

afterEach(() => {
  db.close();
});

describe("article-detail-repository — readArticleDetail (#75)", () => {
  it("rend la forme ArticleDetailResponse depuis réplica + content (offline)", async () => {
    await seed([
      article({
        id: "a1",
        feedId: "f1",
        feedName: "Mon flux",
        title: "Le vent",
        link: "https://src/a1",
        publishedAt: "2026-06-01T00:00:00Z",
        read: false,
        saved: true,
      }),
    ]);
    await writeArticleContent(db, "a1", "<p>Bonjour</p>");

    expect(await readArticleDetail(db, "a1")).toEqual({
      id: "a1",
      feedId: "f1",
      feedName: "Mon flux",
      title: "Le vent",
      link: "https://src/a1",
      publishedAt: "2026-06-01T00:00:00Z",
      content: "<p>Bonjour</p>",
      saved: true,
      unread: true,
    });
  });

  it("unread reflète l'état Read local (article lu → unread:false)", async () => {
    await seed([article({ id: "a1", read: true })]);
    await writeArticleContent(db, "a1", "<p>x</p>");

    expect((await readArticleDetail(db, "a1"))?.unread).toBe(false);
  });

  it("content présent mais null (article sans extraction) → détail valide content:null", async () => {
    await seed([article({ id: "a1" })]);
    await writeArticleContent(db, "a1", null);

    const detail = await readArticleDetail(db, "a1");
    expect(detail).not.toBeNull();
    expect(detail?.content).toBeNull();
  });

  it("retourne null si l'article n'est pas dans le réplica (fallback API)", async () => {
    expect(await readArticleDetail(db, "absent")).toBeNull();
  });

  it("retourne null si le contenu n'a jamais été téléchargé (fallback API)", async () => {
    // Métadonnées présentes mais aucun contenu en store (undefined ≠ null).
    await seed([article({ id: "a1" })]);
    expect(await readArticleDetail(db, "a1")).toBeNull();
  });
});
