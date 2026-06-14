import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdateBanner } from "./UpdateBanner";

/**
 * Tests du bandeau de mise à jour (#76). Le composant est **piloté par props**
 * (état `needRefresh` + callback) pour rester testable sans vrai service worker :
 * le wiring à `virtual:pwa-register/react` se fait dans `register-sw.tsx`.
 */

describe("UpdateBanner", () => {
  it("ne rend rien quand aucune MAJ n'est en attente", () => {
    const { container } = render(
      <UpdateBanner needRefresh={false} onUpdate={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("affiche le bandeau quand une nouvelle version est en attente", () => {
    render(<UpdateBanner needRefresh={true} onUpdate={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /mettre à jour/i }),
    ).toBeInTheDocument();
  });

  it("appelle onUpdate au clic sur le bouton", async () => {
    const onUpdate = vi.fn();
    render(<UpdateBanner needRefresh={true} onUpdate={onUpdate} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /mettre à jour/i }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
