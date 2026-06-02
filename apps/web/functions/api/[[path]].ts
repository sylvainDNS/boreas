// Pages Function catch-all sur /api/* : proxie chaque requête vers le Worker
// boreas-api via le service binding `API` (env.API.fetch(), zéro hop réseau — ADR 0008).
// La requête est transmise entière ; Hono dans boreas-api matche /api/health tel quel.
interface Env {
  API: { fetch(request: Request): Promise<Response> };
}

export const onRequest = (context: {
  env: Env;
  request: Request;
}): Promise<Response> => context.env.API.fetch(context.request);
