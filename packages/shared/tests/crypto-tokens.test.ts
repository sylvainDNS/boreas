import { describe, expect, it } from "vitest";
import {
  issueMagicToken,
  issueSession,
  tokenHash,
  verifyMagicToken,
  verifySession,
} from "../src/crypto/tokens";

const SECRET = "test-secret-please-change";
const NOW = 1_800_000_000; // epoch fixe pour des tests déterministes

/** Retourne le jeton avec un octet du payload modifié (falsification). */
function tamperPayload(token: string): string {
  const dot = token.indexOf(".");
  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const flipped = `${encoded.slice(0, -1)}${encoded.at(-1) === "A" ? "B" : "A"}`;
  return `${flipped}.${sig}`;
}

describe("magic token", () => {
  it("émet puis vérifie un jeton valide (round-trip)", () => {
    const issued = issueMagicToken(SECRET, 600, NOW);
    const result = verifyMagicToken(SECRET, issued.token, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expiresAt).toBe(NOW + 600);
      // L'empreinte renvoyée à la vérification correspond à celle stockée en D1.
      expect(result.tokenHash).toBe(issued.tokenHash);
      expect(issued.tokenHash).toBe(tokenHash(issued.token));
    }
  });

  it("rejette un jeton expiré", () => {
    const issued = issueMagicToken(SECRET, 600, NOW);
    const result = verifyMagicToken(SECRET, issued.token, NOW + 601);

    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejette un jeton falsifié (payload modifié)", () => {
    const issued = issueMagicToken(SECRET, 600, NOW);
    const result = verifyMagicToken(SECRET, tamperPayload(issued.token), NOW);

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejette un jeton signé avec un autre secret", () => {
    const issued = issueMagicToken("autre-secret", 600, NOW);
    const result = verifyMagicToken(SECRET, issued.token, NOW);

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejette une session présentée comme magic token", () => {
    const session = issueSession(SECRET, 600, NOW);
    const result = verifyMagicToken(SECRET, session, NOW);

    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("produit des jetons distincts à chaque émission (jti aléatoire)", () => {
    const a = issueMagicToken(SECRET, 600, NOW);
    const b = issueMagicToken(SECRET, 600, NOW);

    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe("session token", () => {
  it("émet puis vérifie une session valide (round-trip)", () => {
    const token = issueSession(SECRET, 3600, NOW);

    expect(verifySession(SECRET, token, NOW)).toEqual({ ok: true });
  });

  it("rejette une session expirée", () => {
    const token = issueSession(SECRET, 3600, NOW);

    expect(verifySession(SECRET, token, NOW + 3601)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejette une session falsifiée", () => {
    const token = issueSession(SECRET, 3600, NOW);

    expect(verifySession(SECRET, tamperPayload(token), NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejette une session signée avec un autre secret", () => {
    const token = issueSession("autre-secret", 3600, NOW);

    expect(verifySession(SECRET, token, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejette un magic token présenté comme session", () => {
    const magic = issueMagicToken(SECRET, 600, NOW).token;

    expect(verifySession(SECRET, magic, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
