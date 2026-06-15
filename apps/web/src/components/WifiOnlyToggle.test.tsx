import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWifiOnly } from "../lib/wifi-only";
import { WifiOnlyToggle } from "./WifiOnlyToggle";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("WifiOnlyToggle (#81)", () => {
  it("est non coché par défaut (off)", () => {
    render(<WifiOnlyToggle />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("bascule la préférence locale au clic et persiste", async () => {
    const user = userEvent.setup();
    render(<WifiOnlyToggle />);
    const toggle = screen.getByRole("switch");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(getWifiOnly()).toBe(true);
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(getWifiOnly()).toBe(false);
  });

  it("reflète une préférence déjà persistée au montage", () => {
    localStorage.setItem("boreas.wifiOnly", "1");
    render(<WifiOnlyToggle />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });
});
