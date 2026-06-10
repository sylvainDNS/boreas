import { issueSession } from "@boreas/shared/crypto";
import { describe, expect, it } from "vitest";
import { isValidSessionToken } from "../src/lib/session";

// Validation de session pure : aucun runtime Hono, aucune route HTTP.
// L'adapter cookie reste couvert de bout en bout par auth.test.ts.

const SECRET = "test-secret";
const NOW = 1_700_000_000;

describe("isValidSessionToken", () => {
  it("rejette un token absent (cookie non posé)", () => {
    expect(isValidSessionToken(SECRET, undefined, NOW)).toBe(false);
  });

  it("accepte un token émis avec le bon secret", () => {
    const token = issueSession(SECRET, undefined, NOW);
    expect(isValidSessionToken(SECRET, token, NOW)).toBe(true);
  });

  it("rejette un token signé avec un autre secret", () => {
    const token = issueSession("autre-secret", undefined, NOW);
    expect(isValidSessionToken(SECRET, token, NOW)).toBe(false);
  });

  it("rejette un token expiré (now injecté après l'expiration)", () => {
    const token = issueSession(SECRET, 60, NOW);
    expect(isValidSessionToken(SECRET, token, NOW + 61)).toBe(false);
  });

  it("rejette une chaîne arbitraire", () => {
    expect(isValidSessionToken(SECRET, "pas-un-token", NOW)).toBe(false);
  });
});
