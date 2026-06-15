import { env, SELF } from "cloudflare:test";
import { issueSession } from "@boreas/shared/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "../src/lib/session";

const SECRET = "test-secret";
const ORIGIN = "https://api.test";

/**
 * Abonnement valide : on réutilise les clés **receveur** du vecteur RFC 8291 §5
 * (`p256dh`/`auth`) pour que le chiffrement du push de test aboutisse réellement.
 */
const SUBSCRIPTION = {
  endpoint: "https://push.example/sub/abc123",
  keys: {
    p256dh:
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
};

function authed(init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      ...init?.headers,
      cookie: `${SESSION_COOKIE}=${issueSession(SECRET)}`,
    },
  };
}

function subscribe(body: unknown, init?: RequestInit): Promise<Response> {
  return SELF.fetch(
    `${ORIGIN}/api/push/subscribe`,
    authed({ method: "POST", body: JSON.stringify(body), ...init }),
  );
}

function unsubscribe(body: unknown, init?: RequestInit): Promise<Response> {
  return SELF.fetch(
    `${ORIGIN}/api/push/subscribe`,
    authed({ method: "DELETE", body: JSON.stringify(body), ...init }),
  );
}

async function seedSubscription(endpoint: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)",
  )
    .bind(endpoint, SUBSCRIPTION.keys.p256dh, SUBSCRIPTION.keys.auth)
    .run();
}

async function countSubscriptions(endpoint: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?",
  )
    .bind(endpoint)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM push_subscriptions").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/push/subscribe (#79)", () => {
  it("refuse l'accès sans session", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/push/subscribe`, {
      method: "POST",
      body: JSON.stringify(SUBSCRIPTION),
    });
    expect(res.status).toBe(401);
  });

  it("enregistre l'abonnement et envoie un push de test", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await subscribe(SUBSCRIPTION);

    expect(res.status).toBe(201);
    expect(await countSubscriptions(SUBSCRIPTION.endpoint)).toBe(1);

    // Un push de test, chiffré aes128gcm, est parti vers l'endpoint de l'abonné.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(SUBSCRIPTION.endpoint);
    expect((init.headers as Record<string, string>)["Content-Encoding"]).toBe(
      "aes128gcm",
    );
  });

  it("est idempotent sur le même endpoint (upsert, une seule ligne)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 201 })),
    );

    await subscribe(SUBSCRIPTION);
    await subscribe(SUBSCRIPTION);

    expect(await countSubscriptions(SUBSCRIPTION.endpoint)).toBe(1);
  });

  it("rejette un corps invalide (endpoint non-URL)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 201 })),
    );
    const res = await subscribe({ endpoint: "pas-une-url", keys: {} });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/push/subscribe (#79)", () => {
  it("refuse l'accès sans session", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/push/subscribe`, {
      method: "DELETE",
      body: JSON.stringify({ endpoint: SUBSCRIPTION.endpoint }),
    });
    expect(res.status).toBe(401);
  });

  it("supprime l'abonnement côté serveur", async () => {
    await seedSubscription(SUBSCRIPTION.endpoint);

    const res = await unsubscribe({ endpoint: SUBSCRIPTION.endpoint });

    expect(res.status).toBe(204);
    expect(await countSubscriptions(SUBSCRIPTION.endpoint)).toBe(0);
  });

  it("est idempotent sur un endpoint inconnu", async () => {
    const res = await unsubscribe({
      endpoint: "https://push.example/sub/inconnu",
    });
    expect(res.status).toBe(204);
  });
});
