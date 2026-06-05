/** Erreur API portant le code HTTP, pour distinguer 400 / 401 / 5xx côté UI. */
export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`Requête API échouée (${status})`);
    this.name = "ApiError";
  }
}

/**
 * Appel `/api/*` même origine. `credentials: "include"` fait circuler le cookie
 * de session (`SameSite=Strict`, zéro CORS — ADR 0008). Lève `ApiError` si la
 * réponse n'est pas 2xx.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}
