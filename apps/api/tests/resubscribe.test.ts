import { env } from "cloudflare:test";
import {
  chunk,
  type Db,
  feeds,
  folders,
  getDb,
  insertChunkSize,
  resubscribeFeed,
  resubscribeFeeds,
} from "@boreas/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Tests directs du module `resubscribe` contre la D1 miniflare, **sans Hono** :
 * l'invariant de réactivation (`RESUBSCRIBE_RESET`) vit dans le module et ne peut
 * plus être observé qu'à travers son effet sur les colonnes du Feed. On vérifie
 * le reset complet de la santé/polling, le chunking au-delà d'une tranche D1, et
 * la (non-)réassignation de `folder_id`.
 */

const db: Db = getDb(env.DB);

/** Feed désabonné « sale » : toutes les colonnes santé/polling sont renseignées. */
function unsubscribedFeed(id: string, folderId: string | null = null) {
  return {
    id,
    url: `https://src.example/${id}.xml`,
    title: `Feed ${id}`,
    etag: '"abc"',
    last_modified: "Wed, 01 Jan 2026 00:00:00 GMT",
    next_check_at: "2026-01-01T00:00:00Z",
    last_check_at: "2026-01-01T00:00:00Z",
    consecutive_failures: 5,
    last_error: "http_500",
    last_error_at: "2026-01-01T00:00:00Z",
    folder_id: folderId,
    unsubscribed_at: "2026-01-01T00:00:00Z",
  };
}

/** Insère des Feeds en respectant la limite D1 de variables liées (13 colonnes). */
async function seedFeeds(rows: ReturnType<typeof unsubscribedFeed>[]) {
  for (const group of chunk(rows, insertChunkSize(13))) {
    await db.insert(feeds).values(group);
  }
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
  await env.DB.prepare("DELETE FROM folders").run();
});

describe("resubscribeFeed — sucre unitaire", () => {
  it("efface unsubscribed_at et réinitialise toute la santé/polling du Feed", async () => {
    await db.insert(feeds).values(unsubscribedFeed("a"));

    await resubscribeFeed(db, "a");

    const [row] = await db.select().from(feeds).where(eq(feeds.id, "a"));
    expect(row.unsubscribed_at).toBeNull();
    expect(row.next_check_at).toBeNull();
    expect(row.etag).toBeNull();
    expect(row.last_modified).toBeNull();
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.last_error_at).toBeNull();
  });

  it("ne touche pas au folder_id existant (aucune option fournie)", async () => {
    await db.insert(folders).values({ id: "f1", name: "Tech", rank: "a0" });
    await db.insert(feeds).values(unsubscribedFeed("a", "f1"));

    await resubscribeFeed(db, "a");

    const [row] = await db.select().from(feeds).where(eq(feeds.id, "a"));
    expect(row.folder_id).toBe("f1");
  });
});

describe("resubscribeFeeds — lots", () => {
  it("réinitialise un lot de ~150 feeds (dépasse une tranche D1 → valide le chunking)", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `feed-${i}`);
    await seedFeeds(ids.map((id) => unsubscribedFeed(id)));

    await resubscribeFeeds(db, ids);

    // On relit tous les Feeds (sans WHERE … IN, qui dépasserait lui-même la
    // limite) : si une seule tranche n'avait pas été mise à jour, des colonnes
    // resteraient « sales ». Le chunking du module est donc validé de bout en bout.
    const rows = await db.select().from(feeds);
    expect(rows).toHaveLength(150);
    for (const row of rows) {
      expect(row.unsubscribed_at).toBeNull();
      expect(row.consecutive_failures).toBe(0);
      expect(row.etag).toBeNull();
      expect(row.last_error).toBeNull();
    }
  });

  it("réassigne folder_id quand folderId est fourni", async () => {
    await db.insert(folders).values({ id: "f1", name: "Tech", rank: "a0" });
    await db.insert(feeds).values(unsubscribedFeed("a", null));

    await resubscribeFeeds(db, ["a"], { folderId: "f1" });

    const [row] = await db.select().from(feeds).where(eq(feeds.id, "a"));
    expect(row.folder_id).toBe("f1");
    expect(row.unsubscribed_at).toBeNull();
  });

  it("conserve folder_id existant quand folderId est absent", async () => {
    await db.insert(folders).values({ id: "f1", name: "Tech", rank: "a0" });
    await db.insert(feeds).values(unsubscribedFeed("a", "f1"));

    await resubscribeFeeds(db, ["a"]);

    const [row] = await db.select().from(feeds).where(eq(feeds.id, "a"));
    expect(row.folder_id).toBe("f1");
  });

  it("ne fait rien sur une liste vide (aucune requête)", async () => {
    await expect(resubscribeFeeds(db, [])).resolves.toBeUndefined();
  });
});
