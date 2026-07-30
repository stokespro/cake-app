// Regression coverage for the PIN-session middleware gate. Verifies the
// protected-path redirect, the "never redirect /login" no-loop guarantee,
// fail-closed behavior when SESSION_SECRET is missing, sliding-expiration
// cookie rolling, and the prefix-matching correctness that keeps
// `/dashboardsomething` from being treated as protected.
//
// Hermetic by construction: NEXT_PUBLIC_SUPABASE_URL / ANON_KEY are left
// unset for these tests, which makes `updateSession()`'s
// `createServerClient(...)` branch a no-op (it's gated behind
// `if (supabaseUrl && ...)`), so no real Supabase client is ever created and
// nothing needs to be mocked there.

import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { updateSession } from './middleware';
import { SESSION_COOKIE } from '@/lib/auth/session-constants';

const SECRET = 'test-session-secret';
const USER_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';

function signCookie(userId: string, secret = SECRET): string {
  const sig = createHmac('sha256', secret).update(userId).digest('hex');
  return `${userId}.${sig}`;
}

function makeRequest(
  path: string,
  opts: { cookie?: string; documentNavigation?: boolean } = {}
): NextRequest {
  const headers = new Headers();
  if (opts.cookie) {
    headers.set('cookie', `${SESSION_COOKIE}=${opts.cookie}`);
  }
  if (opts.documentNavigation) {
    headers.set('sec-fetch-dest', 'document');
  }
  return new NextRequest(new URL(path, 'https://app.example.com'), { headers });
}

describe('updateSession (middleware gate)', () => {
  const originalSecret = process.env.SESSION_SECRET;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalSupabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
    // Leave Supabase env unset so updateSession's createServerClient branch
    // is skipped entirely — see file header comment.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;

    if (originalSupabaseUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;

    if (originalSupabaseAnonKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalSupabaseAnonKey;
  });

  it('redirects a protected path with no cookie to /login with next + reason=session_expired', async () => {
    const request = makeRequest('/dashboard/orders?foo=bar');

    const response = await updateSession(request);

    expect([307, 308]).toContain(response.status);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/dashboard/orders?foo=bar');
    expect(location.searchParams.get('reason')).toBe('session_expired');
  });

  it('does not redirect a protected path with a validly-signed cookie', async () => {
    const request = makeRequest('/dashboard/orders', { cookie: signCookie(USER_ID) });

    const response = await updateSession(request);

    expect(response.headers.get('location')).toBeNull();
    expect([307, 308]).not.toContain(response.status);
  });

  it.each(['/login', '/', '/api/whatever'])(
    'never redirects unprotected path %s, even with no cookie (no redirect loop)',
    async (path) => {
      const request = makeRequest(path);

      const response = await updateSession(request);

      expect(response.headers.get('location')).toBeNull();
    }
  );

  it('/login specifically is always reachable with no cookie', async () => {
    const response = await updateSession(makeRequest('/login'));

    expect(response.headers.get('location')).toBeNull();
  });

  it('fails closed (redirects) on a protected path when SESSION_SECRET is unset', async () => {
    delete process.env.SESSION_SECRET;
    const request = makeRequest('/dashboard/orders', { cookie: signCookie(USER_ID) });

    const response = await updateSession(request);

    expect([307, 308]).toContain(response.status);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('reason')).toBe('session_expired');
  });

  it('rolls the crm-session cookie forward on a document navigation', async () => {
    const cookieValue = signCookie(USER_ID);
    const request = makeRequest('/dashboard/orders', { cookie: cookieValue, documentNavigation: true });

    const response = await updateSession(request);

    const setCookie = response.cookies.get(SESSION_COOKIE);
    expect(setCookie?.value).toBe(cookieValue);
  });

  it('does not roll the crm-session cookie on a non-document request', async () => {
    const cookieValue = signCookie(USER_ID);
    const request = makeRequest('/dashboard/orders', { cookie: cookieValue, documentNavigation: false });

    const response = await updateSession(request);

    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('does not treat /dashboardsomething as a protected path', async () => {
    const request = makeRequest('/dashboardsomething');

    const response = await updateSession(request);

    // No cookie provided; if this were (wrongly) matched as protected it
    // would redirect to /login.
    expect(response.headers.get('location')).toBeNull();
  });
});
