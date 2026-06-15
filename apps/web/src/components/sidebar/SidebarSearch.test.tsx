import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithApp } from "../../test/render";
import { SidebarSearch } from "./SidebarSearch";

describe("SidebarSearch", () => {
  it("soumettre une requête navigue vers /search?q=<requête>", async () => {
    const { user, router } = renderWithApp(<SidebarSearch />);

    const input = await screen.findByRole("searchbox", {
      name: "Rechercher des articles",
    });
    await user.type(input, "climat{Enter}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
    expect(router.state.location.search).toMatchObject({ q: "climat" });
  });

  it("ne navigue pas sur une requête vide (espaces seuls)", async () => {
    const { user, router } = renderWithApp(<SidebarSearch />);
    const input = await screen.findByRole("searchbox");
    await user.type(input, "   {Enter}");
    // Reste sur la route initiale.
    expect(router.state.location.pathname).toBe("/");
  });

  it("initialise le champ sur la requête courante (deep-link)", async () => {
    renderWithApp(<SidebarSearch initialQuery="vent" />);
    expect(await screen.findByRole("searchbox")).toHaveValue("vent");
  });
});
