import { env } from "cloudflare:test";
import { getDb, ingestFeed } from "@boreas/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Intégration `ingestFeed` (#80) : vérifie qu'il **remonte les titres** des
 * articles net-new insérés (`newArticleTitles`), donnée que le consommateur de
 * Queue passe à la notification push. Hébergé côté Cron car c'est le seul pool de
 * test avec D1 + R2 réels (le paquet `@boreas/shared` tourne en env node pur).
 */

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Mon flux</title>
<item><title>Article Un</title><link>https://ex.test/1</link><guid>g1</guid><description>&lt;p&gt;Un&lt;/p&gt;</description></item>
<item><title>Article Deux</title><link>https://ex.test/2</link><guid>g2</guid><description>&lt;p&gt;Deux&lt;/p&gt;</description></item>
</channel></rss>`;

const db = getDb(env.DB);

function rssResponse(): Response {
  return new Response(RSS, {
    status: 200,
    headers: { "content-type": "application/rss+xml" },
  });
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
  await env.DB.prepare("INSERT INTO feeds (id, url, title) VALUES (?, ?, ?)")
    .bind("feed-1", "https://ex.test/feed.xml", "Mon flux")
    .run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ingestFeed — newArticleTitles (#80)", () => {
  it("remonte les titres des articles net-new insérés", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rssResponse()),
    );

    const result = await ingestFeed("feed-1", db, env.BUCKET, "secret");

    expect(result.status).toBe("updated");
    expect(result.inserted).toBe(2);
    expect([...result.newArticleTitles].sort()).toEqual([
      "Article Deux",
      "Article Un",
    ]);
  });

  it("ne remonte aucun titre au second passage (rien de net-new)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rssResponse()),
    );

    await ingestFeed("feed-1", db, env.BUCKET, "secret");
    const second = await ingestFeed("feed-1", db, env.BUCKET, "secret");

    expect(second.inserted).toBe(0);
    expect(second.newArticleTitles).toEqual([]);
  });
});
