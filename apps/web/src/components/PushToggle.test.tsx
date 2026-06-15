import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getReadyRegistration,
  isPushSupported,
  PushPermissionError,
  subscribeToPush,
  unsubscribeFromPush,
} from "../lib/push";
import { PushToggle } from "./PushToggle";

vi.mock("../lib/push", async (importActual) => {
  const actual = await importActual<typeof import("../lib/push")>();
  return {
    ...actual,
    isPushSupported: vi.fn(() => true),
    getReadyRegistration: vi.fn(),
    subscribeToPush: vi.fn(),
    unsubscribeFromPush: vi.fn(),
  };
});

const mockedSupported = vi.mocked(isPushSupported);
const mockedRegistration = vi.mocked(getReadyRegistration);
const mockedSubscribe = vi.mocked(subscribeToPush);
const mockedUnsubscribe = vi.mocked(unsubscribeFromPush);

/** Registration factice : seul `pushManager.getSubscription` est consulté ici. */
function fakeRegistration(hasSubscription: boolean): ServiceWorkerRegistration {
  return {
    pushManager: {
      getSubscription: vi.fn(async () =>
        hasSubscription ? { endpoint: "https://push.example/x" } : null,
      ),
    },
  } as unknown as ServiceWorkerRegistration;
}

function stubPermission(permission: NotificationPermission): void {
  vi.stubGlobal("Notification", { permission });
}

beforeEach(() => {
  mockedSupported.mockReturnValue(true);
  mockedRegistration.mockResolvedValue(fakeRegistration(false));
  stubPermission("default");
});

afterEach(() => {
  mockedSubscribe.mockReset();
  mockedUnsubscribe.mockReset();
  vi.unstubAllGlobals();
});

describe("PushToggle (#79)", () => {
  it("n'affiche rien si le Web Push n'est pas supporté", () => {
    mockedSupported.mockReturnValue(false);
    const { container } = render(<PushToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it("est décoché quand aucun abonnement n'existe au montage", async () => {
    render(<PushToggle />);
    const toggle = await screen.findByRole("switch");
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "false"),
    );
  });

  it("est coché quand un abonnement existe déjà au montage", async () => {
    mockedRegistration.mockResolvedValue(fakeRegistration(true));
    render(<PushToggle />);
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("active les notifications au clic (abonnement)", async () => {
    mockedSubscribe.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PushToggle />);
    const toggle = await screen.findByRole("switch");

    await user.click(toggle);

    expect(mockedSubscribe).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("désactive les notifications au clic quand déjà abonné", async () => {
    mockedRegistration.mockResolvedValue(fakeRegistration(true));
    mockedUnsubscribe.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PushToggle />);
    const toggle = await screen.findByRole("switch");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));

    await user.click(toggle);

    expect(mockedUnsubscribe).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "false"),
    );
  });

  it("affiche un indice et désactive le switch si la permission est bloquée", async () => {
    stubPermission("denied");
    render(<PushToggle />);
    const toggle = await screen.findByRole("switch");
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("affiche un indice si l'abonnement échoue sur permission refusée", async () => {
    mockedSubscribe.mockRejectedValue(new PushPermissionError("denied"));
    const user = userEvent.setup();
    render(<PushToggle />);
    const toggle = await screen.findByRole("switch");

    await user.click(toggle);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
