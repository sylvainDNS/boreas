import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { menuItemClass, RowMenu } from "./RowMenu";

function setup() {
  const onSelect = vi.fn();
  const user = userEvent.setup();
  render(
    <RowMenu label="Actions">
      {(close) => (
        <button
          type="button"
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
  return { onSelect, user };
}

describe("RowMenu", () => {
  it("ouvre le menu au clic et le ferme après sélection", async () => {
    const { onSelect, user } = setup();
    const trigger = screen.getByRole("button", { name: "Actions" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: "Renommer…" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("ferme le menu sur Échap", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
