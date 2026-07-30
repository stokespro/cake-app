// Regression coverage for the Edge-runtime cookie verifier. The highest-value
// test in this file is the anti-drift round-trip: `verifySignatureEdge` must
// accept exactly what Node's `crypto` (the signer used by lib/auth/session.ts)
// produces. If the two implementations ever disagree, either every user is
// silently locked out or a forged cookie is accepted.

import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifySignatureEdge } from './session-edge';

const SECRET = 'test-session-secret';

function signWithNode(userId: string, secret = SECRET): string {
  const sig = createHmac('sha256', secret).update(userId).digest('hex');
  return `${userId}.${sig}`;
}

describe('verifySignatureEdge', () => {
  it('accepts a cookie signed by Node crypto (anti-drift: Node signer <-> Edge verifier agreement)', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'; // UUID-shaped
    const cookieValue = signWithNode(userId);

    const result = await verifySignatureEdge(cookieValue, SECRET);

    expect(result).toBe(userId);
  });

  it('rejects a tampered signature', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const [id, sig] = signWithNode(userId).split('.');
    const tamperedSig = sig.slice(0, -1) + (sig.at(-1) === '0' ? '1' : '0');

    const result = await verifySignatureEdge(`${id}.${tamperedSig}`, SECRET);

    expect(result).toBeNull();
  });

  it('rejects a tampered userId (signature no longer matches)', async () => {
    const original = signWithNode('a1b2c3d4-e5f6-4789-a012-3456789abcde');
    const [, sig] = original.split('.');
    const tamperedCookie = `a1b2c3d4-e5f6-4789-a012-000000000000.${sig}`;

    const result = await verifySignatureEdge(tamperedCookie, SECRET);

    expect(result).toBeNull();
  });

  it('rejects a cookie signed with the wrong secret', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const cookieValue = signWithNode(userId, 'a-different-secret');

    const result = await verifySignatureEdge(cookieValue, SECRET);

    expect(result).toBeNull();
  });

  describe('malformed payloads', () => {
    it('rejects a value with no dot', async () => {
      expect(await verifySignatureEdge('no-dot-here', SECRET)).toBeNull();
    });

    it('rejects an empty userId', async () => {
      expect(await verifySignatureEdge('.abc123', SECRET)).toBeNull();
    });

    it('rejects an empty signature', async () => {
      expect(await verifySignatureEdge('abc123.', SECRET)).toBeNull();
    });

    it('rejects an empty string', async () => {
      expect(await verifySignatureEdge('', SECRET)).toBeNull();
    });
  });

  it('splits on the LAST dot for a userId that itself contains dots', async () => {
    const userId = 'user.with.dots.in.it';
    const cookieValue = signWithNode(userId);

    const result = await verifySignatureEdge(cookieValue, SECRET);

    expect(result).toBe(userId);
  });

  it('accepts an uppercase hex signature (received sig is lowercased before comparing)', async () => {
    const userId = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
    const cookieValue = signWithNode(userId);
    const [id, sig] = cookieValue.split('.');
    const uppercased = `${id}.${sig.toUpperCase()}`;

    const result = await verifySignatureEdge(uppercased, SECRET);

    expect(result).toBe(userId);
  });
});
