// Client-safe module — no `next/headers`, no Node built-ins. Safe to import
// from both server code (lib/auth/session.ts) and client components
// ('use client' files like lib/auth-context.tsx) so the "no valid session"
// contract can never drift between the two.

export const NO_SESSION_REASON = 'No valid session';

/**
 * Returns true when `error` represents the well-known "no valid session"
 * condition produced by `requireRole()` / `checkSession()`.
 *
 * Accepts:
 * - the bare string `'No valid session'`
 * - an `Error` whose `.message` is that string
 * - a plain object with an `.error` field equal to that string (the shape
 *   server actions typically return, e.g. `{ error: auth.reason }`)
 */
export function isSessionError(error: unknown): boolean {
  if (error === NO_SESSION_REASON) return true;

  if (error instanceof Error) {
    return error.message === NO_SESSION_REASON;
  }

  if (typeof error === 'object' && error !== null) {
    const maybe = error as { error?: unknown; message?: unknown };
    if (maybe.error === NO_SESSION_REASON) return true;
    if (maybe.message === NO_SESSION_REASON) return true;
  }

  return false;
}
