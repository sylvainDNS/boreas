import "fake-indexeddb/auto";
import type { SyncArticle, SyncFeed, SyncFolder } from "@boreas/api-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTICLE_PAGE_SIZE,
  localArticleCounts,
  readArticlePage,
  searchArticles,
} from "./article-repository";
import {
  applyDelta,
  deleteReplica,
  openReplica,
  type ReplicaDb,
} from "./replica-store";

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
    folderId: over.folderId ?? null,
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

async function seed(
  articles: SyncArticle[],
  feeds: SyncFeed[] = [],
  folders: SyncFolder[] = [],
) {
  await applyDelta(db, {
    upserts: { articles, feeds, folders },
    tombstones: [],
  });
}

describe("article-repository — filtre unread", () => {
  it("ne renvoie que les non-lus", async () => {
    await seed([
      article({ id: "a-unread", read: false }),
      article({ id: "a-read", read: true }),
    ]);
    const page = await readArticlePage(db, { filter: "unread" }, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["a-unread"]);
  });

  it("expose la même forme que ArticleListResponse (item wire + nextCursor)", async () => {
    await seed([article({ id: "a1", read: false, saved: true })]);
    const page = await readArticlePage(db, { filter: "unread" }, undefined);
    expect(page).toHaveProperty("nextCursor");
    expect(page.articles[0]).toMatchObject({
      id: "a1",
      feedId: "feed-1",
      feedName: "Mon flux",
      read: false,
      saved: true,
    });
    // La clé de tri dérivée ne fuit pas dans l'item wire.
    expect(page.articles[0]).not.toHaveProperty("sortKey");
  });
});

describe("article-repository — filtre all", () => {
  it("renvoie lus + non-lus", async () => {
    await seed([
      article({ id: "a-unread", read: false }),
      article({ id: "a-read", read: true }),
    ]);
    const page = await readArticlePage(db, { filter: "all" }, undefined);
    expect(page.articles.map((a) => a.id).sort()).toEqual([
      "a-read",
      "a-unread",
    ]);
  });

  it("exclut les feeds désabonnés (parité API)", async () => {
    await seed(
      [
        article({ id: "a-on", feedId: "feed-on" }),
        article({ id: "a-off", feedId: "feed-off" }),
      ],
      [
        feed({ id: "feed-on", unsubscribed: false }),
        feed({ id: "feed-off", unsubscribed: true }),
      ],
    );
    const page = await readArticlePage(db, { filter: "all" }, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["a-on"]);
  });
});

describe("article-repository — filtre saved", () => {
  it("ne renvoie que les Saved (lus et non-lus)", async () => {
    await seed([
      article({ id: "s-read", saved: true, read: true }),
      article({ id: "s-unread", saved: true, read: false }),
      article({ id: "not-saved", saved: false }),
    ]);
    const page = await readArticlePage(db, { filter: "saved" }, undefined);
    expect(page.articles.map((a) => a.id).sort()).toEqual([
      "s-read",
      "s-unread",
    ]);
  });

  it("garde les Saved d'un feed désabonné (parité API : pas d'exclusion en saved)", async () => {
    await seed(
      [article({ id: "s-off", feedId: "feed-off", saved: true })],
      [feed({ id: "feed-off", unsubscribed: true })],
    );
    const page = await readArticlePage(db, { filter: "saved" }, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["s-off"]);
  });
});

describe("article-repository — restriction feedId", () => {
  it("ne renvoie que les articles du feed demandé", async () => {
    await seed(
      [
        article({ id: "a-f1", feedId: "f1" }),
        article({ id: "a-f2", feedId: "f2" }),
      ],
      [feed({ id: "f1" }), feed({ id: "f2" })],
    );
    const page = await readArticlePage(
      db,
      { filter: "all", feedId: "f1" },
      undefined,
    );
    expect(page.articles.map((a) => a.id)).toEqual(["a-f1"]);
  });
});

describe("article-repository — restriction folderId", () => {
  it("agrège les articles des feeds rattachés au folder", async () => {
    await seed(
      [
        article({ id: "a-fa", feedId: "fa" }),
        article({ id: "a-fb", feedId: "fb" }),
        article({ id: "a-fc", feedId: "fc" }),
      ],
      [
        feed({ id: "fa", folderId: "folder-1" }),
        feed({ id: "fb", folderId: "folder-1" }),
        feed({ id: "fc", folderId: "folder-2" }),
      ],
      [
        { id: "folder-1", name: "Dossier 1", rank: "a0" },
        { id: "folder-2", name: "Dossier 2", rank: "a1" },
      ],
    );
    const page = await readArticlePage(
      db,
      { filter: "all", folderId: "folder-1" },
      undefined,
    );
    expect(page.articles.map((a) => a.id).sort()).toEqual(["a-fa", "a-fb"]);
  });
});

describe("article-repository — tri (ADR 0015)", () => {
  it("trie par coalesce(publishedAt, fetchedAt) desc puis id desc", async () => {
    await seed([
      article({ id: "old", publishedAt: "2026-01-01T00:00:00Z" }),
      article({ id: "new", publishedAt: "2026-06-04T00:00:00Z" }),
      article({ id: "mid", publishedAt: "2026-03-01T00:00:00Z" }),
    ]);
    const page = await readArticlePage(db, { filter: "all" }, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["new", "mid", "old"]);
  });

  it("départage par id desc à sortKey égal", async () => {
    await seed([
      article({ id: "aaa", publishedAt: "2026-05-01T00:00:00Z" }),
      article({ id: "zzz", publishedAt: "2026-05-01T00:00:00Z" }),
    ]);
    const page = await readArticlePage(db, { filter: "all" }, undefined);
    expect(page.articles.map((a) => a.id)).toEqual(["zzz", "aaa"]);
  });
});

describe("article-repository — pagination keyset", () => {
  it("pagine par keyset sans trou ni doublon (filtre all)", async () => {
    const ids: string[] = [];
    const total = ARTICLE_PAGE_SIZE * 2 + 5;
    for (let i = 0; i < total; i++) {
      const id = `art-${String(i).padStart(3, "0")}`;
      ids.push(id);
      await seed([
        article({
          id,
          publishedAt: `2026-05-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
          fetchedAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        }),
      ]);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const page = await readArticlePage(db, { filter: "all" }, cursor);
      for (const a of page.articles) seen.push(a.id);
      cursor = page.nextCursor ?? undefined;
      if (++guard > 10) throw new Error("pagination ne termine pas");
    } while (cursor);

    expect(new Set(seen).size).toBe(total);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("nextCursor null sur la dernière page", async () => {
    await seed([article({ id: "a1" })]);
    const page = await readArticlePage(db, { filter: "all" }, undefined);
    expect(page.nextCursor).toBeNull();
  });
});

describe("article-repository — compteurs locaux", () => {
  it("calcule total/byFeed/byFolder sur les non-lus, feeds actifs", async () => {
    await seed(
      [
        article({ id: "a1", feedId: "f1", read: false }),
        article({ id: "a2", feedId: "f1", read: false }),
        article({ id: "a3", feedId: "f2", read: false }),
        // Lu : exclu des compteurs.
        article({ id: "a4", feedId: "f2", read: true }),
        // Feed désabonné : exclu.
        article({ id: "a5", feedId: "f3", read: false }),
        // Feed non classé : compte au total et byFeed, pas au byFolder.
        article({ id: "a6", feedId: "f4", read: false }),
      ],
      [
        feed({ id: "f1", folderId: "fo1" }),
        feed({ id: "f2", folderId: "fo1" }),
        feed({ id: "f3", folderId: "fo2", unsubscribed: true }),
        feed({ id: "f4", folderId: null }),
      ],
      [
        { id: "fo1", name: "Dossier 1", rank: "a0" },
        { id: "fo2", name: "Dossier 2", rank: "a1" },
      ],
    );

    const counts = await localArticleCounts(db);

    // total = a1,a2,a3,a6 = 4 (a4 lu, a5 désabonné exclus).
    expect(counts.total).toBe(4);
    expect(new Map(counts.byFeed.map((r) => [r.feedId, r.count]))).toEqual(
      new Map([
        ["f1", 2],
        ["f2", 1],
        ["f4", 1],
      ]),
    );
    // byFolder : fo1 = f1+f2 = 3 ; f4 non classé exclu ; fo2 désabonné exclu.
    expect(new Map(counts.byFolder.map((r) => [r.folderId, r.count]))).toEqual(
      new Map([["fo1", 3]]),
    );
  });

  it("n'expose pas un feed/folder sans non-lu", async () => {
    await seed(
      [article({ id: "a1", feedId: "f1", read: true })],
      [feed({ id: "f1", folderId: "fo1" })],
      [{ id: "fo1", name: "Dossier 1", rank: "a0" }],
    );
    const counts = await localArticleCounts(db);
    expect(counts.total).toBe(0);
    expect(counts.byFeed).toEqual([]);
    expect(counts.byFolder).toEqual([]);
  });
});

describe("article-repository — recherche offline", () => {
  it("trouve par sous-chaîne insensible à la casse dans le titre", async () => {
    await seed([
      article({ id: "a1", title: "Le Vent du Nord" }),
      article({ id: "a2", title: "Autre chose" }),
    ]);
    const results = await searchArticles(db, "vent");
    expect(results.map((a) => a.id)).toEqual(["a1"]);
  });

  it("trouve par sous-chaîne dans le résumé", async () => {
    await seed([
      article({ id: "a1", title: "Titre", summary: "un résumé passionnant" }),
      article({ id: "a2", title: "Titre", summary: null }),
    ]);
    const results = await searchArticles(db, "passionnant");
    expect(results.map((a) => a.id)).toEqual(["a1"]);
  });

  it("trie les résultats par date desc puis id desc", async () => {
    await seed([
      article({
        id: "old",
        title: "match",
        publishedAt: "2026-01-01T00:00:00Z",
      }),
      article({
        id: "new",
        title: "match",
        publishedAt: "2026-06-01T00:00:00Z",
      }),
    ]);
    const results = await searchArticles(db, "match");
    expect(results.map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("exclut les feeds désabonnés", async () => {
    await seed(
      [
        article({ id: "on", title: "match", feedId: "f-on" }),
        article({ id: "off", title: "match", feedId: "f-off" }),
      ],
      [
        feed({ id: "f-on", unsubscribed: false }),
        feed({ id: "f-off", unsubscribed: true }),
      ],
    );
    const results = await searchArticles(db, "match");
    expect(results.map((a) => a.id)).toEqual(["on"]);
  });

  it("renvoie une liste vide pour une requête vide", async () => {
    await seed([article({ id: "a1", title: "quoi que ce soit" })]);
    expect(await searchArticles(db, "")).toEqual([]);
    expect(await searchArticles(db, "   ")).toEqual([]);
  });

  it("renvoie des items wire (sans sortKey)", async () => {
    await seed([article({ id: "a1", title: "match" })]);
    const [first] = await searchArticles(db, "match");
    expect(first).not.toHaveProperty("sortKey");
    expect(first).toMatchObject({ id: "a1" });
  });
});
