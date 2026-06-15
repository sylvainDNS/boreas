import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api";
import {
  buildNotification,
  PushPermissionError,
  subscribeToPush,
  unsubscribeFromPush,
} from "./push";

vi.mock("./api", () => ({ apiFetch: vi.fn() }));
const mockedFetch = vi.mocked(apiFetch);

/** Clé publique VAPID jetable (point P-256 brut base64url, 65 octets). */
const VAPID_PUBLIC =
  "BG0EzmWZv1tkTgMUBSx4Q4O4sK1fb2ck-beCMM4Why8LLM0H4KzBxNA38yViOEmPx74moQpipn_HuF2PExp279M";

const SUBSCRIPTION_JSON = {
  endpoint: "https://push.example/sub/abc",
  keys: { p256dh: "client-p256dh", auth: "client-auth" },
};

function fakeRegistration(overrides: {
  subscribe?: ReturnType<typeof vi.fn>;
  getSubscription?: ReturnType<typeof vi.fn>;
}): ServiceWorkerRegistration {
  return {
    pushManager: {
      subscribe: overrides.subscribe ?? vi.fn(),
      getSubscription: overrides.getSubscription ?? vi.fn(async () => null),
    },
  } as unknown as ServiceWorkerRegistration;
}

function stubNotificationPermission(result: NotificationPermission): void {
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: vi.fn(async () => result),
  });
}

beforeEach(() => {
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY", VAPID_PUBLIC);
});

afterEach(() => {
  mockedFetch.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("buildNotification (#79)", () => {
  it("traduit un payload complet en arguments de showNotification", () => {
    const { title, options } = buildNotification({
      title: "Le Monde",
      body: "Un nouvel article est prêt",
      tag: "feed-123",
      url: "/feeds/123",
    });

    expect(title).toBe("Le Monde");
    expect(options.body).toBe("Un nouvel article est prêt");
    expect(options.tag).toBe("feed-123");
    // L'URL de tap est rangée dans `data` (lue par `notificationclick`).
    expect(options.data).toEqual({ url: "/feeds/123" });
  });

  it("retombe sur des valeurs par défaut quand le payload est vide", () => {
    const { title, options } = buildNotification({});

    expect(title).toBe("Boréas");
    expect(options.data).toEqual({ url: "/" });
  });
});

describe("subscribeToPush (#79)", () => {
  it("demande la permission, s'abonne et POSTe l'abonnement au serveur", async () => {
    stubNotificationPermission("granted");
    const subscribe = vi.fn(async (_options?: PushSubscriptionOptionsInit) => ({
      toJSON: () => SUBSCRIPTION_JSON,
    }));
    const registration = fakeRegistration({ subscribe });

    await subscribeToPush(registration);

    // `applicationServerKey` = clé VAPID décodée (point P-256 = 65 octets).
    expect(subscribe).toHaveBeenCalledTimes(1);
    const args = subscribe.mock.calls[0]?.[0];
    expect(args?.userVisibleOnly).toBe(true);
    const key = args?.applicationServerKey as Uint8Array;
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(65);

    expect(mockedFetch).toHaveBeenCalledWith("/push/subscribe", {
      method: "POST",
      body: JSON.stringify(SUBSCRIPTION_JSON),
    });
  });

  it("annule l'abonnement navigateur si l'enregistrement serveur échoue", async () => {
    stubNotificationPermission("granted");
    const unsubscribe = vi.fn(async () => true);
    const subscribe = vi.fn(async (_options?: PushSubscriptionOptionsInit) => ({
      toJSON: () => SUBSCRIPTION_JSON,
      unsubscribe,
    }));
    const registration = fakeRegistration({ subscribe });
    mockedFetch.mockRejectedValue(new Error("500"));

    await expect(subscribeToPush(registration)).rejects.toThrow();
    // Rollback : pas d'abonnement « fantôme » côté navigateur.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("lève si la permission est refusée, sans s'abonner ni appeler l'API", async () => {
    stubNotificationPermission("denied");
    const subscribe = vi.fn();
    const registration = fakeRegistration({ subscribe });

    await expect(subscribeToPush(registration)).rejects.toBeInstanceOf(
      PushPermissionError,
    );
    expect(subscribe).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe("unsubscribeFromPush (#79)", () => {
  it("supprime l'abonnement serveur puis se désabonne localement", async () => {
    const unsubscribe = vi.fn(async () => true);
    const getSubscription = vi.fn(async () => ({
      endpoint: SUBSCRIPTION_JSON.endpoint,
      unsubscribe,
    }));
    const registration = fakeRegistration({ getSubscription });

    await unsubscribeFromPush(registration);

    expect(mockedFetch).toHaveBeenCalledWith("/push/subscribe", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: SUBSCRIPTION_JSON.endpoint }),
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("ne fait rien s'il n'y a pas d'abonnement local", async () => {
    const getSubscription = vi.fn(async () => null);
    const registration = fakeRegistration({ getSubscription });

    await unsubscribeFromPush(registration);

    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
