// Regression coverage for checkSessionAction() / refreshSessionCookieAction()
// — the sliding-expiration wiring, now split into a pure read
// (checkSessionAction) and an explicit, separately-invoked refresh
// (refreshSessionCookieAction).
//
// Background (SPRO-13): unattended wall displays (/cultivation-display/*)
// and warehouse kiosks load a page once and then poll via server
// actions/RSC for days without ever performing another document
// navigation, so lib/supabase/middleware.ts's document-navigation-gated
// cookie roll never fires for them. AuthProvider calls refreshSessionCookieAction
// after confirming a session check came back `valid` — this is what keeps
// those long-lived sessions from hard-expiring at the original 7-day maxAge.
//
// checkSessionAction() used to call the cookie refresh itself, unconditionally,
// on every `valid` result — which meant a check that resolved after a
// concurrent logout() could resurrect the cookie the user just cleared (see
// "Kill the logout resurrect race", SPRO-13 pass 2). Splitting the refresh out
// into its own action lets the caller (lib/auth-context.tsx) decide whether to
// invoke it at all.
//
// SECURITY (auth-bypass fix): refreshSessionCookieAction used to accept a
// `userId` argument straight from the client and mint a signed session cookie
// for it, with no verification the caller actually owned that identity — a
// full unauthenticated session-minting oracle (any caller who learned another
// user's id, e.g. an admin's UUID via an unrelated lower-privilege-gated
// action, could POST it here and receive a validly signed session for that
// user). It now takes no arguments at all and derives the identity solely
// from the caller's own verified session (verifySession()), writing no cookie
// if there isn't one. See the tests below.
//
// '@/lib/auth/session' is mocked wholesale so this stays a fast, hermetic
// unit test (no real cookies, no next/headers, no database) — same style as
// lib/auth/session.test.ts's mocking of next/headers / @/lib/supabase/server.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionCheck, VerifiedSession } from '@/lib/auth/session';

const mockCheckSession = vi.fn();
const mockSetSessionCookie = vi.fn();
const mockVerifySession = vi.fn();

vi.mock('@/lib/auth/session', () => ({
  checkSession: (...args: unknown[]) => mockCheckSession(...args),
  setSessionCookie: (...args: unknown[]) => mockSetSessionCookie(...args),
  // Unused by checkSessionAction but imported by actions/auth.ts — stub so
  // the module loads without pulling in the real (next/headers-dependent)
  // implementation.
  clearSessionCookie: vi.fn(),
  verifySession: (...args: unknown[]) => mockVerifySession(...args),
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}));

const { checkSessionAction, refreshSessionCookieAction } = await import('./auth');

const VALID_RESULT: SessionCheck = {
  status: 'valid',
  session: { userId: 'user-123', role: 'admin', name: 'Jane Doe' },
};

describe('checkSessionAction', () => {
  beforeEach(() => {
    mockCheckSession.mockReset();
    mockSetSessionCookie.mockReset();
  });

  it('returns the checkSession() result unchanged', async () => {
    mockCheckSession.mockResolvedValue(VALID_RESULT);

    const result = await checkSessionAction();

    expect(result).toEqual(VALID_RESULT);
  });

  it('is a pure read — never touches the cookie, even on a valid result', async () => {
    mockCheckSession.mockResolvedValue(VALID_RESULT);

    await checkSessionAction();

    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('passes through an unauthenticated result untouched', async () => {
    mockCheckSession.mockResolvedValue({ status: 'unauthenticated' });

    const result = await checkSessionAction();

    expect(result).toEqual({ status: 'unauthenticated' });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('passes through an error result untouched', async () => {
    mockCheckSession.mockResolvedValue({ status: 'error' });

    const result = await checkSessionAction();

    expect(result).toEqual({ status: 'error' });
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });
});

describe('refreshSessionCookieAction', () => {
  const VALID_SESSION: VerifiedSession = { userId: 'user-123', role: 'admin', name: 'Jane Doe' };

  beforeEach(() => {
    mockSetSessionCookie.mockReset();
    mockVerifySession.mockReset();
  });

  it('refreshes the session cookie for the caller\'s own verified session', async () => {
    mockVerifySession.mockResolvedValue(VALID_SESSION);
    mockSetSessionCookie.mockResolvedValue(undefined);

    await refreshSessionCookieAction();

    expect(mockSetSessionCookie).toHaveBeenCalledTimes(1);
    expect(mockSetSessionCookie).toHaveBeenCalledWith('user-123');
  });

  // Auth-bypass regression test: this action must NEVER accept an identity
  // from the caller. It only has zero parameters now, but this also asserts
  // the behavior that replaces the removed userId argument — no session,
  // no cookie, full stop.
  it('writes no cookie when there is no valid session (fail closed)', async () => {
    mockVerifySession.mockResolvedValue(null);

    await refreshSessionCookieAction();

    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });

  it('never throws, even if setSessionCookie rejects', async () => {
    mockVerifySession.mockResolvedValue(VALID_SESSION);
    mockSetSessionCookie.mockRejectedValue(new Error('cookie write failed'));

    await expect(refreshSessionCookieAction()).resolves.toBeUndefined();
  });

  it('never throws, even if verifySession itself rejects', async () => {
    mockVerifySession.mockRejectedValue(new Error('db unreachable'));

    await expect(refreshSessionCookieAction()).resolves.toBeUndefined();
    expect(mockSetSessionCookie).not.toHaveBeenCalled();
  });
});
