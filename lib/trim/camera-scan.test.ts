import { describe, expect, it } from 'vitest'
import {
  CONFIRM_FRAMES,
  GUIDE_BOX,
  STALL_TIMEOUT_MS,
  cameraAvailable,
  classifyCameraError,
  confirmFrame,
  coverCropRect,
  createConfirmState,
  createStallState,
  fitWithin,
  observeStall,
  type ConfirmState,
} from './camera-scan'

function run(reads: Array<string | null>, opts?: Parameters<typeof confirmFrame>[2]) {
  let state: ConfirmState = createConfirmState()
  const confirmedAt: Array<{ i: number; value: string }> = []
  reads.forEach((r, i) => {
    const step = confirmFrame(state, r, opts)
    state = step.state
    if (step.confirmed) confirmedAt.push({ i, value: step.confirmed })
  })
  return { state, confirmedAt }
}

describe('confirmFrame', () => {
  it('defaults to three identical reads', () => {
    expect(CONFIRM_FRAMES).toBe(3)
    expect(run(['H1B-001', 'H1B-001']).confirmedAt).toEqual([])
    expect(run(['H1B-001', 'H1B-001', 'H1B-001']).confirmedAt).toEqual([{ i: 2, value: 'H1B-001' }])
  })

  it('restarts the streak when the value changes (a single misread never confirms)', () => {
    const { confirmedAt } = run(['H1B-001', 'H1B-002', 'H1B-001', 'H1B-002'])
    expect(confirmedAt).toEqual([])
  })

  it('counts the new value from 1 after a change', () => {
    const { confirmedAt } = run(['H1B-009', 'H1B-001', 'H1B-001', 'H1B-001'])
    expect(confirmedAt).toEqual([{ i: 3, value: 'H1B-001' }])
  })

  it('tolerates one empty frame inside a streak', () => {
    const { confirmedAt } = run(['H1B-001', null, 'H1B-001', 'H1B-001'])
    expect(confirmedAt).toEqual([{ i: 3, value: 'H1B-001' }])
  })

  it('drops the streak after two empty frames in a row', () => {
    const { confirmedAt } = run(['H1B-001', 'H1B-001', null, null, 'H1B-001'])
    expect(confirmedAt).toEqual([])
  })

  it('a successful read resets the miss counter', () => {
    const { confirmedAt } = run(['H1B-001', null, 'H1B-001', null, 'H1B-001'])
    expect(confirmedAt).toEqual([{ i: 4, value: 'H1B-001' }])
  })

  it('honours custom required and zero tolerance', () => {
    expect(run(['A', 'A'], { required: 2 }).confirmedAt).toEqual([{ i: 1, value: 'A' }])
    expect(run(['A', null, 'A'], { required: 2, missTolerance: 0 }).confirmedAt).toEqual([])
  })

  it('empty frames before any read change nothing', () => {
    const { state } = run([null, null, ''])
    expect(state).toEqual(createConfirmState())
  })

  it('starts a fresh streak after confirming, so the same value can confirm again', () => {
    const { confirmedAt } = run(Array(6).fill('H1B-001'))
    expect(confirmedAt.map((c) => c.i)).toEqual([2, 5])
  })

  it('does not mutate the previous state', () => {
    const a = createConfirmState()
    confirmFrame(a, 'X')
    expect(a).toEqual({ value: null, count: 0, misses: 0 })
  })
})

describe('coverCropRect', () => {
  it('maps the guide onto a frame that already matches the container aspect', () => {
    const r = coverCropRect(1600, 1200, 4 / 3)!
    expect(r).toEqual({
      sx: Math.round(0.08 * 1600),
      sy: Math.round(0.3 * 1200),
      sw: Math.round(0.84 * 1600),
      sh: Math.round(0.4 * 1200),
    })
  })

  it('accounts for cover cropping a portrait frame into a landscape container', () => {
    // 1080x1920 portrait into 4:3: only the middle 1080x810 band is visible.
    const r = coverCropRect(1080, 1920, 4 / 3)!
    const offY = (1920 - 810) / 2
    expect(r.sx).toBe(Math.round(0.08 * 1080))
    expect(r.sy).toBe(Math.round(offY + 0.3 * 810))
    expect(r.sw).toBe(Math.round(0.84 * 1080))
    expect(r.sh).toBe(Math.round(0.4 * 810))
  })

  it('accounts for cover cropping a wide frame into a squarer container', () => {
    // 1920x1080 into 1:1: visible region is the middle 1080x1080 columns.
    const r = coverCropRect(1920, 1080, 1)!
    const offX = (1920 - 1080) / 2
    expect(r.sx).toBe(Math.round(offX + 0.08 * 1080))
    expect(r.sw).toBe(Math.round(0.84 * 1080))
  })

  it('stays inside the frame', () => {
    const r = coverCropRect(640, 480, 4 / 3, { x: 0.5, y: 0.5, w: 0.9, h: 0.9 })!
    expect(r.sx + r.sw).toBeLessThanOrEqual(640)
    expect(r.sy + r.sh).toBeLessThanOrEqual(480)
  })

  it('returns null for unusable input', () => {
    expect(coverCropRect(0, 480, 1.3)).toBeNull()
    expect(coverCropRect(640, 480, 0)).toBeNull()
    expect(coverCropRect(NaN, 480, 1.3)).toBeNull()
  })

  it('default guide is wide and short', () => {
    expect(GUIDE_BOX.w).toBeGreaterThan(GUIDE_BOX.h)
  })
})

describe('fitWithin', () => {
  it('downscales the long edge and keeps the aspect', () => {
    expect(fitWithin(4000, 3000, 2000)).toEqual({ w: 2000, h: 1500 })
    expect(fitWithin(3000, 4000, 2000)).toEqual({ w: 1500, h: 2000 })
  })
  it('never upscales', () => {
    expect(fitWithin(800, 600, 2000)).toEqual({ w: 800, h: 600 })
  })
})

describe('observeStall', () => {
  it('is not stalled while currentTime keeps moving', () => {
    let s = createStallState(0)
    for (let t = 100; t <= 10_000; t += 100) {
      const r = observeStall(s, t / 1000, t)
      s = r.state
      expect(r.stalled).toBe(false)
    }
  })

  it('stalls when no first frame ever arrives', () => {
    const s = createStallState(0)
    expect(observeStall(s, 0, STALL_TIMEOUT_MS - 1).stalled).toBe(false)
    expect(observeStall(s, 0, STALL_TIMEOUT_MS).stalled).toBe(true)
  })

  it('stalls when a running stream freezes', () => {
    let s = createStallState(0)
    s = observeStall(s, 1.0, 1000).state
    expect(observeStall(s, 1.0, 1000 + STALL_TIMEOUT_MS - 1).stalled).toBe(false)
    expect(observeStall(s, 1.0, 1000 + STALL_TIMEOUT_MS).stalled).toBe(true)
  })

  it('recovers if frames resume', () => {
    let s = createStallState(0)
    s = observeStall(s, 1.0, 1000).state
    const r = observeStall(s, 2.5, 3500)
    expect(r.stalled).toBe(false)
    expect(r.state.lastProgressAt).toBe(3500)
  })
})

describe('cameraAvailable / classifyCameraError', () => {
  it('needs a secure context and mediaDevices', () => {
    expect(cameraAvailable({ isSecureContext: true, hasMediaDevices: true })).toBe(true)
    expect(cameraAvailable({ isSecureContext: false, hasMediaDevices: true })).toBe(false)
    expect(cameraAvailable({ isSecureContext: true, hasMediaDevices: false })).toBe(false)
  })

  it('classifies permission, missing device and everything else', () => {
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('denied')
    expect(classifyCameraError({ name: 'SecurityError' })).toBe('denied')
    expect(classifyCameraError({ name: 'NotFoundError' })).toBe('no_camera')
    expect(classifyCameraError({ name: 'NotReadableError' })).toBe('unavailable')
    expect(classifyCameraError({ name: 'OverconstrainedError' })).toBe('unavailable')
    expect(classifyCameraError(new Error('x'))).toBe('unavailable')
    expect(classifyCameraError(null)).toBe('unavailable')
  })
})
