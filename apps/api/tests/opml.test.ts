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

/** OPML plat (flux à la racine) de `count` entrées, format Inoreader/Feedly. */
function flatOpml(count: number): string {
  const outlines = Array.from(
    { length: count },
    (_, i) =>
      `<outline text="Flux ${i}" title="Flux ${i}" type="rss" xmlUrl="https://src.example/${i}.xml" htmlUrl="https://src.example/${i}"/>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0"><head><title>Export</title></head><body>
${outlines}
</body></opml>`;
}

async function importOpml(opml: string): Promise<Response> {
  return SELF.fetch(
    `${ORIGIN}/api/opml/import`,
    authed({ method: "POST", body: JSON.stringify({ opml }) }),
  );
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM articles").run();
  await env.DB.prepare("DELETE FROM feeds").run();
  await env.DB.prepare("DELETE FROM folders").run();
});

describe("POST /api/opml/import (#17)", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/opml/import`, {
      method: "POST",
      body: JSON.stringify({ opml: flatOpml(1) }),
    });
    expect(res.status).toBe(401);
  });

  // Régression : l'INSERT groupé des flux lie 5 paramètres par ligne (les 4
  // valeurs fournies + le défaut JS `consecutive_failures`). Un découpage calé
  // sur 4 produisait 24 lignes × 5 = 120 paramètres > limite SQLite de 100 →
  // « too many SQL variables » (D1_ERROR, 500). Au-delà d'une vingtaine de flux
  // l'import doit franchir plusieurs lots sans planter.
  it("importe un gros OPML qui dépasse la limite de variables SQLite par lot", async () => {
    const count = 50;
    const res = await importOpml(flatOpml(count));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imported: count,
      reactivated: 0,
      skipped: 0,
      foldersCreated: 0,
    });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM feeds").first<{
      n: number;
    }>();
    expect(row?.n).toBe(count);
  });

  it("attribue un rang fractionnaire croissant aux Folders importés (#108, ADR 0020)", async () => {
    // Deux dossiers imbriqués, placés en fin de liste dans l'ordre d'apparition.
    const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0"><head><title>Export</title></head><body>
  <outline text="Tech" title="Tech">
    <outline text="A" title="A" type="rss" xmlUrl="https://src.example/a.xml"/>
  </outline>
  <outline text="Actu" title="Actu">
    <outline text="B" title="B" type="rss" xmlUrl="https://src.example/b.xml"/>
  </outline>
</body></opml>`;

    const res = await importOpml(opml);
    expect(res.status).toBe(200);
    expect((await res.json()).foldersCreated).toBe(2);

    const rows = await env.DB.prepare(
      "SELECT name, rank FROM folders ORDER BY rank ASC",
    ).all<{ name: string; rank: string }>();
    const items = rows.results;
    // Ordre par rang = ordre d'apparition dans l'OPML (Tech avant Actu).
    expect(items.map((f) => f.name)).toEqual(["Tech", "Actu"]);
    // Rangs non vides et strictement croissants.
    expect(items[0].rank.length).toBeGreaterThan(0);
    expect(items[0].rank < items[1].rank).toBe(true);
  });
});
