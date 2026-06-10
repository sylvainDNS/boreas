import { z } from "zod";

/** Demande de magic link (#5) : adresse e-mail valide. */
export const authRequestSchema = z.object({ email: z.string().email() });
export type AuthRequest = z.infer<typeof authRequestSchema>;

/** `POST /api/auth/request` — réponse générique anti-énumération. */
export const authRequestResponseSchema = z.object({ status: z.literal("ok") });
export type AuthRequestResponse = z.infer<typeof authRequestResponseSchema>;

/** `GET /api/auth/session` — état pour le guard du SPA (200 ou 401). */
export const sessionResponseSchema = z.object({ authenticated: z.boolean() });
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
