// Runtime-neutral constants shared between the Node-only session module
// (lib/auth/session.ts, which imports next/headers + node:crypto and cannot
// run in the Edge runtime), Edge-safe consumers (lib/auth/session-edge.ts,
// lib/supabase/middleware.ts), and client components ('use client' files
// like lib/auth-context.tsx). Keep this file free of any Node/Edge-specific
// imports so it can be pulled into any of those bundles safely.

export const SESSION_COOKIE = 'crm-session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// Cookie options
// ---------------------------------------------------------------------------

// Single source of truth for the crm-session cookie's attributes. Previously
// these were hand-duplicated at three call sites (lib/auth/session.ts's
// setSessionCookie, lib/supabase/middleware.ts's rollSessionCookie, and
// clearSessionCookie — which passed no options at all, meaning a future
// `path` change would make logout silently stop deleting the cookie it set,
// since browsers match delete-by-name-and-path). Centralizing here means all
// three sites (set, roll, clear) can never drift.
export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge?: number;
}

/**
 * Build the crm-session cookie's options. Pass `maxAge` when setting/rolling
 * the cookie forward (login, sliding expiration); omit it when only the
 * matching `path` (and other attributes) are needed, e.g. for deletion.
 */
export function buildSessionCookieOptions(opts?: { maxAge?: number }): SessionCookieOptions {
  const options: SessionCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
  if (opts?.maxAge !== undefined) {
    options.maxAge = opts.maxAge;
  }
  return options;
}

// ---------------------------------------------------------------------------
// UserRole
// ---------------------------------------------------------------------------

// Canonical declaration of UserRole. Previously this lived in
// lib/auth-context.tsx (a 'use client' file), which forced every
// server-side role type (e.g. actions/auth.ts's SessionUser) to either
// duplicate the union or fall back to a bare `string` — the latter is what
// let an unvalidated DB role flow into `login()` unchecked (see the
// app/login/page.tsx tsc error this fixed). lib/auth-context.tsx re-exports
// this so existing importers of `UserRole` from there keep working.
export type UserRole =
  | 'admin'
  | 'management'
  | 'sales'
  | 'standard'
  | 'vault'
  | 'packaging'
  | 'agent'
  | 'grow';

const USER_ROLES: readonly UserRole[] = [
  'admin',
  'management',
  'sales',
  'standard',
  'vault',
  'packaging',
  'agent',
  'grow',
];

/**
 * Type guard narrowing an untrusted string (e.g. a `role` column value read
 * straight from `public.users`, which is free-text at the DB level) to
 * `UserRole`. Roles only ever change by hand or via the Users admin page, so
 * a value outside this list is a real condition — a typo, a stale value, or
 * a new role added to the DB but not yet wired into the app — not something
 * to paper over with `as UserRole`. Callers must handle `false` explicitly
 * (see actions/auth.ts's authenticateByPin/getCurrentSession).
 */
export function isUserRole(role: string): role is UserRole {
  return (USER_ROLES as readonly string[]).includes(role);
}
