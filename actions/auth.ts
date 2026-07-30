'use server';

import { createServiceClient } from '@/lib/supabase/server';
import { setSessionCookie, clearSessionCookie, verifySession, checkSession, type SessionCheck } from '@/lib/auth/session';
import { isUserRole, type UserRole } from '@/lib/auth/session-constants';

export interface SessionUser {
  id: string;
  name: string;
  role: UserRole;
}

export async function authenticateByPin(pin: string): Promise<{ success: boolean; user?: SessionUser; error?: string }> {
  if (!/^\d{4}$/.test(pin)) {
    return { success: false, error: 'Invalid PIN format' };
  }

  const serviceSupabase = await createServiceClient();

  const { data, error } = await serviceSupabase
    .from('users')
    .select('id, name, role')
    .eq('pin', pin)
    .single();

  if (error || !data) {
    return { success: false, error: 'Invalid PIN' };
  }

  // The `role` column is free-text in the DB (untyped Supabase client — see
  // lib/supabase/server.ts), so it must be validated before it's trusted as
  // a `UserRole`. Do NOT `as UserRole` this — an unrecognized role (typo,
  // stale enum value, bad manual DB edit) must fail closed here rather than
  // flow into role-gated UI unchecked.
  if (!isUserRole(data.role)) {
    console.error(`[auth] user ${data.id} has an unrecognized role '${data.role}' — refusing login`);
    return {
      success: false,
      error: 'Account has an invalid role. Contact an administrator.',
    };
  }

  // Set a secure, HttpOnly, server-readable session cookie containing the
  // user's id signed with SESSION_SECRET. The role is never baked in — it is
  // re-read from public.users on every verifySession() call.
  //
  // Fail CLOSED: setSessionCookie() now throws if it can't set the cookie
  // (e.g. SESSION_SECRET missing). Previously this was swallowed and login
  // "succeeded" anyway, leaving the client believing it was logged in while
  // every server action's requireRole() would fail forever with "No valid
  // session" — a silent, unrecoverable zeroed-data state. Surface it instead.
  try {
    await setSessionCookie(data.id);
  } catch (err) {
    console.error('[auth] setSessionCookie failed — aborting login:', err);
    return {
      success: false,
      error: 'Server session could not be established. Contact an administrator.',
    };
  }

  return {
    success: true,
    user: {
      id: data.id,
      name: data.name,
      role: data.role,
    },
  };
}

/**
 * Server action: clear the crm-session cookie.
 * Call this from the client-side logout handler alongside localStorage clearing.
 */
export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
}

/**
 * Server action: return the CURRENT authenticated user's id/name/role, read
 * fresh from `public.users` via the signed `crm-session` cookie.
 *
 * Why this exists: the client-side session (`localStorage['crm-user']`) is
 * only ever populated once, at PIN-login time (see `authenticateByPin`
 * above). If an admin changes a user's role directly in the database (e.g.
 * via the Users admin page or a one-off SQL update) while that user is
 * already logged in — which is the normal case for long-lived kiosk/wall-
 * display sessions — their cached client-side role goes stale and never
 * self-corrects until they explicitly log out and back in. Server actions
 * always re-verify the role fresh (via `requireRole`/`verifySession`), so
 * reads/writes that are actually gated stay correct; but client-side UI
 * gates (e.g. "does this role see the Mark Complete button?") were relying
 * on the stale cached value and could hide controls a user's role now
 * legitimately has access to (or, in principle, keep showing controls a
 * demoted role should no longer see).
 *
 * Callers should use this to periodically reconcile their cached session
 * (see `AuthProvider` and the cultivation wall-display pages) rather than
 * trusting `localStorage['crm-user']` indefinitely.
 */
export async function getCurrentSession(): Promise<SessionUser | null> {
  const session = await verifySession();
  if (!session) return null;
  // Same DB-role validation as authenticateByPin above — verifySession()'s
  // role comes straight from public.users and isn't pre-validated.
  if (!isUserRole(session.role)) {
    console.error(`[auth] user ${session.userId} has an unrecognized role '${session.role}'`);
    return null;
  }
  return {
    id: session.userId,
    name: session.name,
    role: session.role,
  };
}

/**
 * Server action wrapper around lib/auth/session.ts's checkSession(), for use
 * from client components (AuthProvider). Unlike getCurrentSession()/
 * verifySession(), this preserves the distinction between "definitively
 * logged out" (`unauthenticated`) and "couldn't confirm, infrastructure
 * hiccup" (`error`) — AuthProvider uses this to decide whether to hard-clear
 * the cached client session (silent-logout fix) or keep it and retry later.
 *
 * This is a pure read — it has NO side effects on the cookie. Sliding
 * expiration used to be bolted on here unconditionally (refreshing the
 * cookie on every `valid` result), but that meant a check that started
 * before a concurrent logout() and resolved after it could resurrect the
 * server session with a fresh 7-day maxAge on a device the operator just
 * signed out of — the client had no way to veto a refresh that already
 * happened server-side inside this same call. Refreshing is now a separate,
 * explicit step (see `refreshSessionCookieAction` below) that the caller
 * only invokes once it has confirmed the result is still current (see
 * lib/auth-context.tsx's logout-epoch guard).
 */
export async function checkSessionAction(): Promise<SessionCheck> {
  return checkSession();
}

/**
 * Server action: slide the crm-session cookie's expiration forward. Split out
 * from checkSessionAction (see its docstring) so the caller can decide
 * *whether* to call this at all — specifically, so a session check that
 * resolves after a concurrent logout() can skip this entirely instead of
 * unconditionally resurrecting the cookie the user just cleared.
 *
 * SECURITY: this takes NO parameters. The identity being refreshed is always
 * derived server-side from the caller's own verified `crm-session` cookie
 * (via verifySession()) — never from client input. This action used to
 * accept a `userId` argument and mint a signed session cookie for whatever id
 * was passed in, with no check that it belonged to the caller or that the
 * caller was even logged in. Because a `'use server'` export is reachable as
 * its own POST endpoint (not gated by client-side route guards or the
 * document-only middleware redirect), that was a full unauthenticated
 * session-minting oracle: any caller who could learn another user's id (e.g.
 * an admin's UUID surfaced by an unrelated, lower-privilege-gated action)
 * could POST it here and receive a validly signed session cookie for that
 * user, indistinguishable from a real PIN login. Fail closed: if there is no
 * valid session, do nothing — no cookie is written.
 *
 * Why sliding expiration needs to exist at all: unattended
 * /cultivation-display wall displays and warehouse kiosks load once and then
 * just sit there polling via server actions/RSC for days.
 * lib/supabase/middleware.ts's cookie roll only fires on
 * `sec-fetch-dest: document` requests (real navigations), so those
 * long-lived sessions would otherwise hard-expire at the original 7-day
 * maxAge even while actively in use — the original SPRO-13 bug.
 */
export async function refreshSessionCookieAction(): Promise<void> {
  try {
    const session = await verifySession();
    if (!session) {
      // No valid session to refresh — fail closed. Never mint a cookie for
      // an identity the caller merely claims to be.
      return;
    }
    await setSessionCookie(session.userId);
  } catch (err) {
    // A failed cookie refresh must never surface as an error to the caller —
    // the session check that preceded this is still accurate even if we
    // couldn't extend the cookie's maxAge this time. It'll retry on the next
    // check (mount / tab refocus).
    console.error('[auth] refreshSessionCookieAction (setSessionCookie) failed:', err);
  }
}
