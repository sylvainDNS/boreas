import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import {
  SETTINGS_QUERY_KEY,
  settingsQueryOptions,
  updateSettingsMutationOptions,
} from "./settings";

vi.mock("./api", async (importActual) => {
  const actual = await importActual<typeof import("./api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

function fakeQueryClient() {
  const setQueryData = vi.fn();
  return {
    client: { setQueryData } as unknown as QueryClient,
    setQueryData,
  };
}

afterEach(() => {
  mockedFetch.mockReset();
});

describe("settingsQueryOptions (#18)", () => {
  it("lit GET /settings", async () => {
    mockedFetch.mockResolvedValueOnce({
      refreshIntervalMin: 30,
      purgeWindowDays: 60,
      theme: "system",
    });
    const opts = settingsQueryOptions();
    expect(opts.queryKey).toEqual(SETTINGS_QUERY_KEY);
    if (typeof opts.queryFn !== "function") throw new Error("queryFn manquant");

    const data = await opts.queryFn({} as never);
    expect(mockedFetch).toHaveBeenCalledWith("/settings");
    expect(data).toEqual({
      refreshIntervalMin: 30,
      purgeWindowDays: 60,
      theme: "system",
    });
  });
});

describe("updateSettingsMutationOptions (#18)", () => {
  it("PATCH /settings avec le corps fourni et écrit le cache depuis la réponse", async () => {
    const updated = {
      refreshIntervalMin: 60,
      purgeWindowDays: 60,
      theme: "system" as const,
    };
    mockedFetch.mockResolvedValueOnce(updated);
    const { client, setQueryData } = fakeQueryClient();
    const opts = updateSettingsMutationOptions(client);

    const data = await opts.mutationFn({ refreshIntervalMin: 60 });
    expect(mockedFetch).toHaveBeenCalledWith("/settings", {
      method: "PATCH",
      body: JSON.stringify({ refreshIntervalMin: 60 }),
    });

    opts.onSuccess(data);
    expect(setQueryData).toHaveBeenCalledWith(SETTINGS_QUERY_KEY, updated);
  });
});
