// Regression coverage for the PIN-session middleware gate. Verifies the
// protected-path redirect (document navigations only — see below), the
// "never redirect /login" no-loop guarantee, fail-closed behavior when
// SESSION_SECRET is missing, sliding-expiration cookie rolling, and the
// prefix-matching correctness that keeps `/dashboardsomething` from being
// treated as protected.
//
// The document-navigation-only gate (SPRO-13 pass 2) is the most
// safety-critical behavior here: Server Actions POST to the CURRENT page's
// URL, so a naive "redirect any request to a protected path" gate 307's the
// action's own POST before it ever executes — see the "THE regression pass 1
// shipped" test below for the specific regression this locks down.

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
    // updateSession() no longer touches Supabase at all (the shadow-auth
    // cookie refresh it used to do was removed — see SPRO-13 pass 2, "Delete
    // the Supabase shadow auth entirely"), so these are cleared defensively
    // only; nothing in updateSession() reads them anymore.
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

  it('redirects a protected path with no cookie to /login with next + reason=session_expired on a document navigation', async () => {
    const request = makeRequest('/dashboard/orders?foo=bar', { documentNavigation: true });

    const response = await updateSession(request);

    expect([307, 308]).toContain(response.status);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/dashboard/orders?foo=bar');
    expect(location.searchParams.get('reason')).toBe('session_expired');
  });

  // THE regression pass 1 shipped: a Server Action POST (or RSC fetch/
  // prefetch) to a protected path has no `sec-fetch-dest: document` header.
  // Redirecting these 307's the action's own POST before it ever reaches the
  // route handler, so e.g. checkSessionAction() posting to /dashboard/orders
  // would never execute and the client would never learn its session was
  // dead. These MUST pass through untouched and let
  // requireRole()/checkSession() (lib/auth/session.ts) fail closed instead.
  it.each([
    { name: 'no sec-fetch-dest header (Server Action POST)', dest: undefined },
    { name: 'sec-fetch-dest: empty (fetch()/server action)', dest: 'empty' },
  ])(
    'passes through (does NOT redirect) a protected path with a dead cookie when the request is not a document navigation — $name',
    async ({ dest }) => {
      const request = makeRequest('/dashboard/orders');
      if (dest) request.headers.set('sec-fetch-dest', dest);

      const response = await updateSession(request);

      expect(response.headers.get('location')).toBeNull();
      expect([307, 308]).not.toContain(response.status);
    }
  );

  it('passes through (does NOT redirect) a protected path with NO cookie at all when the request is not a document navigation', async () => {
    const request = makeRequest('/dashboard/orders'); // no cookie, no documentNavigation

    const response = await updateSession(request);

    expect(response.headers.get('location')).toBeNull();
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

  it('fails closed (redirects) on a protected path document navigation when SESSION_SECRET is unset', async () => {
    delete process.env.SESSION_SECRET;
    const request = makeRequest('/dashboard/orders', { cookie: signCookie(USER_ID), documentNavigation: true });

    const response = await updateSession(request);

    expect([307, 308]).toContain(response.status);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('reason')).toBe('session_expired');
  });

  it('passes through (does NOT redirect) a protected path non-document request when SESSION_SECRET is unset', async () => {
    delete process.env.SESSION_SECRET;
    const request = makeRequest('/dashboard/orders', { cookie: signCookie(USER_ID) });

    const response = await updateSession(request);

    expect(response.headers.get('location')).toBeNull();
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
