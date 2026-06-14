import "fake-indexeddb/auto";
import type { SyncArticle, SyncFeed } from "@boreas/api-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDelta,
  deleteReplica,
  openReplica,
  type ReplicaDb,
} from "./replica-store";
import { readUnreadPage, UNREAD_PAGE_SIZE } from "./unread-repository";

function article(over: Partial<SyncArticle> & { id: string }): SyncArticle {
  return {
    id: over.id,
    feedId: over.feedId ?? "feed-1",
    feedName: over.feedName ?? "Mon flux",
    title: over.title ?? `Titre ${over.id}`,
    summary: over.summary ?? null,
    link: over.link ?? null,
    publishedAt: over.publishedAt ?? null,
    fetchedAt: over.fetchedAt ?? "2026-06-05T12:00:00Z",
    read: over.read ?? false,
    saved: over.saved ?? false,
  };
}

function feed(over: Partial<SyncFeed> & { id: string }): SyncFeed {
  return {
    id: over.id,
    url: over.url ?? `https://src.example/${over.id}.xml`,
    title: over.title ?? `Flux ${over.id}`,
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId: null,
    unsubscribed: over.unsubscribed ?? false,
  };
}

let db: ReplicaDb;

beforeEach(async () => {
  await deleteReplica();
  db = await openReplica();
});

afterEach(() => {
  db.close();
});

async function seed(articles: SyncArticle[], feeds: SyncFeed[] = []) {
  await applyDelta(db, {
    upserts: { articles, feeds, folders: [] },
    tombstones: [],
  });
}

describe("unread-repository — filtre non-lus", () => {
  it("ne renvoie que les articles non-lus", async () => {
    await seed([
      article({ id: "a-unread", read: false }),
      article({ id: "a-read", read: true }),
    ]);
    const page = await readUnreadPage(db, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["a-unread"]);
  });

  it("expose la même forme que ArticleListResponse (item wire + nextCursor)", async () => {
    await seed([article({ id: "a1", read: false, saved: true })]);
    const page = await readUnreadPage(db, undefined);
    expect(page).toHaveProperty("nextCursor");
    expect(page.articles[0]).toMatchObject({
      id: "a1",
      feedId: "feed-1",
      feedName: "Mon flux",
      read: false,
      saved: true,
    });
  });
});

describe("unread-repository — tri (ADR 0015)", () => {
  it("trie par coalesce(publishedAt, fetchedAt) desc puis id desc", async () => {
    await seed([
      article({ id: "old", publishedAt: "2026-01-01T00:00:00Z" }),
      article({ id: "new", publishedAt: "2026-06-04T00:00:00Z" }),
      article({ id: "mid", publishedAt: "2026-03-01T00:00:00Z" }),
    ]);
    const page = await readUnreadPage(db, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["new", "mid", "old"]);
  });

  it("retombe sur fetchedAt quand publishedAt est null", async () => {
    await seed([
      article({
        id: "dated",
        publishedAt: "2026-02-01T00:00:00Z",
        fetchedAt: "2026-06-01T00:00:00Z",
      }),
      article({
        id: "nodate",
        publishedAt: null,
        fetchedAt: "2026-06-09T00:00:00Z",
      }),
    ]);
    const page = await readUnreadPage(db, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["nodate", "dated"]);
  });

  it("départage par id desc à sortKey égal", async () => {
    await seed([
      article({ id: "aaa", publishedAt: "2026-05-01T00:00:00Z" }),
      article({ id: "zzz", publishedAt: "2026-05-01T00:00:00Z" }),
    ]);
    const page = await readUnreadPage(db, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["zzz", "aaa"]);
  });
});

describe("unread-repository — feeds désabonnés", () => {
  it("exclut les articles d'un feed désabonné (cohérent avec l'API)", async () => {
    await seed(
      [
        article({ id: "a-on", feedId: "feed-on", read: false }),
        // Saved + non-lu dans un feed désabonné : exclu de la river non-lus,
        // exactement comme l'API (la vue Saved, hors scope #72, le garderait).
        article({ id: "a-off", feedId: "feed-off", read: false, saved: true }),
      ],
      [
        feed({ id: "feed-on", unsubscribed: false }),
        feed({ id: "feed-off", unsubscribed: true }),
      ],
    );
    const page = await readUnreadPage(db, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["a-on"]);
  });
});

describe("unread-repository — pagination keyset", () => {
  it("pagine par keyset sans trou ni doublon", async () => {
    const ids: string[] = [];
    const total = UNREAD_PAGE_SIZE * 2 + 5;
    for (let i = 0; i < total; i++) {
      const id = `art-${String(i).padStart(3, "0")}`;
      ids.push(id);
      await seed([
        article({
          id,
          read: false,
          publishedAt: `2026-05-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
          fetchedAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      ]);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await readUnreadPage(db, cursor);
      for (const a of page.articles) seen.push(a.id);
      cursor = page.nextCursor ?? undefined;
      if (++guard > 10) throw new Error("pagination ne termine pas");
    } while (cursor);

    expect(new Set(seen).size).toBe(total);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("nextCursor null sur la dernière page", async () => {
    await seed([article({ id: "a1", read: false })]);
    const page = await readUnreadPage(db, undefined);
    expect(page.nextCursor).toBeNull();
  });
});
