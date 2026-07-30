// Edge-runtime-safe session signature verifier.
//
// `lib/auth/session.ts` imports Node's `crypto` module and `Buffer`, neither
// of which is available in the Edge runtime that `middleware.ts` executes
// in. This module re-implements just the signature check using Web Crypto
// (`crypto.subtle`), which IS available in both Edge and Node runtimes, so
// it can be safely imported from middleware.
//
// This MUST stay byte-identical in behavior to `verifySignature()` in
// lib/auth/session.ts: same payload format (`<userId>.<hmac-hex>`, split on
// the LAST '.'), same HMAC-SHA256-over-the-userId, same hex encoding, same
// constant-time comparison semantics. If the two ever drift, a cookie
// considered valid by one will be rejected by the other.
//
// Note: the cookie payload carries no expiry — expiry is enforced purely by
// the browser dropping the cookie once its `maxAge` elapses. So a present,
// correctly-signed cookie is by definition unexpired, and a signature check
// alone is a sufficient middleware gate. Do NOT add a DB lookup here — Edge
// middleware runs on every matched request and a DB round-trip per request
// would be a needless latency/cost hit; the DB-backed role re-check already
// happens in `checkSession()`/`verifySession()` for anything that actually
// needs the current role.

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Constant-time comparison of two hex strings. Does NOT early-return on the
 * first mismatch — every byte pair is compared and XORed into an
 * accumulator so the number of comparisons (and therefore timing) does not
 * depend on where a mismatch occurs.
 */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verify a `crm-session` cookie value against `secret` and return the
 * embedded userId if valid, or null if the payload is malformed or the
 * signature doesn't match.
 */
export async function verifySignatureEdge(
  cookieValue: string,
  secret: string
): Promise<string | null> {
  const dotIndex = cookieValue.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const userId = cookieValue.slice(0, dotIndex);
  const receivedSig = cookieValue.slice(dotIndex + 1);

  if (!userId || !receivedSig) return null;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(userId));
    const expectedSig = toHex(sigBuffer);

    if (!constantTimeHexEqual(expectedSig, receivedSig.toLowerCase())) {
      return null;
    }
  } catch {
    return null;
  }

  return userId;
}
