import { env, SELF } from "cloudflare:test";
import { issueMagicToken, issueSession } from "@boreas/shared/crypto";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/lib/session";

const SECRET = "test-secret";
const ALLOWED_EMAIL = "boreas.overcrowd752@passmail.net";
const ORIGIN = "https://api.test";

function verifyUrl(token: string): string {
  return `${ORIGIN}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

async function countTokens(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM auth_tokens",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

async function insertToken(
  hash: string,
  expiresAt: number,
  used = false,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO auth_tokens (token_hash, expires_at, used) VALUES (?, ?, ?)",
  )
    .bind(hash, expiresAt, used ? 1 : 0)
    .run();
}

describe("POST /api/auth/request", () => {
  it("émet un lien (insère un jeton) pour l'adresse autorisée", async () => {
    const before = await countTokens();
    const res = await SELF.fetch(`${ORIGIN}/api/auth/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ALLOWED_EMAIL }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(await countTokens()).toBe(before + 1);
  });

  it("réponse générique et aucun jeton pour une autre adresse (anti-énumération)", async () => {
    const before = await countTokens();
    const res = await SELF.fetch(`${ORIGIN}/api/auth/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "intrus@example.com" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(await countTokens()).toBe(before);
  });

  it("rejette une requête sans e-mail valide", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "pas-un-email" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/auth/verify", () => {
  it("pose le cookie de session et redirige vers l'app", async () => {
    const { token, tokenHash, expiresAt } = issueMagicToken(SECRET);
    await insertToken(tokenHash, expiresAt);

    const res = await SELF.fetch(verifyUrl(token), { redirect: "manual" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("rejette un jeton déjà consommé (usage unique)", async () => {
    const { token, tokenHash, expiresAt } = issueMagicToken(SECRET);
    await insertToken(tokenHash, expiresAt);

    const first = await SELF.fetch(verifyUrl(token), { redirect: "manual" });
    expect(first.status).toBe(302);

    const second = await SELF.fetch(verifyUrl(token), { redirect: "manual" });
    expect(second.status).toBe(400);
  });

  it("rejette un jeton expiré", async () => {
    const { token, tokenHash, expiresAt } = issueMagicToken(SECRET, -10);
    await insertToken(tokenHash, expiresAt);

    const res = await SELF.fetch(verifyUrl(token), { redirect: "manual" });

    expect(res.status).toBe(400);
  });

  it("rejette un jeton falsifié", async () => {
    const res = await SELF.fetch(verifyUrl("payload.signature-bidon"), {
      redirect: "manual",
    });

    expect(res.status).toBe(400);
  });
});

describe("middleware de session", () => {
  it("renvoie 401 sur une route protégée sans session", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/feeds`);
    expect(res.status).toBe(401);
  });

  it("laisse passer une session valide (garde franchie)", async () => {
    const session = issueSession(SECRET);
    const res = await SELF.fetch(`${ORIGIN}/api/feeds`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    // Garde franchie : 404 (aucune route /api/feeds encore), pas 401.
    expect(res.status).not.toBe(401);
  });

  it("laisse /api/health public", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe("session & logout", () => {
  it("GET /api/auth/session reflète l'état d'auth", async () => {
    const anon = await SELF.fetch(`${ORIGIN}/api/auth/session`);
    expect(anon.status).toBe(401);

    const session = issueSession(SECRET);
    const authed = await SELF.fetch(`${ORIGIN}/api/auth/session`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ authenticated: true });
  });

  it("POST /api/auth/logout supprime le cookie", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
    });

    expect(res.status).toBe(204);
    const cookie = (res.headers.get("set-cookie") ?? "").toLowerCase();
    expect(cookie).toContain(`${SESSION_COOKIE.toLowerCase()}=`);
    expect(cookie).toContain("max-age=0");
  });
});
