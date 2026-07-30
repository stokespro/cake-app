// Open-redirect guard for the login page's `?next=` param — only ever
// redirect to a same-site path.
//
// Pulled into its own module (rather than living inline in page.tsx, a
// 'use client' file that pulls in next/navigation, lib/auth-context,
// actions/auth, etc.) purely so it can be unit tested in isolation without
// dragging that whole dependency tree into the test.
//
// A prefix check (`next.startsWith('/')` + reject `'//'`) is NOT sufficient:
// a backslash bypasses it. `next=/\evil.example.com/login` passes both
// checks (`startsWith('/')` true, `startsWith('//')` false), but
// `router.replace()` resolves the value via `new URL(href, location.href)`,
// and for special schemes the WHATWG URL parser normalizes leading `\` to
// `/` — so the resolved origin becomes `https://evil.example.com`. Next then
// performs a hard navigation to a foreign origin, landing a freshly
// authenticated user on an attacker-controlled page. Same issue for
// `/\/evil.com`, and tab/newline/whitespace variants like `/%09/evil.com`
// once decoded.
//
// Fix: resolve the value the same way the browser will (`new URL(next,
// origin)`) and require the resolved origin to match exactly. This also
// naturally rejects absolute URLs to other origins (`https://evil.com`) and
// non-http(s) schemes (`javascript:...` never resolves to a matching
// `origin`).
//
// `origin` is passed in (rather than read from `window.location.origin`
// inside this function) so the sanitizer stays a pure, synchronously
// testable function with no DOM dependency.
export const DEFAULT_NEXT_PATH = '/dashboard'

export function sanitizeNextPath(next: string | null | undefined, origin: string): string {
  if (!next) return DEFAULT_NEXT_PATH

  let url: URL
  try {
    url = new URL(next, origin)
  } catch {
    return DEFAULT_NEXT_PATH
  }

  if (url.origin !== origin) return DEFAULT_NEXT_PATH

  return `${url.pathname}${url.search}${url.hash}`
}
