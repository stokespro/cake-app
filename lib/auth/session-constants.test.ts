// Regression coverage for isUserRole() — the guard that closes the
// app/login/page.tsx type hole (SessionUser.role: string vs UserRole) by
// validating a DB-sourced role string before it's trusted as a UserRole,
// rather than casting past it with `as UserRole`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionCookieOptions, isUserRole } from './session-constants';

describe('isUserRole', () => {
  it.each(['admin', 'management', 'sales', 'standard', 'vault', 'packaging', 'agent', 'grow'])(
    'accepts the known role %s',
    (role) => {
      expect(isUserRole(role)).toBe(true);
    }
  );

  it('rejects an unrecognized role string', () => {
    expect(isUserRole('superadmin')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isUserRole('')).toBe(false);
  });

  it('rejects a role that only differs in case', () => {
    expect(isUserRole('Admin')).toBe(false);
  });
});

// Regression coverage for the single-source-of-truth cookie options builder
// that setSessionCookie, rollSessionCookie, and clearSessionCookie all now
// share (see lib/auth/session.ts and lib/supabase/middleware.ts).
describe('buildSessionCookieOptions', () => {
  // NODE_ENV is typed `readonly` (see next/types/global.d.ts), so direct
  // assignment is a type error — vi.stubEnv is Vitest's supported way to
  // override it for a test and vi.unstubAllEnvs() restores the original.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('always sets httpOnly, sameSite=lax, and path=/', () => {
    const options = buildSessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
  });

  it('omits maxAge when not provided (e.g. for deletion)', () => {
    const options = buildSessionCookieOptions();
    expect(options.maxAge).toBeUndefined();
  });

  it('includes maxAge when provided', () => {
    const options = buildSessionCookieOptions({ maxAge: 604_800 });
    expect(options.maxAge).toBe(604_800);
  });

  it('sets secure=true in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(buildSessionCookieOptions().secure).toBe(true);
  });

  it('sets secure=false outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(buildSessionCookieOptions().secure).toBe(false);
  });
});
