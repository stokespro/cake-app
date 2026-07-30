// Regression coverage for sanitizeNextPath()'s open-redirect guard.
//
// A prior prefix-check implementation (`next.startsWith('/')` + reject
// `'//'`) was bypassed by a leading backslash — e.g. `/\evil.example.com` —
// because the WHATWG URL parser normalizes `\` to `/` for special schemes,
// so `router.replace()` would resolve it to a foreign origin. This suite
// locks in the origin-check replacement.

import { describe, expect, it } from 'vitest'
import { sanitizeNextPath } from './sanitize-next-path'

const ORIGIN = 'https://app.cakeoklahoma.com'

describe('sanitizeNextPath', () => {
  it('allows a plain same-site path', () => {
    expect(sanitizeNextPath('/dashboard/orders', ORIGIN)).toBe('/dashboard/orders')
  })

  it('preserves query string and hash on a same-site path', () => {
    expect(sanitizeNextPath('/dashboard/orders?tab=pending#top', ORIGIN)).toBe(
      '/dashboard/orders?tab=pending#top'
    )
  })

  it('preserves a middleware-style value (pathname + search)', () => {
    // lib/supabase/middleware.ts sets `?next=<pathname><search>` when
    // redirecting an unauthenticated request to /login.
    expect(sanitizeNextPath('/dashboard/vault?filter=active', ORIGIN)).toBe(
      '/dashboard/vault?filter=active'
    )
  })

  it('rejects a protocol-relative URL (//host)', () => {
    expect(sanitizeNextPath('//evil.example.com', ORIGIN)).toBe('/dashboard')
  })

  it('rejects a backslash-prefixed URL (/\\host)', () => {
    expect(sanitizeNextPath('/\\evil.example.com/login', ORIGIN)).toBe('/dashboard')
  })

  it('rejects a slash-backslash URL (/\\/host)', () => {
    expect(sanitizeNextPath('/\\/evil.example.com', ORIGIN)).toBe('/dashboard')
  })

  it('rejects an absolute URL to a foreign origin', () => {
    expect(sanitizeNextPath('https://evil.com/phish', ORIGIN)).toBe('/dashboard')
  })

  it('rejects a javascript: URL', () => {
    expect(sanitizeNextPath('javascript:alert(1)', ORIGIN)).toBe('/dashboard')
  })

  it('treats a literal "%09" text sequence as an inert same-site path', () => {
    // This is the *encoded* form as it would appear typed in an address bar
    // — by the time `searchParams.get('next')` hands us a value, percent
    // escapes have already been decoded, so this literal 3-character
    // sequence reaching sanitizeNextPath is not a real attack: the URL
    // parser does not decode it further, so it resolves to a same-origin
    // path and is safely allowed as-is.
    expect(sanitizeNextPath('/%09/evil.com', ORIGIN)).toBe('/%09/evil.com')
  })

  it('rejects a decoded-tab variant (the actual /%09/evil.com bypass)', () => {
    // What actually reaches this function when a browser decodes `%09` in
    // the query string: a literal tab character. Per the WHATWG URL spec,
    // ASCII tab/newline characters are stripped from the input before
    // further parsing, so "/\t/evil.com" collapses to "//evil.com" — a
    // protocol-relative URL pointing at a foreign origin.
    expect(sanitizeNextPath('/\t/evil.com', ORIGIN)).toBe('/dashboard')
  })

  it('falls back to /dashboard for null', () => {
    expect(sanitizeNextPath(null, ORIGIN)).toBe('/dashboard')
  })

  it('falls back to /dashboard for undefined', () => {
    expect(sanitizeNextPath(undefined, ORIGIN)).toBe('/dashboard')
  })

  it('falls back to /dashboard for an empty string', () => {
    expect(sanitizeNextPath('', ORIGIN)).toBe('/dashboard')
  })

  it('allows a bare same-site root path', () => {
    expect(sanitizeNextPath('/', ORIGIN)).toBe('/')
  })
})
