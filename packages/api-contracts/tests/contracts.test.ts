import { describe, expect, it } from "vitest";
import {
  articleFilterSchema,
  feedSchema,
  feedUpdatedResponseSchema,
  markReadRequestSchema,
  settingsPatchSchema,
  themeSchema,
  updateFeedSchema,
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

  it("updateFeedSchema accepte un rank seul (réordonnancement, #111)", () => {
    expect(updateFeedSchema.safeParse({ rank: "a0" }).success).toBe(true);
  });

  it("updateFeedSchema rejette un rank vide", () => {
    expect(updateFeedSchema.safeParse({ rank: "" }).success).toBe(false);
  });

  it("updateFeedSchema exige au moins un champ (rank compte, #111)", () => {
    expect(updateFeedSchema.safeParse({}).success).toBe(false);
  });

  it("updateFeedSchema accepte folderId + rank ensemble (#112)", () => {
    expect(
      updateFeedSchema.safeParse({ folderId: "fo1", rank: "a0" }).success,
    ).toBe(true);
  });

  it("feedUpdatedResponseSchema écho un rank optionnel (#111)", () => {
    expect(
      feedUpdatedResponseSchema.safeParse({ id: "f1", rank: "a0" }).success,
    ).toBe(true);
    expect(feedUpdatedResponseSchema.safeParse({ id: "f1" }).success).toBe(
      true,
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
      rank: "a0",
    });
    expect(ok.success).toBe(true);
  });
});
