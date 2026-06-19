import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { menuItemClass, RowMenu } from "./RowMenu";

function setup() {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <RowMenu label="Actions" position={{ x: 10, y: 20 }} onClose={onClose}>
      {(close) => (
        <button
          type="button"
          role="menuitem"
          className={menuItemClass}
          onClick={() => {
            close();
            onSelect();
          }}
        >
          Renommer…
        </button>
      )}
    </RowMenu>,
  );
  return { onSelect, onClose, user };
}

describe("RowMenu", () => {
  it("rend le popover ancré, labellisé, avec ses entrées", () => {
    setup();
    const menu = screen.getByRole("menu", { name: "Actions" });
    expect(menu).toBeInTheDocument();
    // Ancré en viewport (`position: fixed` via Tailwind) à des coordonnées inline.
    expect(menu.className).toContain("fixed");
    expect(menu).toHaveStyle({ left: "10px", top: "20px" });
    expect(
      screen.getByRole("menuitem", { name: "Renommer…" }),
    ).toBeInTheDocument();
  });

  it("referme via le `close` passé aux entrées après sélection", async () => {
    const { onSelect, onClose, user } = setup();
    await user.click(screen.getByRole("menuitem", { name: "Renommer…" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
