import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NameDialog } from "./NameDialog";

function setup(props: Partial<Parameters<typeof NameDialog>[0]> = {}) {
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <NameDialog
      open
      onClose={onClose}
      title="Nouveau dossier"
      label="Nom du dossier"
      submitLabel="Créer"
      onSubmit={onSubmit}
      {...props}
    />,
  );
  return { onSubmit, onClose, user: userEvent.setup() };
}

describe("NameDialog", () => {
  it("préremplit le champ et soumet la valeur rognée", async () => {
    const { onSubmit, user } = setup({ initialValue: "Tech" });
    const input = screen.getByLabelText("Nom du dossier");
    expect(input).toHaveValue("Tech");

    await user.clear(input);
    await user.type(input, "  Actu  ");
    await user.click(screen.getByRole("button", { name: "Créer" }));

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Actu");
  });

  it("désactive la soumission quand le champ est vide", async () => {
    setup();
    expect(screen.getByRole("button", { name: "Créer" })).toBeDisabled();
  });

  it("affiche le message d'erreur fourni", () => {
    setup({ errorText: "Création impossible, réessayez." });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Création impossible, réessayez.",
    );
  });
});
