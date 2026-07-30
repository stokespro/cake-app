'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { logoutAction, checkSessionAction, refreshSessionCookieAction } from '@/actions/auth';
import { isSessionError } from '@/lib/auth/session-errors';
// Canonical declaration moved to lib/auth/session-constants.ts (runtime-
// neutral) so server-only modules (e.g. actions/auth.ts) can share the exact
// same type instead of falling back to `string`. Re-exported below so
// existing importers of `UserRole` from '@/lib/auth-context' keep working.
import type { UserRole } from '@/lib/auth/session-constants';
// Type-only import — erased at compile time, so this never pulls
// lib/auth/session.ts's next/headers / node:crypto code into the client
// bundle. Only used to type reconcileSessionCheck()'s dependencies below.
import type { SessionCheck, VerifiedSession } from '@/lib/auth/session';

export type { UserRole };

export interface SessionUser {
  id: string;
  name: string;
  role: UserRole;
}

// Permission helper functions
export function canViewSection(role: UserRole, section: string): boolean {
  const permissions: Record<string, UserRole[]> = {
    // Admin and management see everything
    vault: ['admin', 'management', 'vault', 'standard'],
    packaging: ['admin', 'management', 'packaging', 'standard'],
    dispensaries: ['admin', 'management', 'sales', 'agent'],
    orders: ['admin', 'management', 'sales', 'agent'],
    products: ['admin', 'management', 'vault', 'packaging', 'standard'],
    communications: ['admin', 'management', 'sales', 'agent'],
    compliance: ['admin', 'management', 'vault', 'packaging'],
    cultivation: ['admin', 'management', 'vault', 'packaging', 'standard', 'grow'],
    tasks: ['admin', 'management', 'sales', 'agent'],
    inventory: ['admin', 'management', 'vault', 'packaging', 'standard', 'sales', 'agent'],
    users: ['admin'],
    finance: ['admin', 'management'],
  };
  return permissions[section]?.includes(role) ?? false;
}

export function canCreateOrder(role: UserRole): boolean {
  return ['admin', 'management', 'sales'].includes(role);
}

export function canApproveOrder(role: UserRole): boolean {
  return ['admin', 'management'].includes(role);
}

export function canEditOrder(role: UserRole): boolean {
  return ['admin', 'management', 'sales', 'agent'].includes(role);
}

export function canDeleteOrder(role: UserRole): boolean {
  return ['admin', 'management'].includes(role);
}

export function canManageUsers(role: UserRole): boolean {
  return role === 'admin';
}

export function canAssignSales(role: UserRole): boolean {
  return ['sales', 'agent', 'management', 'admin'].includes(role);
}

export function canManageCultivation(role: UserRole): boolean {
  return ['admin', 'management'].includes(role);
}

export function canCompleteCultivation(role: UserRole): boolean {
  return ['admin', 'management', 'vault', 'packaging', 'grow'].includes(role);
}

interface AuthContextType {
  user: SessionUser | null;
  isLoading: boolean;
  // True once the server has told us the crm-session cookie is missing/
  // invalid (definitively logged out) — as opposed to just not having a
  // user yet during the initial load. The dashboard layout uses this to
  // show a "your session expired" message on redirect.
  sessionExpired: boolean;
  login: (user: SessionUser) => void;
  logout: () => Promise<void>;
  // Single authoritative handler for a server action's "No valid session"
  // error. Call this from any page/component's catch block instead of
  // inlining `isSessionError(...)  ? 'expired' : fallback` display-string
  // ternaries — those never actually cleared the session, so a user would
  // see "session expired" next to a "Try Again" button guaranteed to keep
  // failing. Returns true (and hard-clears the cached session, same as an
  // `unauthenticated` result from the periodic check) when `error` was a
  // session error; returns false for any other error so the caller can fall
  // back to its normal error handling.
  //
  // Usage:
  //   const result = await someServerAction();
  //   if (result.error) {
  //     if (handleSessionError(result.error)) return; // user is now logged out
  //     toast.error(result.error);
  //   }
  handleSessionError: (error: unknown) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const USER_STORAGE_KEY = 'crm-user';
// logout() must always resolve, even if the network is completely dead.
const LOGOUT_TIMEOUT_MS = 3_000;
// Keeps unattended, always-visible screens (e.g. /cultivation-display TVs,
// warehouse kiosks) alive. Those never fire `visibilitychange` — there's no
// tab to refocus — so without this they'd never re-check or slide the
// crm-session cookie forward, and would hard-expire at the cookie's 7-day TTL
// with someone having to walk over and re-enter a PIN. 30 minutes (not the
// 60s the old poll used) keeps this at 48 calls/day/tab instead of 1,440 —
// this is a safety net for unattended devices, not a tight poll, and every
// other tab/device is already covered by the mount + visibilitychange checks.
// Do not shorten this back toward 60s and do not delete it as "redundant
// with visibilitychange" — it exists specifically for the case where
// visibilitychange never fires.
const SESSION_HEARTBEAT_MS = 30 * 60 * 1000;

function safeSetStoredUser(user: SessionUser | null) {
  try {
    if (user) {
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(USER_STORAGE_KEY);
    }
  } catch {
    // Ignore — storage may be unavailable (private browsing, quota, etc).
  }
}

// Caches that can hold authenticated /dashboard and /cultivation-display
// documents/RSC payloads — see app/sw.ts's `PAGES_CACHE_NAME` ("pages",
// "pages-rsc", "pages-rsc-prefetch"), which @serwist/next uses verbatim as
// the Cache Storage key (no prefix). Only these are ever cleared on logout.
//
// Deliberately NOT cleared: the Serwist precache (name contains
// "precache", e.g. "serwist-precache-v2-...") — it holds the app shell and
// the /~offline fallback document. Serwist only populates it once at SW
// install; an already-activated worker never rebuilds it, so wiping it here
// would leave a warehouse tablet that signs out and then loses Wi-Fi with
// Chrome's default offline error page instead of our `/~offline` fallback.
const AUTHENTICATED_RUNTIME_CACHE_NAMES = ['pages', 'pages-rsc', 'pages-rsc-prefetch'];

function isAuthenticatedRuntimeCache(cacheName: string): boolean {
  if (cacheName.includes('precache')) return false;
  // Exact match, plus a defensive "pages"-prefix match in case a future
  // Serwist/Next.js version namespaces these differently.
  return AUTHENTICATED_RUNTIME_CACHE_NAMES.includes(cacheName) || cacheName.startsWith('pages');
}

// ---------------------------------------------------------------------------
// Session-check reconciliation (kill the logout resurrect race)
// ---------------------------------------------------------------------------
//
// Extracted out of the useCallback below as a pure(ish), dependency-injected
// function — with no React hooks/refs/state of its own — specifically so the
// logout-epoch race fix is unit-testable without needing a DOM/React
// rendering environment (this repo's vitest config runs in `environment:
// 'node'`, with no jsdom/@testing-library/react installed). See
// lib/auth-context.test.ts.
export interface SessionCheckDeps {
  checkSession: () => Promise<SessionCheck>;
  // Takes no arguments — the server derives the identity to refresh from the
  // caller's own verified session cookie (see refreshSessionCookieAction in
  // actions/auth.ts). Never pass a userId into this; that was the SPRO-13
  // auth-bypass bug (an unauthenticated session-minting oracle).
  refreshCookie: () => Promise<void>;
  // Snapshot of the current session epoch. Must be re-read (not memoized)
  // both before and after `checkSession()` resolves — that's the whole
  // point: it needs to reflect a logout() that happened WHILE this check was
  // in flight.
  getEpoch: () => number;
  onValid: (session: VerifiedSession) => void;
  onUnauthenticated: () => void;
  onError: () => void;
}

/**
 * Run one session-check reconciliation, discarding the result entirely if
 * the session epoch changed while `checkSession()` was in flight (i.e. a
 * logout() — or any other hard-clear — happened concurrently). A stale
 * result must not call `onValid`/`onUnauthenticated`/`onError`, and
 * specifically must not call `refreshCookie`, which would otherwise slide
 * the crm-session cookie's expiration forward on a device the operator just
 * signed out of (see "Kill the logout resurrect race", SPRO-13 pass 2).
 */
export async function reconcileSessionCheck(deps: SessionCheckDeps): Promise<void> {
  const epochAtStart = deps.getEpoch();
  const result = await deps.checkSession();

  if (deps.getEpoch() !== epochAtStart) return; // stale — discard

  switch (result.status) {
    case 'valid':
      deps.onValid(result.session);
      // Fire-and-forget, best-effort — refreshSessionCookieAction already
      // never rejects, but this is defensive in case that ever changes.
      deps.refreshCookie().catch((err) =>
        console.error('[auth] refreshCookie failed:', err)
      );
      break;
    case 'unauthenticated':
      deps.onUnauthenticated();
      break;
    case 'error':
      deps.onError();
      break;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Guards against overlapping in-flight session checks (e.g. a visibility
  // change firing while another check is still in flight).
  const checkInFlightRef = useRef(false);

  // Bumped by logout() and by clearSessionState() (i.e. anything that
  // hard-clears the cached session). An in-flight runSessionCheck() that
  // started before the bump must treat its own result as stale once it
  // resolves — see the "logout resurrect race" comment in runSessionCheck
  // below.
  const sessionEpochRef = useRef(0);

  const clearSessionState = useCallback(() => {
    sessionEpochRef.current += 1;
    setUser(null);
    safeSetStoredUser(null);
    setSessionExpired(true);
  }, []);

  // Reconcile the cached session against the server via the signed
  // crm-session cookie.
  //
  // - `valid`: resync `user` + localStorage (also catches server-side role
  //   changes made while the user stays logged in), then slide the cookie's
  //   expiration forward (see refreshSessionCookieAction).
  // - `unauthenticated`: the server has definitively said this session is
  //   dead (cookie missing/invalid/signed by a different secret, or the
  //   user was deleted). Hard-clear local state — this is the fix for the
  //   "silent logout": the client must stop pretending to be logged in the
  //   moment the server disagrees.
  // - `error`: inconclusive (DB/service-client hiccup) — keep the cached
  //   user as-is. Do not turn a transient network blip into a forced logout.
  const runSessionCheck = useCallback(async () => {
    if (checkInFlightRef.current) return;
    checkInFlightRef.current = true;
    try {
      await reconcileSessionCheck({
        checkSession: checkSessionAction,
        refreshCookie: refreshSessionCookieAction,
        getEpoch: () => sessionEpochRef.current,
        onValid: (fresh) => {
          setSessionExpired(false);
          setUser((prev) => {
            if (prev && prev.id === fresh.userId && prev.role === fresh.role && prev.name === fresh.name) {
              return prev;
            }
            const next: SessionUser = { id: fresh.userId, name: fresh.name, role: fresh.role as UserRole };
            safeSetStoredUser(next);
            return next;
          });
        },
        onUnauthenticated: clearSessionState,
        onError: () => {
          console.error('[auth] session check inconclusive (network/service error) — keeping cached session');
        },
      });
    } catch (err) {
      console.error('[auth] checkSessionAction failed:', err);
    } finally {
      checkInFlightRef.current = false;
    }
  }, [clearSessionState]);

  // Load user from localStorage on mount, then reconcile with the server.
  useEffect(() => {
    let isMounted = true;

    try {
      const stored = localStorage.getItem(USER_STORAGE_KEY);
      if (stored) {
        setUser(JSON.parse(stored));
      }
    } catch {
      // Ignore errors
    }

    // isLoading must be impossible to hang: it depends only on the initial
    // PIN-session reconciliation (wrapped in try/catch/finally).
    (async () => {
      try {
        await runSessionCheck();
      } catch (err) {
        console.error('[auth] initial session check failed:', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    })();

    // Revalidate on tab refocus so an expired/killed session is caught
    // without waiting for the next full page load. (There used to also be a
    // 60s polling interval here; it was removed — it cost every open tab a
    // server-action round trip + Postgres SELECT every minute forever, had
    // no backoff during a Supabase outage, and rolled the session cookie on
    // every tick. handleSessionError() on the AuthContext now covers the gap
    // for actively-used tabs: any page's own server actions surface "No
    // valid session" immediately when it actually happens, instead of
    // waiting up to 60s for a poll. The heartbeat below covers the remaining
    // gap — unattended screens that never refocus at all.)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runSessionCheck().catch((err) => console.error('[auth] visibility session check failed:', err));
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Heartbeat for unattended displays — see SESSION_HEARTBEAT_MS above.
    // Goes through the exact same runSessionCheck() as the mount and
    // visibilitychange checks (same in-flight guard, same epoch-based
    // reconcileSessionCheck), so a logout() that fires while a heartbeat
    // check is in flight is discarded identically — no separate guard needed
    // here.
    const heartbeatId = setInterval(() => {
      runSessionCheck().catch((err) => console.error('[auth] heartbeat session check failed:', err));
    }, SESSION_HEARTBEAT_MS);

    return () => {
      isMounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(heartbeatId);
    };
  }, [runSessionCheck]);

  const login = useCallback((newUser: SessionUser) => {
    setUser(newUser);
    setSessionExpired(false);
    setIsLoading(false); // Ensure loading state is cleared after login
    safeSetStoredUser(newUser);
  }, []);

  const handleSessionError = useCallback(
    (error: unknown): boolean => {
      if (!isSessionError(error)) return false;
      clearSessionState();
      return true;
    },
    [clearSessionState]
  );

  // logout() must never hang and never throw — the UI clears immediately
  // and the network cleanup (server cookie, service worker caches) happens
  // best-effort in the background, capped at a few seconds.
  const logout = useCallback(async (): Promise<void> => {
    // Bump the session epoch FIRST, synchronously, before anything else —
    // this is what lets a runSessionCheck() already in flight recognize its
    // eventual result as stale (see runSessionCheck above).
    sessionEpochRef.current += 1;

    // Clear local/UI state so the app is never stuck "logged in" even if
    // every network call below hangs or fails.
    setUser(null);
    setSessionExpired(false);
    safeSetStoredUser(null);

    const clearServerSession = async () => {
      try {
        await logoutAction();
      } catch (err) {
        console.error('[auth] logoutAction failed:', err);
      }
    };

    // The service worker caches authenticated /dashboard documents and RSC
    // payloads (see app/sw.ts) with nothing to invalidate them on logout.
    // Without this, a logged-out user (or the next PIN user on a shared
    // kiosk device) can be served stale authenticated pages from cache.
    // Scoped to the authenticated runtime caches only — see
    // isAuthenticatedRuntimeCache's docstring above for why the precache
    // must never be touched here.
    const clearServiceWorkerCaches = async () => {
      try {
        if (typeof window !== 'undefined' && 'caches' in window) {
          const keys = await caches.keys();
          await Promise.all(
            keys.filter(isAuthenticatedRuntimeCache).map((key) => caches.delete(key))
          );
        }
      } catch (err) {
        console.error('[auth] clearing service worker caches failed:', err);
      }
    };

    const cleanup = Promise.allSettled([
      clearServerSession(),
      clearServiceWorkerCaches(),
    ]);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, LOGOUT_TIMEOUT_MS));

    try {
      await Promise.race([cleanup, timeout]);
    } catch {
      // Promise.allSettled never rejects and the timeout never rejects —
      // this is a belt-and-suspenders guard so logout() itself can never
      // throw regardless of what's added here in the future.
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, sessionExpired, login, logout, handleSessionError }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
