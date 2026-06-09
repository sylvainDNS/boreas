import { describe, expect, it } from "vitest";
import {
  imageCacheKey,
  signImageUrl,
  verifyImageUrl,
} from "../src/crypto/image-url";

const SECRET = "test-secret";

describe("signImageUrl / verifyImageUrl", () => {
  it("produit un chemin proxy avec u et sig", () => {
    const signed = signImageUrl(SECRET, "https://src.example/a.jpg");
    expect(signed.startsWith("/api/img?u=")).toBe(true);
    expect(signed).toContain("&sig=");
  });

  it("vérifie une URL signée et renvoie la source (round-trip)", () => {
    const src = "https://src.example/photos/é à.jpg?w=800";
    const signed = signImageUrl(SECRET, src);
    const params = new URLSearchParams(signed.slice(signed.indexOf("?") + 1));
    const back = verifyImageUrl(
      SECRET,
      params.get("u") ?? "",
      params.get("sig") ?? "",
    );
    expect(back).toBe(src);
  });

  it("rejette une signature falsifiée", () => {
    const signed = signImageUrl(SECRET, "https://src.example/a.jpg");
    const params = new URLSearchParams(signed.slice(signed.indexOf("?") + 1));
    expect(
      verifyImageUrl(SECRET, params.get("u") ?? "", "falsifie"),
    ).toBeNull();
  });

  it("rejette une signature émise avec un autre secret", () => {
    const signed = signImageUrl(SECRET, "https://src.example/a.jpg");
    const params = new URLSearchParams(signed.slice(signed.indexOf("?") + 1));
    expect(
      verifyImageUrl(
        "autre-secret",
        params.get("u") ?? "",
        params.get("sig") ?? "",
      ),
    ).toBeNull();
  });
});

describe("imageCacheKey", () => {
  it("préfixe par images/ et reste déterministe pour une même URL", () => {
    const src = "https://src.example/photos/a.jpg?w=800";
    const key = imageCacheKey(src);
    expect(key.startsWith("images/")).toBe(true);
    expect(imageCacheKey(src)).toBe(key);
  });

  it("produit des clés distinctes pour des URLs distinctes", () => {
    expect(imageCacheKey("https://src.example/a.jpg")).not.toBe(
      imageCacheKey("https://src.example/b.jpg"),
    );
  });
});
