// Keyboard-wedge barcode scan detection, as a pure state machine.
//
// A wedge scanner types the barcode as fast keystrokes followed by Enter. A
// person types slowly. The only reliable tell is timing:
//
//   - a gap of < SCAN_MAX_GAP_MS (40 ms) between characters continues a burst;
//     a gap of 40 ms or more (or a clock that went backwards) restarts the
//     buffer with the new character, so slow typing never accumulates;
//   - a burst commits on Enter, or on an idle flush after SCAN_IDLE_FLUSH_MS
//     (100 ms) for scanners configured without a terminator;
//   - an optional leading "~" (a scanner prefix that keeps the first character
//     from landing in a focused input) is stripped before validation;
//   - a committed burst must match the STRICT hanger code
//     (lib/trim/hanger-code.ts), otherwise it is reported as rejected noise;
//   - the buffer is reset after every commit, so scans never bleed together.
//
// No DOM, no timers, no Date.now(): the caller (the useScannerWedge hook) passes
// the event timestamp in, and uses nextFlushAt() to schedule its own timeout.
// Every function returns a new state; nothing is mutated.
//
// Outcome null means "not a scan" (a human's keystrokes, a lone Enter) — the
// hook should let those through to whatever input has focus.

import { parseHangerCodeStrict, type HangerCodeError } from './hanger-code'

export const SCAN_MAX_GAP_MS = 40
export const SCAN_IDLE_FLUSH_MS = 100
export const SCAN_PREFIX = '~'
/** Longer than any real tag; stops a stuck key from growing the buffer forever. */
export const SCAN_MAX_CHARS = 64

export interface ScanBufferState {
  chars: string
  /** Timestamp of the most recent character, or null when the buffer is empty. */
  lastAt: number | null
  /** True once two characters arrived less than SCAN_MAX_GAP_MS apart. */
  burst: boolean
  overflow: boolean
}

export type ScanRejectReason = HangerCodeError | 'too_long'

export type ScanOutcome =
  | { kind: 'scan'; code: string }
  | { kind: 'rejected'; raw: string; reason: ScanRejectReason }

export interface ScanStep {
  state: ScanBufferState
  outcome: ScanOutcome | null
}

export function createScanBuffer(): ScanBufferState {
  return { chars: '', lastAt: null, burst: false, overflow: false }
}

/** When the caller should next call flushIfIdle(), or null if nothing is buffered. */
export function nextFlushAt(state: ScanBufferState): number | null {
  return state.chars === '' || state.lastAt === null ? null : state.lastAt + SCAN_IDLE_FLUSH_MS
}

function commit(state: ScanBufferState): ScanStep {
  const fresh = createScanBuffer()
  // A single slow character is somebody typing, not a scan.
  if (!state.burst) return { state: fresh, outcome: null }

  if (state.overflow) {
    return { state: fresh, outcome: { kind: 'rejected', raw: state.chars, reason: 'too_long' } }
  }
  const raw = state.chars.startsWith(SCAN_PREFIX) ? state.chars.slice(SCAN_PREFIX.length) : state.chars
  const parsed = parseHangerCodeStrict(raw)
  return {
    state: fresh,
    outcome: parsed.ok
      ? { kind: 'scan', code: parsed.code }
      : { kind: 'rejected', raw, reason: parsed.error },
  }
}

/**
 * Feed one keydown. `key` is KeyboardEvent.key: 'Enter' commits, a single
 * printable character is buffered, anything else (Shift, Tab, arrows, ...) is
 * ignored and leaves the state untouched.
 *
 * If a burst is still sitting in the buffer past the idle window when the next
 * character arrives (the caller's flush timer didn't fire — a throttled
 * background tab), it is committed first and the new character starts a fresh
 * buffer, so that scan is not lost.
 */
export function feedKey(state: ScanBufferState, key: string, at: number): ScanStep {
  if (key === 'Enter') return commit(state)
  if (key.length !== 1) return { state, outcome: null }

  const gap = state.lastAt === null ? null : at - state.lastAt

  if (state.chars !== '' && gap !== null && gap >= 0 && gap < SCAN_MAX_GAP_MS) {
    if (state.chars.length >= SCAN_MAX_CHARS) {
      return { state: { ...state, lastAt: at, burst: true, overflow: true }, outcome: null }
    }
    return { state: { ...state, chars: state.chars + key, lastAt: at, burst: true }, outcome: null }
  }

  const next: ScanBufferState = { chars: key, lastAt: at, burst: false, overflow: false }
  if (state.burst && gap !== null && gap >= SCAN_IDLE_FLUSH_MS) {
    return { state: next, outcome: commit(state).outcome }
  }
  return { state: next, outcome: null }
}

/**
 * Idle flush: if the last character was at least SCAN_IDLE_FLUSH_MS ago,
 * commit (or discard) whatever is buffered. Call it from the hook's timer.
 */
export function flushIfIdle(state: ScanBufferState, now: number): ScanStep {
  if (state.chars === '' || state.lastAt === null) return { state, outcome: null }
  if (now - state.lastAt < SCAN_IDLE_FLUSH_MS) return { state, outcome: null }
  return commit(state)
}

/** Drop whatever is buffered (focus moved to a weight field, route change, ...). */
export function resetScanBuffer(): ScanBufferState {
  return createScanBuffer()
}
