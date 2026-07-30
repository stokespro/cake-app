// SERVER-ONLY — never import this from a client component or 'use client' file.
// This module uses next/headers and Node.js crypto, which are not available in
// the browser bundle. If you accidentally import it client-side, Next.js will
// throw at build time because of the `cookies()` import.

import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { NO_SESSION_REASON } from '@/lib/auth/session-errors';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, buildSessionCookieOptions } from '@/lib/auth/session-constants';

// Re-exported for existing importers (many call sites do
// `import { SESSION_COOKIE } from '@/lib/auth/session'`). The canonical
// definitions now live in the runtime-neutral session-constants.ts so
// Edge-safe modules (lib/supabase/middleware.ts) can use them without
// pulling in this file's node:crypto / next/headers imports.
export { SESSION_COOKIE, SESSION_TTL_SECONDS };

// ---------------------------------------------------------------------------
// Secret key
// ---------------------------------------------------------------------------

/**
 * Returns the SESSION_SECRET from env.
 *
 * REQUIRED: Add SESSION_SECRET to your Vercel environment variables.
 * Generate a strong secret: `openssl rand -hex 32`
 *
 * If the variable is missing we throw — fail closed, never silently use a
 * weak default.
 */
function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET environment variable is not set. ' +
      'Add it to your .env.local and Vercel environment variables. ' +
      'Generate one with: openssl rand -hex 32'
    );
  }
  return secret;
}

// ---------------------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------------------

// Cookie payload format: <userId>.<hmac-hex>
// The HMAC covers only the userId so the cookie expands minimally.
// The actual role is always re-fetched from the DB on each verifySession() call.

function signUserId(userId: string): string {
  const secret = getSecret();
  const sig = createHmac('sha256', secret).update(userId).digest('hex');
  return `${userId}.${sig}`;
}

function verifySignature(cookieValue: string): string | null {
  const dotIndex = cookieValue.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const userId = cookieValue.slice(0, dotIndex);
  const receivedSig = cookieValue.slice(dotIndex + 1);

  if (!userId || !receivedSig) return null;

  let secret: string;
  try {
    secret = getSecret();
  } catch {
    // SESSION_SECRET missing — deny access rather than crash the request
    console.error('[session] SESSION_SECRET is not set — all sessions are invalid');
    return null;
  }

  const expectedSig = createHmac('sha256', secret).update(userId).digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    const expected = Buffer.from(expectedSig, 'hex');
    const received = Buffer.from(receivedSig, 'hex');
    if (expected.length !== received.length) return null;
    if (!timingSafeEqual(expected, received)) return null;
  } catch {
    return null;
  }

  return userId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VerifiedSession {
  userId: string;
  role: string;
  name: string;
}

/**
 * Set the crm-session cookie after a successful PIN login.
 * Call this from a server action only.
 *
 * Fail-CLOSED: if SESSION_SECRET is missing (or signing otherwise fails) this
 * throws instead of silently returning. A login that "succeeds" without ever
 * setting the server cookie leaves the client in a permanently zeroed state —
 * every server action's requireRole() fails with "No valid session" forever,
 * with no way for the user to recover short of an admin fixing the env var.
 * Callers (see actions/auth.ts) must catch this and surface a clear error
 * rather than returning `{ success: true }`.
 */
export async function setSessionCookie(userId: string): Promise<void> {
  const signed = signUserId(userId); // throws if SESSION_SECRET is missing

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, signed, buildSessionCookieOptions({ maxAge: SESSION_TTL_SECONDS }));
}

// Note: there used to be a `refreshSessionCookie` here — a pure one-line
// alias for setSessionCookie (same signature, same body, only the docstring
// differed). Sliding expiration is "set the cookie again with a fresh
// maxAge", which setSessionCookie already does; callers (actions/auth.ts's
// refreshSessionCookieAction) now call setSessionCookie directly.

/**
 * Clear the crm-session cookie on logout.
 * Call this from a server action only.
 *
 * Passes the same `path` used at set time (via buildSessionCookieOptions) —
 * cookie deletion is matched by name AND path, so a delete call with no path
 * (or a different one) silently fails to remove a cookie set with `path: '/'`.
 */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete({ name: SESSION_COOKIE, path: buildSessionCookieOptions().path });
}

/**
 * Result of checkSession() — distinguishes a definitive "logged out" state
 * from an inconclusive infrastructure failure. This distinction matters to
 * callers like AuthProvider: a `no cookie / bad signature / user deleted`
 * result should hard-clear the client's cached session (that's the fix for
 * the "silent logout" bug — the client must not keep believing it's logged
 * in once the server says otherwise), but a transient DB/service-client
 * failure should NOT log the user out — that would turn a network blip into
 * an outage for every logged-in user.
 */
export type SessionCheck =
  | { status: 'valid'; session: VerifiedSession }
  | { status: 'unauthenticated' } // no cookie, or bad signature — definitively logged out
  | { status: 'error' }; // DB/service-client failure — inconclusive, do NOT log the user out

/**
 * Check the current crm-session cookie and return a discriminated result.
 *
 * - Validates the HMAC signature (tamper detection)
 * - Re-fetches the user's current role from public.users (never trusts a
 *   role baked into the cookie)
 * - `unauthenticated`: missing cookie, bad signature, or the user row no
 *   longer exists (deleted user) — all definitively "not logged in".
 * - `error`: creating the service client or querying `users` failed — the
 *   session may still be valid, we just couldn't confirm it.
 */
export async function checkSession(): Promise<SessionCheck> {
  let cookieStore: Awaited<ReturnType<typeof cookies>>;
  try {
    cookieStore = await cookies();
  } catch {
    return { status: 'error' };
  }

  const cookieValue = cookieStore.get(SESSION_COOKIE)?.value;
  if (!cookieValue) return { status: 'unauthenticated' };

  const userId = verifySignature(cookieValue);
  if (!userId) return { status: 'unauthenticated' };

  // Re-read role from DB — do not trust anything in the cookie beyond userId
  let serviceClient: Awaited<ReturnType<typeof createServiceClient>>;
  try {
    serviceClient = await createServiceClient();
  } catch (err) {
    console.error('[session] Failed to create service client:', err);
    return { status: 'error' };
  }

  // `.maybeSingle()`, not `.single()`: `.single()` returns an ERROR
  // (PostgREST code PGRST116) when zero rows match, it does NOT resolve
  // `{ data: null, error: null }`. With `.single()` a deleted user would hit
  // the `if (error)` branch below and be classified `error` — which
  // AuthProvider deliberately treats as "keep the cached session" — so a
  // deleted user's session would never be recognized as dead. `.maybeSingle()`
  // correctly returns `{ data: null, error: null }` for zero rows, letting
  // the `if (!data)` branch below do its job.
  const { data, error } = await serviceClient
    .from('users')
    .select('id, name, role')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    // Defensive: `.maybeSingle()` should never itself produce PGRST116 (that
    // code is specifically `.single()`'s "0 or >1 rows" signal), but if some
    // other codepath or a future Supabase client change ever does, it means
    // "no row" — not an inconclusive infrastructure failure — so treat it the
    // same as the `!data` case just below rather than as `error`.
    if ((error as { code?: string }).code === 'PGRST116') {
      return { status: 'unauthenticated' };
    }
    console.error('[session] users lookup failed:', error);
    return { status: 'error' };
  }

  if (!data) {
    // Query succeeded but the row is gone — the user was deleted.
    return { status: 'unauthenticated' };
  }

  return {
    status: 'valid',
    session: {
      userId: data.id,
      role: data.role,
      name: data.name,
    },
  };
}

/**
 * Verify the current crm-session cookie and return the authenticated user.
 *
 * Thin wrapper around checkSession() — returns null for anything that isn't
 * a `valid` result (both `unauthenticated` and `error` collapse to null here
 * since this function's callers, e.g. requireRole(), only ever need a
 * binary allow/deny and always fail closed).
 */
export async function verifySession(): Promise<VerifiedSession | null> {
  const result = await checkSession();
  return result.status === 'valid' ? result.session : null;
}

// ---------------------------------------------------------------------------
// Role guards
// ---------------------------------------------------------------------------

export type UnauthorizedResult = { authorized: false; reason: string };
export type AuthorizedResult<T> = { authorized: true; session: T };

/**
 * Verify session and assert the user's role is in the allowed list.
 * Returns { authorized: true, session } or { authorized: false, reason }.
 *
 * Usage in a server action:
 *   const auth = await requireRole(['admin', 'management']);
 *   if (!auth.authorized) return { error: auth.reason };
 *   // auth.session.role, auth.session.userId are safe to use
 */
export async function requireRole(
  allowedRoles: string[]
): Promise<AuthorizedResult<VerifiedSession> | UnauthorizedResult> {
  const session = await verifySession();
  if (!session) {
    return { authorized: false, reason: NO_SESSION_REASON };
  }
  if (!allowedRoles.includes(session.role)) {
    return {
      authorized: false,
      reason: `Role '${session.role}' is not authorized for this action`,
    };
  }
  return { authorized: true, session };
}

/**
 * Convenience guard for finance/management screens.
 * Allowed roles: admin, management.
 */
export async function requireFinance(): Promise<
  AuthorizedResult<VerifiedSession> | UnauthorizedResult
> {
  return requireRole(['admin', 'management']);
}
