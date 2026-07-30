import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, SESSION_TTL_SECONDS, buildSessionCookieOptions } from '@/lib/auth/session-constants'
import { verifySignatureEdge } from '@/lib/auth/session-edge'

// Route prefixes that require an authenticated PIN session. Everything else
// (marketing/root, /login, /~offline, /api/* webhooks with their own auth)
// is intentionally left ungated here.
const PROTECTED_PREFIXES = ['/dashboard', '/cultivation-display']

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

// Module-scoped so we log the misconfiguration once per server instance
// rather than once per request (middleware runs on nearly every request).
let hasLoggedMissingSecret = false

function loginRedirect(request: NextRequest, reason: string): NextResponse {
  const url = request.nextUrl.clone()
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`
  url.pathname = '/login'
  url.search = ''
  url.searchParams.set('next', next)
  url.searchParams.set('reason', reason)
  return NextResponse.redirect(url)
}

// Re-set the crm-session cookie with a fresh maxAge on a response, carrying
// over the flags used at login time (see setSessionCookie in
// lib/auth/session.ts — both now share buildSessionCookieOptions so they
// can't drift).
function rollSessionCookie(response: NextResponse, cookieValue: string) {
  response.cookies.set(SESSION_COOKIE, cookieValue, buildSessionCookieOptions({ maxAge: SESSION_TTL_SECONDS }))
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  if (!isProtectedPath(pathname)) {
    return NextResponse.next({ request })
  }

  // Only ever redirect real document navigations (top-level page loads /
  // full-page navigations). Server Actions POST to the CURRENT page's URL
  // (e.g. checkSessionAction() posting to /dashboard/orders), and RSC
  // fetches/prefetches also hit these same protected paths — none of these
  // are `sec-fetch-dest: document`. Redirecting them here 307's the
  // POST/fetch itself before it ever reaches the route/action handler,
  // silently swallowing the request — this was the pass-1 regression:
  // checkSessionAction() never executed, so the client never learned its
  // session was dead and the "silent logout" bug was NOT fixed. Everything
  // that isn't a document navigation is let through unconditionally; it's
  // requireRole()/checkSession() (lib/auth/session.ts) — which already fail
  // closed and return NO_SESSION_REASON — that actually gates those requests.
  const isDocumentNavigation = request.headers.get('sec-fetch-dest') === 'document'

  const secret = process.env.SESSION_SECRET
  if (!secret) {
    // Fail closed: with no secret we cannot verify anything, so a document
    // navigation to a protected route is denied. Non-document requests still
    // pass through — verifySignature()/checkSession() also fail closed with
    // no secret (see lib/auth/session.ts), so requireRole() will correctly
    // return NO_SESSION_REASON for those instead of us swallowing them here.
    if (!hasLoggedMissingSecret) {
      hasLoggedMissingSecret = true
      console.error('[middleware] SESSION_SECRET is not set — denying access to protected routes')
    }
    return isDocumentNavigation
      ? loginRedirect(request, 'session_expired')
      : NextResponse.next({ request })
  }

  const cookieValue = request.cookies.get(SESSION_COOKIE)?.value
  const userId = cookieValue ? await verifySignatureEdge(cookieValue, secret) : null

  if (!userId || !cookieValue) {
    return isDocumentNavigation
      ? loginRedirect(request, 'session_expired')
      : NextResponse.next({ request })
  }

  const response = NextResponse.next({ request })

  // Valid session — roll the cookie forward (sliding expiration), but only
  // on document navigations so we're not rewriting the cookie on every
  // RSC fetch/asset request that hits the middleware matcher.
  if (isDocumentNavigation) {
    rollSessionCookie(response, cookieValue)
  }

  return response
}
