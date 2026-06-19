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

  it("attribue aux Feeds importés un rang en fin de leur conteneur (#110, ADR 0020)", async () => {
    // Un Feed déjà présent dans la zone sans-dossier avec un rang « bas ».
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, folder_id, rank) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("existing", "https://src.example/old.xml", "Ancien", null, "a0")
      .run();

    const res = await importOpml(flatOpml(2));
    expect(res.status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT id, rank FROM feeds WHERE folder_id IS NULL ORDER BY rank ASC",
    ).all<{ id: string; rank: string }>();
    const ranks = rows.results;
    // Les 2 importés sont placés APRÈS l'existant (a0), avec des rangs distincts
    // et croissants (scoping par conteneur : ici la zone sans-dossier).
    expect(ranks[0].id).toBe("existing");
    expect(ranks.length).toBe(3);
    expect(ranks[1].rank > "a0").toBe(true);
    expect(ranks[1].rank < ranks[2].rank).toBe(true);
  });

  it("réattribue un rang en fin du Folder cible quand l'OPML réabonne un Feed dans un dossier (#110, ADR 0020)", async () => {
    // Feed désabonné, rangé « haut » (z9) dans la zone sans-dossier.
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, folder_id, unsubscribed_at, rank) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "off",
        "https://src.example/0.xml",
        "Flux 0",
        null,
        "2026-06-01T00:00:00Z",
        "az",
      )
      .run();
    // Folder « Tech » préexistant avec un résident de rang a0.
    await env.DB.prepare(
      "INSERT INTO folders (id, name, rank) VALUES (?, ?, ?)",
    )
      .bind("fold-tech", "Tech", "a0")
      .run();
    await env.DB.prepare(
      "INSERT INTO feeds (id, url, title, folder_id, rank) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(
        "resident",
        "https://src.example/res.xml",
        "Résident",
        "fold-tech",
        "a0",
      )
      .run();

    // OPML qui réabonne le Feed `off` (même URL) dans le Folder « Tech ».
    const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0"><head><title>Export</title></head><body>
  <outline text="Tech" title="Tech">
    <outline text="Flux 0" title="Flux 0" type="rss" xmlUrl="https://src.example/0.xml"/>
  </outline>
</body></opml>`;

    const res = await importOpml(opml);
    expect(res.status).toBe(200);
    expect((await res.json()).reactivated).toBe(1);

    const moved = await env.DB.prepare(
      "SELECT folder_id AS f, rank AS r FROM feeds WHERE id = ?",
    )
      .bind("off")
      .first<{ f: string; r: string }>();
    expect(moved?.f).toBe("fold-tech");
    // Le rang historique z9 (scopé à l'ancien conteneur) est réattribué en fin
    // du Folder cible : après le résident (a0), et plus égal à z9.
    expect(moved?.r).not.toBe("z9");
    expect((moved?.r ?? "") > "a0").toBe(true);
  });
});
