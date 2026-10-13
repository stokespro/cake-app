import { describe, expect, it } from 'vitest'
import {
  SCAN_IDLE_FLUSH_MS,
  SCAN_MAX_CHARS,
  SCAN_MAX_GAP_MS,
  createScanBuffer,
  feedKey,
  flushIfIdle,
  nextFlushAt,
  resetScanBuffer,
  type ScanBufferState,
  type ScanOutcome,
} from './scan-buffer'

/** Type `text` starting at `t0`, `gap` ms apart; returns the final state, last timestamp and any outcomes. */
function type(
  text: string,
  { t0 = 1000, gap = 10, from = createScanBuffer() }: { t0?: number; gap?: number; from?: ScanBufferState } = {}
) {
  let state = from
  let t = t0
  const outcomes: ScanOutcome[] = []
  for (const ch of text) {
    const step = feedKey(state, ch, t)
    state = step.state
    if (step.outcome) outcomes.push(step.outcome)
    t += gap
  }
  return { state, last: t - gap, outcomes }
}

describe('constants', () => {
  it('match the plan', () => {
    expect(SCAN_MAX_GAP_MS).toBe(40)
    expect(SCAN_IDLE_FLUSH_MS).toBe(100)
  })
})

describe('burst + Enter commits', () => {
  it('a fast burst then Enter is a scan', () => {
    const { state, last } = type('H1B-042')
    const step = feedKey(state, 'Enter', last + 5)
    expect(step.outcome).toEqual({ kind: 'scan', code: 'H1B-042' })
  })

  it('works at a 1 ms and a 39 ms inter-character gap', () => {
    for (const gap of [1, 39]) {
      const { state, last } = type('H1B-007', { gap })
      expect(feedKey(state, 'Enter', last + gap).outcome).toEqual({ kind: 'scan', code: 'H1B-007' })
    }
  })

  it('the buffer is empty after a commit (reset between scans)', () => {
    const { state, last } = type('H1B-042')
    const step = feedKey(state, 'Enter', last + 5)
    expect(step.state).toEqual(createScanBuffer())
  })

  it('two scans back to back do not bleed together', () => {
    let s = createScanBuffer()
    const results: ScanOutcome[] = []
    let t = 1000
    for (const code of ['H1B-001', 'H1B-002']) {
      for (const ch of code) {
        const step = feedKey(s, ch, t)
        s = step.state
        t += 10
      }
      const step = feedKey(s, 'Enter', t)
      s = step.state
      if (step.outcome) results.push(step.outcome)
      t += 500
    }
    expect(results).toEqual([
      { kind: 'scan', code: 'H1B-001' },
      { kind: 'scan', code: 'H1B-002' },
    ])
  })
})

describe('slow typing is not a scan', () => {
  it('a gap of exactly 40 ms restarts the buffer', () => {
    const { state, last } = type('H1B-042', { gap: 40 })
    expect(state.chars).toBe('2')
    expect(feedKey(state, 'Enter', last + 40).outcome).toBeNull()
  })

  it('human typing with Enter yields nothing', () => {
    const { state, last } = type('H1B-042', { gap: 150 })
    const step = feedKey(state, 'Enter', last + 150)
    expect(step.outcome).toBeNull()
  })

  it('a pause in the middle of a burst drops what came before', () => {
    let { state, last } = type('H1B-')
    ;({ state, last } = type('042', { from: state, t0: last + 60 }))
    expect(state.chars).toBe('042')
    const step = feedKey(state, 'Enter', last + 5)
    expect(step.outcome).toEqual({ kind: 'rejected', raw: '042', reason: 'invalid_format' })
  })

  it('a lone Enter does nothing', () => {
    expect(feedKey(createScanBuffer(), 'Enter', 1000).outcome).toBeNull()
  })

  it('a single character then Enter does nothing', () => {
    const a = feedKey(createScanBuffer(), '4', 1000)
    expect(feedKey(a.state, 'Enter', 1010).outcome).toBeNull()
  })

  it('a clock that goes backwards restarts the buffer instead of extending a burst', () => {
    const a = feedKey(createScanBuffer(), 'H', 1000)
    const b = feedKey(a.state, '1', 990)
    expect(b.state.chars).toBe('1')
    expect(b.state.burst).toBe(false)
  })
})

describe('idle flush', () => {
  it('commits a terminator-less scan once idle for 100 ms', () => {
    const { state, last } = type('H1B-042')
    expect(flushIfIdle(state, last + 99).outcome).toBeNull()
    expect(flushIfIdle(state, last + 100).outcome).toEqual({ kind: 'scan', code: 'H1B-042' })
  })

  it('does not flush before 100 ms and leaves the state alone', () => {
    const { state, last } = type('H1B-042')
    const step = flushIfIdle(state, last + 50)
    expect(step.state).toBe(state)
  })

  it('resets after flushing', () => {
    const { state, last } = type('H1B-042')
    expect(flushIfIdle(state, last + 100).state).toEqual(createScanBuffer())
  })

  it('discards a lone slow character silently on flush', () => {
    const a = feedKey(createScanBuffer(), '4', 1000)
    const step = flushIfIdle(a.state, 1200)
    expect(step.outcome).toBeNull()
    expect(step.state).toEqual(createScanBuffer())
  })

  it('does nothing on an empty buffer', () => {
    const s = createScanBuffer()
    expect(flushIfIdle(s, 5000)).toEqual({ state: s, outcome: null })
  })

  it('nextFlushAt schedules 100 ms after the last character', () => {
    expect(nextFlushAt(createScanBuffer())).toBeNull()
    const { state, last } = type('H1B-04')
    expect(nextFlushAt(state)).toBe(last + 100)
  })

  it('a stale unflushed burst is committed when the next character arrives late', () => {
    const { state, last } = type('H1B-042')
    const step = feedKey(state, 'x', last + 5000)
    expect(step.outcome).toEqual({ kind: 'scan', code: 'H1B-042' })
    expect(step.state.chars).toBe('x')
  })
})

describe('~ prefix', () => {
  it('is optional and stripped', () => {
    const { state, last } = type('~H1B-042')
    expect(feedKey(state, 'Enter', last + 5).outcome).toEqual({ kind: 'scan', code: 'H1B-042' })
  })

  it('works with idle flush too', () => {
    const { state, last } = type('~H1B-042')
    expect(flushIfIdle(state, last + 100).outcome).toEqual({ kind: 'scan', code: 'H1B-042' })
  })

  it('a double prefix is noise', () => {
    const { state, last } = type('~~H1B-042')
    expect(feedKey(state, 'Enter', last + 5).outcome).toMatchObject({ kind: 'rejected', reason: 'invalid_format' })
  })
})

describe('noise is rejected by the code regex', () => {
  it.each([
    ['H1B-42', 'invalid_format'],
    ['h1b-042', 'invalid_format'],
    ['H1B-0420', 'invalid_format'],
    ['H1B-000', 'out_of_range'],
    ['garbage', 'invalid_format'],
    ['1A4FF0100000022000001234', 'looks_like_metrc_tag'],
  ])('%s -> %s', (text, reason) => {
    const { state, last } = type(text)
    expect(feedKey(state, 'Enter', last + 5).outcome).toEqual({ kind: 'rejected', raw: text, reason })
  })

  it('an over-long burst is rejected as too_long, and the buffer stays bounded', () => {
    const { state, last } = type('A'.repeat(SCAN_MAX_CHARS + 30), { gap: 1 })
    expect(state.chars.length).toBeLessThanOrEqual(SCAN_MAX_CHARS)
    expect(feedKey(state, 'Enter', last + 1).outcome).toMatchObject({ kind: 'rejected', reason: 'too_long' })
  })
})

describe('non-character keys', () => {
  it('Shift, Tab and arrows are ignored and keep the burst intact', () => {
    let { state, last } = type('H1B-0')
    for (const key of ['Shift', 'Tab', 'ArrowLeft', 'Control']) {
      const step = feedKey(state, key, last + 1)
      expect(step.state).toBe(state)
      expect(step.outcome).toBeNull()
    }
    ;({ state, last } = type('42', { from: state, t0: last + 5 }))
    expect(feedKey(state, 'Enter', last + 5).outcome).toEqual({ kind: 'scan', code: 'H1B-042' })
  })
})

describe('resetScanBuffer', () => {
  it('returns an empty buffer', () => {
    expect(resetScanBuffer()).toEqual(createScanBuffer())
  })
  it('a reset mid-burst forgets the partial scan', () => {
    const { state, last } = type('H1B-0')
    expect(state.chars).not.toBe('')
    const s = resetScanBuffer()
    const { state: s2, last: l2 } = type('H1B-042', { from: s, t0: last + 5 })
    expect(feedKey(s2, 'Enter', l2 + 5).outcome).toEqual({ kind: 'scan', code: 'H1B-042' })
  })
})
