import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../../lib/api";
import type { Feed } from "../../lib/feeds";
import { stubApi } from "../../test/api-mock";
import { renderWithApp } from "../../test/render";
import { FeedRow } from "./FeedRow";
import type { SidebarDialog } from "./sidebar-model";

vi.mock("../../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/api")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockedFetch.mockReset();
});

function makeFeed(over: Partial<Feed> = {}): Feed {
  return {
    id: "f1",
    url: "https://example.com/f1",
    title: "Mon flux",
    status: "ok",
    lastError: null,
    lastCheckAt: null,
    folderId: null,
    rank: "a0",
    ...over,
  };
}

function renderRow(
  over: Partial<{
    feed: Feed;
    onRequestDialog: (d: SidebarDialog) => void;
    unread: number;
    online: boolean;
  }> = {},
) {
  stubApi(mockedFetch, {});
  const onRequestDialog = over.onRequestDialog ?? vi.fn();
  const feed = over.feed ?? makeFeed();
  const result = renderWithApp(
    <FeedRow
      feed={feed}
      unread={over.unread ?? 0}
      onRequestDialog={onRequestDialog}
      online={over.online ?? true}
    />,
    { initialPath: `/feeds/${feed.id}` },
  );
  return { ...result, onRequestDialog, feed };
}

describe("FeedRow", () => {
  it("marque la ligne active quand la route pointe sur ce feed", async () => {
    renderRow();
    const link = await screen.findByRole("link", { name: /Mon flux/ });
    // L'ancêtre « ligne » porte la classe active.
    expect(link.closest(".bg-surface-2")).not.toBeNull();
  });

  it("affiche le badge d'erreur quand le feed est en erreur", async () => {
    renderRow({ feed: makeFeed({ status: "error", lastError: "http_404" }) });
    expect(
      await screen.findByRole("img", { name: /Flux en erreur \(http_404\)/ }),
    ).toBeInTheDocument();
  });

  it("non-lu : affiche le point « non lu » et met le nom en gras", async () => {
    renderRow({ unread: 4 });
    const label = await screen.findByText("Mon flux");
    expect(label.className).toContain("font-medium");
    expect(screen.getByLabelText("non lu")).toBeInTheDocument();
    // Plus de pilule compteur : le chiffre des non-lus n'apparaît pas.
    expect(screen.queryByText("4")).toBeNull();
  });

  it("tout lu : pas de point et nom grisé", async () => {
    renderRow({ unread: 0 });
    const label = await screen.findByText("Mon flux");
    expect(label.className).toContain("text-muted");
    expect(screen.queryByLabelText("non lu")).toBeNull();
  });

  it("erreur + non-lu : le badge d'erreur et le point cohabitent", async () => {
    renderRow({
      feed: makeFeed({ status: "error", lastError: "http_404" }),
      unread: 2,
    });
    expect(
      await screen.findByRole("img", { name: /Flux en erreur/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("non lu")).toBeInTheDocument();
  });

  it("ouvre « Renommer » via le menu → onRequestDialog(renameFeed)", async () => {
    const { user, onRequestDialog, feed } = renderRow();
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Renommer…" }));
    expect(onRequestDialog).toHaveBeenCalledWith({ kind: "renameFeed", feed });
  });

  it("« Se désabonner » → onRequestDialog(unsubscribeFeed)", async () => {
    const { user, onRequestDialog, feed } = renderRow();
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Se désabonner" }));
    expect(onRequestDialog).toHaveBeenCalledWith({
      kind: "unsubscribeFeed",
      feed,
    });
  });

  it("le menu n'expose ni « Déplacer vers » ni « Supprimer… »", async () => {
    const { user } = renderRow();
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    // Seules les actions Renommer + Se désabonner subsistent (#113).
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Renommer…", "Se désabonner"]);
    expect(screen.queryByRole("menuitem", { name: "Supprimer…" })).toBeNull();
    expect(screen.queryByText("Déplacer vers")).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Aucun dossier/ }),
    ).toBeNull();
  });

  it("hors-ligne : désactive les ops du menu (renommer/désabonner)", async () => {
    const { user } = renderRow({ online: false });
    await user.click(
      await screen.findByRole("button", { name: /Actions pour/ }),
    );
    expect(screen.getByRole("menuitem", { name: "Renommer…" })).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Se désabonner" }),
    ).toBeDisabled();
  });
});
