import { describe, expect, it } from "vitest";
import {
  articleFilterSchema,
  feedSchema,
  markReadRequestSchema,
  settingsPatchSchema,
  themeSchema,
} from "../src/index";

describe("@boreas/api-contracts", () => {
  it("themeSchema n'accepte que les trois préférences", () => {
    expect(themeSchema.safeParse("dark").success).toBe(true);
    expect(themeSchema.safeParse("sepia").success).toBe(false);
  });

  it("articleFilterSchema rejette un filtre inconnu", () => {
    expect(articleFilterSchema.safeParse("unread").success).toBe(true);
    expect(articleFilterSchema.safeParse("archived").success).toBe(false);
  });

  it("settingsPatchSchema exige au moins un champ", () => {
    expect(settingsPatchSchema.safeParse({}).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ theme: "light" }).success).toBe(
      true,
    );
  });

  it("markReadRequestSchema discrimine sur scope", () => {
    expect(markReadRequestSchema.safeParse({ scope: "global" }).success).toBe(
      true,
    );
    expect(
      markReadRequestSchema.safeParse({ scope: "feed", feedId: "f1" }).success,
    ).toBe(true);
    expect(markReadRequestSchema.safeParse({ scope: "feed" }).success).toBe(
      false,
    );
  });

  it("feedSchema accepte les timestamps wire en chaîne ISO ou null", () => {
    const ok = feedSchema.safeParse({
      id: "f1",
      url: "https://example.com/feed.xml",
      title: null,
      status: "ok",
      lastError: null,
      lastCheckAt: "2026-06-10T10:00:00.000Z",
      folderId: null,
    });
    expect(ok.success).toBe(true);
  });
});
