import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = ReturnType<typeof getDb>;

/**
 * Crée une instance Drizzle à partir du binding D1 injecté par le runtime Cloudflare.
 * À appeler une fois par invocation de Worker (pas de pooling côté Workers).
 */
export function getDb(d1: D1Database): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(d1, { schema });
}
