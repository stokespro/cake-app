// Regression coverage for reconcileSessionCheck() — the pure, dependency-
// injected core of AuthProvider's session reconciliation (lib/auth-context.tsx).
// Extracted specifically so this is unit-testable without a DOM/React
// rendering environment: this repo's vitest config runs with
// `environment: 'node'` and has neither jsdom nor @testing-library/react
// installed, so a hooks-based test would need new test infrastructure this
// pass intentionally avoids adding.
//
// The highest-value case here is "the logout epoch": a session check that
// resolves AFTER a concurrent logout() (or any other hard session clear)
// must be discarded entirely — it must not call onValid/onUnauthenticated/
// onError, and critically must not call refreshCookie, which would
// otherwise slide the crm-session cookie's expiration forward on a device
// the operator just signed out of (see "Kill the logout resurrect race",
// SPRO-13 pass 2).

import { describe, expect, it, vi } from 'vitest';
import { reconcileSessionCheck, type SessionCheckDeps } from './auth-context';
import type { SessionCheck } from '@/lib/auth/session';

const VALID_RESULT: SessionCheck = {
  status: 'valid',
  session: { userId: 'user-123', role: 'admin', name: 'Jane Doe' },
};

function makeDeps(overrides: Partial<SessionCheckDeps> & { checkSession: SessionCheckDeps['checkSession'] }): SessionCheckDeps & {
  onValid: ReturnType<typeof vi.fn>;
  onUnauthenticated: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  refreshCookie: ReturnType<typeof vi.fn>;
} {
  return {
    getEpoch: () => 0,
    refreshCookie: vi.fn().mockResolvedValue(undefined),
    onValid: vi.fn(),
    onUnauthenticated: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  } as SessionCheckDeps & {
    onValid: ReturnType<typeof vi.fn>;
    onUnauthenticated: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    refreshCookie: ReturnType<typeof vi.fn>;
  };
}

describe('reconcileSessionCheck', () => {
  it('calls onValid and refreshes the cookie when the epoch is unchanged', async () => {
    const deps = makeDeps({ checkSession: vi.fn().mockResolvedValue(VALID_RESULT) });

    await reconcileSessionCheck(deps);

    expect(deps.onValid).toHaveBeenCalledTimes(1);
    expect(deps.onValid).toHaveBeenCalledWith(VALID_RESULT.session);
    expect(deps.onUnauthenticated).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
    // refreshCookie is fire-and-forget (not awaited by reconcileSessionCheck),
    // so flush microtasks once before asserting.
    await Promise.resolve();
    // Takes no arguments — the server derives identity from its own verified
    // session, never from a value the client passes in (SPRO-13 auth-bypass
    // fix). Asserting the zero-arg call shape here would regress silently if
    // someone reintroduces a userId parameter.
    expect(deps.refreshCookie).toHaveBeenCalledWith();
  });

  it('calls onUnauthenticated when the epoch is unchanged and the session is dead', async () => {
    const deps = makeDeps({ checkSession: vi.fn().mockResolvedValue({ status: 'unauthenticated' }) });

    await reconcileSessionCheck(deps);

    expect(deps.onUnauthenticated).toHaveBeenCalledTimes(1);
    expect(deps.onValid).not.toHaveBeenCalled();
    expect(deps.refreshCookie).not.toHaveBeenCalled();
  });

  it('calls onError on an inconclusive result', async () => {
    const deps = makeDeps({ checkSession: vi.fn().mockResolvedValue({ status: 'error' }) });

    await reconcileSessionCheck(deps);

    expect(deps.onError).toHaveBeenCalledTimes(1);
    expect(deps.onValid).not.toHaveBeenCalled();
    expect(deps.onUnauthenticated).not.toHaveBeenCalled();
  });

  // THE logout-epoch regression test: a logout() (modeled here as the epoch
  // being bumped mid-flight, exactly as lib/auth-context.tsx's real
  // sessionEpochRef does) that lands while checkSession() is still pending
  // must make the eventual 'valid' result a no-op.
  it('discards a valid result whose epoch went stale while checkSession() was in flight — must NOT restore state or refresh the cookie', async () => {
    let epoch = 0;
    const deps = makeDeps({
      getEpoch: () => epoch,
      checkSession: vi.fn().mockImplementation(async () => {
        // Simulate logout() firing (bumping the epoch) while this check is
        // still awaiting its result — the real-world race this guards
        // against.
        epoch += 1;
        return VALID_RESULT;
      }),
    });

    await reconcileSessionCheck(deps);

    expect(deps.onValid).not.toHaveBeenCalled();
    expect(deps.onUnauthenticated).not.toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
    expect(deps.refreshCookie).not.toHaveBeenCalled();
  });

  it('discards an unauthenticated result whose epoch went stale (no double state write)', async () => {
    let epoch = 0;
    const deps = makeDeps({
      getEpoch: () => epoch,
      checkSession: vi.fn().mockImplementation(async () => {
        epoch += 1;
        return { status: 'unauthenticated' } satisfies SessionCheck;
      }),
    });

    await reconcileSessionCheck(deps);

    expect(deps.onUnauthenticated).not.toHaveBeenCalled();
  });

  it('a non-stale check still resolves normally when the epoch happens to be non-zero throughout', async () => {
    const deps = makeDeps({
      getEpoch: () => 7,
      checkSession: vi.fn().mockResolvedValue(VALID_RESULT),
    });

    await reconcileSessionCheck(deps);

    expect(deps.onValid).toHaveBeenCalledWith(VALID_RESULT.session);
  });

  // Note on the 30-minute heartbeat (SESSION_HEARTBEAT_MS) added to
  // AuthProvider for unattended displays (/cultivation-display TVs, kiosks
  // that never fire `visibilitychange`): it is intentionally just a
  // `setInterval(runSessionCheck, SESSION_HEARTBEAT_MS)` wired into the same
  // mount effect as the visibilitychange listener — it calls the exact same
  // runSessionCheck() (same checkInFlightRef guard) which calls this exact
  // reconcileSessionCheck() (same epoch guard) as the mount and
  // visibilitychange paths already under test above. There is no new pure
  // logic to unit test: a heartbeat-triggered check IS a mount/visibility-
  // triggered check as far as reconcileSessionCheck is concerned, including
  // the stale-epoch discard covered by the tests above. Adding a
  // heartbeat-specific test here would just re-run the same assertions
  // against a fake timer with no new code path exercised.
});
