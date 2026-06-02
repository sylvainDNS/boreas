// Gestion du thème clair/sombre du shell.
// Source de vérité côté client (localStorage) ; la synchro avec settings.theme
// (serveur) est différée à une tranche ultérieure (#5/#18).

/** Préférence choisie par l'utilisateur. Aligné sur l'enum `settings.theme` (D1). */
export type ThemePreference = "light" | "dark" | "system";
/** Thème effectivement appliqué (jamais "system"). */
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "boreas.theme";
const prefersDark = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

export function getStoredPreference(): ThemePreference {
  // localStorage peut lever (Safari « bloquer tous les cookies », mode privé) :
  // on retombe alors sur "system" plutôt que de faire échouer le montage de l'app.
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return "system";
  }
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return prefersDark() ? "dark" : "light";
  return pref;
}

/** Applique le thème résolu en posant `data-theme` sur <html>. */
function applyTheme(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/** Persiste la préférence et l'applique immédiatement. */
export function setPreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Stockage indisponible : le thème s'applique pour la session, sans persistance.
  }
  applyTheme(pref);
}

/** À appeler une fois au démarrage : applique le thème + suit les changements
 *  système tant que la préférence est "system". Retourne une fonction de nettoyage. */
export function initTheme(): () => void {
  applyTheme(getStoredPreference());
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getStoredPreference() === "system") applyTheme("system");
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
