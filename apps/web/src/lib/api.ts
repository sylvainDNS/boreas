/**
 * Erreur API portant le code HTTP (distinguer 400 / 401 / 5xx) et le `code`
 * applicatif du corps (`{ error: "already_subscribed" }`, …) quand il existe —
 * l'UI s'en sert pour afficher un message ciblé (ex. abonnement, #12).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null = null,
  ) {
    super(`Requête API échouée (${status}${code ? ` ${code}` : ""})`);
    this.name = "ApiError";
  }
}

/**
 * Appel `/api/*` même origine. `credentials: "include"` fait circuler le cookie
 * de session (`SameSite=Strict`, zéro CORS — ADR 0008). Lève `ApiError` si la
 * réponse n'est pas 2xx, en y joignant le `code` d'erreur du corps s'il s'y trouve.
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
  if (!res.ok) {
    // Le corps d'erreur est du JSON `{ error: code }` ; on l'extrait sans
    // jamais faire échouer le `throw` si le corps est absent ou non-JSON.
    const code = await res
      .json()
      .then((body) =>
        body && typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null,
      )
      .catch(() => null);
    throw new ApiError(res.status, code);
  }
  // 204 No Content (ex. désabonnement push, #79) : pas de corps à parser.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
