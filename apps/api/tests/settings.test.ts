import { env, SELF } from "cloudflare:test";
import { issueSession } from "@boreas/shared/crypto";
import { afterEach, describe, expect, it } from "vitest";
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

function patch(body: unknown, init?: RequestInit): Promise<Response> {
  return SELF.fetch(
    `${ORIGIN}/api/settings`,
    authed({ method: "PATCH", body: JSON.stringify(body), ...init }),
  );
}

async function readRow(): Promise<{
  refresh_interval_min: number;
  purge_window_days: number;
  theme: string;
}> {
  return (await env.DB.prepare(
    "SELECT refresh_interval_min, purge_window_days, theme FROM settings WHERE id = 1",
  ).first()) as never;
}

// La ligne `settings` provient du seed des migrations (id=1). On la remet à ses
// valeurs par défaut après chaque test pour isoler ceux qui la mutent.
afterEach(async () => {
  await env.DB.prepare(
    "UPDATE settings SET refresh_interval_min = 30, purge_window_days = 60, theme = 'system' WHERE id = 1",
  ).run();
});

describe("GET/PATCH /api/settings (#18)", () => {
  it("refuse l'accès sans session (garde)", async () => {
    const get = await SELF.fetch(`${ORIGIN}/api/settings`);
    expect(get.status).toBe(401);

    const patched = await SELF.fetch(`${ORIGIN}/api/settings`, {
      method: "PATCH",
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(patched.status).toBe(401);
  });

  it("GET renvoie les valeurs seedées (camelCase)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/settings`, authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refreshIntervalMin: 30,
      purgeWindowDays: 60,
      theme: "system",
    });
  });

  it("PATCH met à jour un champ et renvoie la ligne complète", async () => {
    const res = await patch({ refreshIntervalMin: 60 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refreshIntervalMin: 60,
      purgeWindowDays: 60,
      theme: "system",
    });
    expect((await readRow()).refresh_interval_min).toBe(60);
  });

  it("PATCH met à jour plusieurs champs à la fois", async () => {
    const res = await patch({
      refreshIntervalMin: 120,
      purgeWindowDays: 90,
      theme: "dark",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refreshIntervalMin: 120,
      purgeWindowDays: 90,
      theme: "dark",
    });
    const row = await readRow();
    expect(row.refresh_interval_min).toBe(120);
    expect(row.purge_window_days).toBe(90);
    expect(row.theme).toBe("dark");
  });

  it("PATCH sans aucun champ → 400", async () => {
    const res = await patch({});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
  });

  it("PATCH hors-bornes ou thème invalide → 400", async () => {
    expect((await patch({ refreshIntervalMin: 0 })).status).toBe(400);
    expect((await patch({ refreshIntervalMin: 5000 })).status).toBe(400);
    expect((await patch({ purgeWindowDays: 99999 })).status).toBe(400);
    expect((await patch({ theme: "blue" })).status).toBe(400);
    // Aucune écriture partielle : la ligne reste aux valeurs par défaut.
    const row = await readRow();
    expect(row.refresh_interval_min).toBe(30);
    expect(row.theme).toBe("system");
  });
});
