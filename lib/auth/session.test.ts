// Regression coverage for checkSession()'s valid/unauthenticated/error
// trichotomy — this is the core of the silent-logout fix. A regression here
// (e.g. collapsing `error` back into `unauthenticated`) would re-introduce
// the bug where a transient DB/network blip force-logs-out every user.
//
// `next/headers` and `@/lib/supabase/server` are mocked so this stays a fast,
// hermetic unit test with no real cookies or database.

import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCookieGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: mockCookieGet,
  })),
}));

const mockCreateServiceClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}));

const { checkSession } = await import('./session');
const { SESSION_COOKIE } = await import('./session-constants');

const SECRET = 'test-session-secret';

function signCookie(userId: string, secret = SECRET): string {
  const sig = createHmac('sha256', secret).update(userId).digest('hex');
  return `${userId}.${sig}`;
}

// checkSession() calls `.maybeSingle()`, not `.single()` — the mock chain
// must mirror that exactly, since `.single()` and `.maybeSingle()` have
// different real-world result shapes for "zero rows" (see the PGRST116
// tests below) and a mock of the wrong method would pass even if the
// production code called the wrong one.
function mockUsersQueryResult(result: { data: unknown; error: unknown }) {
  mockCreateServiceClient.mockResolvedValue({
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(result),
        }),
      }),
    }),
  });
}

describe('checkSession', () => {
  const originalSecret = process.env.SESSION_SECRET;

  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
    mockCookieGet.mockReset();
    mockCreateServiceClient.mockReset();
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = originalSecret;
    }
    vi.restoreAllMocks();
  });

  it('returns unauthenticated when there is no cookie', async () => {
    mockCookieGet.mockReturnValue(undefined);

    const result = await checkSession();

    expect(result).toEqual({ status: 'unauthenticated' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it('returns unauthenticated when the cookie has a bad signature', async () => {
    mockCookieGet.mockReturnValue({ name: SESSION_COOKIE, value: 'some-user-id.deadbeef' });

    const result = await checkSession();

    expect(result).toEqual({ status: 'unauthenticated' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });

  it('returns valid with the role/name from the DB when the cookie and user row check out', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    mockCookieGet.mockReturnValue({ name: SESSION_COOKIE, value: signCookie(userId) });
    mockUsersQueryResult({
      data: { id: userId, name: 'Jane Doe', role: 'admin' },
      error: null,
    });

    const result = await checkSession();

    expect(result).toEqual({
      status: 'valid',
      session: { userId, role: 'admin', name: 'Jane Doe' },
    });
  });

  it('trusts only the userId from the cookie — role/name always come from the DB row, not the cookie', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    mockCookieGet.mockReturnValue({ name: SESSION_COOKIE, value: signCookie(userId) });
    // The DB row's role differs from anything that could have been implied
    // by the cookie (the cookie payload never carries a role at all).
    mockUsersQueryResult({
      data: { id: userId, name: 'Jane Doe', role: 'sales' },
      error: null,
    });

    const result = await checkSession();

    expect(result.status).toBe('valid');
    if (result.status === 'valid') {
      expect(result.session.role).toBe('sales');
    }
  });

  it('returns error (not unauthenticated) when the users query errors — do not log the user out on a network blip', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    mockCookieGet.mockReturnValue({ name: SESSION_COOKIE, value: signCookie(userId) });
    mockUsersQueryResult({
      data: null,
      error: { message: 'connection reset' },
    });

    const result = await checkSession();

    expect(result).toEqual({ status: 'error' });
  });

  // This is the realistic `.maybeSingle()` shape for "zero rows matched"
  // (e.g. the user was deleted): `.maybeSingle()` resolves cleanly with
  // `{ data: null, error: null }`, unlike `.single()`, which would instead
  // reject/resolve with a PGRST116 error for the same zero-row case (see the
  // next test) — a distinction that matters because `checkSession()` used to
  // call `.single()` here, which meant this exact scenario was silently
  // misclassified as `status: 'error'` (see the PGRST116 test below) instead
  // of `status: 'unauthenticated'`, and AuthProvider deliberately keeps the
  // cached session on `error` — a deleted user's session would never expire.
  it('returns unauthenticated when the query succeeds but no row is found (user deleted)', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    mockCookieGet.mockReturnValue({ name: SESSION_COOKIE, value: signCookie(userId) });
    mockUsersQueryResult({ data: null, error: null });

    const result = await checkSession();

    expect(result).toEqual({ status: 'unauthenticated' });
  });

  // Defensive coverage for the belt-and-suspenders PGRST116 mapping in
  // checkSession(): `.maybeSingle()` should never itself produce this error
  // code (that's specifically `.single()`'s "0 or >1 rows" signal), but if
  // it ever did — a future Supabase/PostgREST client change, or a caller
  // elsewhere reusing this same query builder with `.single()` — it must
  // still resolve to `unauthenticated`, not the inconclusive `error` status,
  // since a PGRST116 "no rows" condition is definitionally "user not found",
  // not an infrastructure hiccup.
  it('returns unauthenticated (not error) when the users query errors with PGRST116 (defensive — .single()-style "no rows" signal)', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    mockCookieGet.mockReturnValue({ name: SESSION_COOKIE, value: signCookie(userId) });
    mockUsersQueryResult({
      data: null,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    });

    const result = await checkSession();

    expect(result).toEqual({ status: 'unauthenticated' });
  });

  it('returns error when createServiceClient throws', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    mockCookieGet.mockReturnValue({ name: SESSION_COOKIE, value: signCookie(userId) });
    mockCreateServiceClient.mockRejectedValue(new Error('service client unavailable'));

    const result = await checkSession();

    expect(result).toEqual({ status: 'error' });
  });

  it('returns unauthenticated when SESSION_SECRET is unset', async () => {
    delete process.env.SESSION_SECRET;
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    // Signed under a secret that (now) does not match the missing env var.
    mockCookieGet.mockReturnValue({ name: SESSION_COOKIE, value: signCookie(userId) });

    const result = await checkSession();

    expect(result).toEqual({ status: 'unauthenticated' });
    expect(mockCreateServiceClient).not.toHaveBeenCalled();
  });
});
