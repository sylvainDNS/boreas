import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type AnyRouter,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { RouterContext } from "../routes/__root";

/**
 * Harness de tests d'intégration SPA : QueryClient **réel** + TanStack Router en
 * mémoire + `apiFetch` mocké (cf. `api-mock.ts`). Débloque les tests qui montent
 * un vrai arbre de routes (Sidebar, navigation, `useMatchRoute`), impossibles
 * avec le rendu de composant isolé.
 *
 * Proscription des fake timers : les listes d'articles posent un
 * `refetchInterval` de 60 s qui, combiné aux timers simulés de `userEvent`,
 * gèle l'horloge et fait diverger les tests. On reste sur l'horloge réelle.
 */

/**
 * QueryClient de test : `retry` désactivé (un échec attendu ne doit pas être
 * relancé et ralentir le test) et `gcTime: 0` (pas de cache résiduel entre tests
 * partageant par accident le même client).
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Composant de route feuille inerte : remplissage pour les routes dont on ne
 * teste pas le contenu (on veut juste que le chemin existe pour que
 * `Link`/`navigate` y mènent). Le `<Outlet/>` couvre d'éventuels enfants futurs.
 */
function Empty() {
  return <Outlet />;
}

/**
 * Construit l'arbre de routes de test **en code** (jamais via `routeTree.gen.ts`,
 * généré et couplé au système de fichiers). Les chemins doivent rester alignés
 * sur les routes réelles — toute divergence est un faux signal de test.
 *
 * Cf. `apps/web/src/routeTree.gen.ts` (FileRoutesByFullPath) :
 *   `/` `/login` `/saved` `/search` `/settings` `/feeds/$feedId` `/folders/$folderId`.
 * La pathless layout `_shell` enveloppe tout sauf `/login`, mais ici on aplatit
 * sous la racine : la sémantique des chemins testés est identique.
 *
 * Le composant testé est rendu par la **racine** (au-dessus de l'`Outlet`) : il
 * reste donc monté quelle que soit la navigation, ce qui permet de tester `Link`
 * et `useNavigate` sans que le composant se démonte en changeant de route. Les
 * routes feuilles existent comme cibles de navigation (composant `Empty`).
 */
function buildTestRouteTree(renderUi: () => ReactNode) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => (
      <>
        {renderUi()}
        <Outlet />
      </>
    ),
  });

  const makeLeaf = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: Empty });

  return rootRoute.addChildren([
    makeLeaf("/"),
    makeLeaf("/login"),
    makeLeaf("/saved"),
    makeLeaf("/search"),
    makeLeaf("/settings"),
    makeLeaf("/feeds/$feedId"),
    makeLeaf("/folders/$folderId"),
  ]);
}

/** Résultat commun du rendu : l'utilisateur simulé, le client et le routeur. */
export interface RenderAppResult {
  user: ReturnType<typeof userEvent.setup>;
  client: QueryClient;
  /**
   * Routeur mémoire monté. Typé `AnyRouter` (l'arbre de routes de test est
   * construit en code, sans l'augmentation de module de `routeTree.gen.ts`) :
   * suffisant pour asserter `router.state.location.pathname`.
   */
  router: AnyRouter;
}

export interface RenderAppOptions {
  /** Chemin initial de l'historique mémoire (défaut `/`). */
  initialPath?: string;
  /** Client à réutiliser (défaut : un client de test frais). */
  client?: QueryClient;
}

/**
 * Monte `ui` au-dessus de l'`Outlet` de la racine d'un routeur mémoire, sous un
 * vrai QueryClientProvider. `ui` reste donc monté quelle que soit la route
 * courante et peut utiliser `Link`, `useNavigate`, `useMatchRoute` ; les routes
 * feuilles de l'arbre (`/saved`, `/settings`, …) existent comme cibles.
 *
 * Retourne `{ user, client, router }` pour asserter la navigation via
 * `router.state.location.pathname`.
 */
export function renderWithApp(
  ui: ReactNode,
  {
    initialPath = "/",
    client = createTestQueryClient(),
  }: RenderAppOptions = {},
): RenderAppResult {
  const routeTree = buildTestRouteTree(() => ui);
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  render(
    <QueryClientProvider client={client}>
      {/* biome-ignore lint/suspicious/noExplicitAny: routeTree de test (non typé par routeTree.gen.ts) */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );

  return { user: userEvent.setup(), client, router };
}

/**
 * Wrapper pour `renderHook` (hooks consommant QueryClient et/ou le routeur).
 * Même câblage que `renderWithApp`, exposé comme composant wrapper.
 *
 * Le routeur et l'arbre de routes sont construits **une seule fois** (à la
 * création du wrapper, hors du composant rendu) : les reconstruire à chaque
 * rendu réinitialiserait l'état du routeur à chaque re-rendu du hook testé. Le
 * `children` (où `renderHook` exécute le hook) est lu via une indirection stable
 * pour rester à jour sans recréer le routeur.
 */
export function createAppWrapper({
  initialPath = "/",
  client = createTestQueryClient(),
}: RenderAppOptions = {}) {
  // Conteneur mutable : la racine lit toujours le dernier `children` fourni par
  // `renderHook`, sans que le routeur dépende de cette valeur changeante.
  let current: ReactNode = null;
  const routeTree = buildTestRouteTree(() => current);
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return function AppWrapper({ children }: { children: ReactNode }) {
    current = children;
    return (
      <QueryClientProvider client={client}>
        {/* biome-ignore lint/suspicious/noExplicitAny: routeTree de test (non typé par routeTree.gen.ts) */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>
    );
  };
}
