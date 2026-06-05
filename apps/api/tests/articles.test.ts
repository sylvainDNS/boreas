import { env, SELF } from "cloudflare:test";
import { issueSession } from "@boreas/shared/crypto";
import { beforeEach, describe, expect, it } from "vitest";
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

/** Insère un Feed + un Article ; le contenu R2 est optionnel (content_key). */
async function seedArticle(opts: {
  id: string;
  contentKey?: string | null;
  read?: boolean;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO feeds (id, url, title) VALUES (?, ?, ?)",
  )
    .bind("feed-1", "https://src.example/feed.xml", "Mon flux")
    .run();
  await env.DB.prepare(
    "INSERT INTO articles (id, feed_id, article_key, title, link, content_key, read, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      opts.id,
      "feed-1",
      `key-${opts.id}`,
      "Le vent du nord",
      "https://src.example/article",
      opts.contentKey ?? null,
      opts.read ? 1 : 0,
      "2026-06-05T12:00:00Z",
    )
    .run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
});

describe("GET /api/articles/:id — lecteur", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-1`);
    expect(res.status).toBe(401);
  });

  it("sert le contenu stocké en R2 et marque l'Article Read", async () => {
    const key = "articles/art-1.html";
    await env.BUCKET.put(key, "<p>Le vent du nord souffle.</p>");
    await seedArticle({ id: "art-1", contentKey: key });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-1`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      feedName: string;
      title: string;
      link: string;
      content: string | null;
    };
    expect(body.id).toBe("art-1");
    expect(body.feedName).toBe("Mon flux");
    expect(body.content).toBe("<p>Le vent du nord souffle.</p>");

    // L'ouverture marque l'Article Read.
    const row = await env.DB.prepare("SELECT read FROM articles WHERE id = ?")
      .bind("art-1")
      .first<{ read: number }>();
    expect(row?.read).toBe(1);
  });

  it("renvoie content:null quand l'article n'a pas de contenu extrait", async () => {
    await seedArticle({ id: "art-2", contentKey: null });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-2`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string | null };
    expect(body.content).toBeNull();
  });

  it("dégrade en content:null si l'objet R2 est absent (sans 500)", async () => {
    // content_key pointe vers un objet jamais écrit en R2.
    await seedArticle({ id: "art-3", contentKey: "articles/art-3.html" });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-3`, authed());
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { content: string | null }).content,
    ).toBeNull();
  });

  it("reste 200 et marqué lu en ré-ouvrant un article déjà lu", async () => {
    await seedArticle({ id: "art-4", contentKey: null, read: true });

    const res = await SELF.fetch(`${ORIGIN}/api/articles/art-4`, authed());
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT read FROM articles WHERE id = ?")
      .bind("art-4")
      .first<{ read: number }>();
    expect(row?.read).toBe(1);
  });

  it("renvoie 404 pour un article inconnu", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/articles/inexistant`, authed());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
