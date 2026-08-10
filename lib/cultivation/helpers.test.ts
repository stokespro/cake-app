// Regression coverage for getFlowerWeek()'s day->week math.
//
// Week 1 covers the first seven days of flower (day 0-6 since flowerStart),
// so the boundary is an off-by-one hazard: day 6 must still read W1 and day
// 7 must roll to W2. `today` is always passed explicitly so these stay
// deterministic and don't depend on the real clock.

import { describe, expect, it } from 'vitest'
import {
  getFlowerWeek,
  getCycleStageLabel,
  resolveTaskDueDate,
  resolveTaskPhaseAndDay,
  type CycleMilestones,
} from './helpers'
import { STAGE_ORDER } from '@/types/cultivation'

const FLOWER_START = '2026-01-01'

function daysAfterFlowerStart(days: number): Date {
  return new Date(`2026-01-${String(1 + days).padStart(2, '0')}T12:00:00`)
}

describe('getFlowerWeek', () => {
  it('returns W1 when flower starts today (day 0)', () => {
    expect(getFlowerWeek(FLOWER_START, daysAfterFlowerStart(0))).toBe(1)
  })

  it('returns W1 on day 6 (last day of week 1)', () => {
    expect(getFlowerWeek(FLOWER_START, daysAfterFlowerStart(6))).toBe(1)
  })

  it('returns W2 on day 7 (first day of week 2)', () => {
    expect(getFlowerWeek(FLOWER_START, daysAfterFlowerStart(7))).toBe(2)
  })

  it('returns W2 on day 13 (last day of week 2)', () => {
    expect(getFlowerWeek(FLOWER_START, daysAfterFlowerStart(13))).toBe(2)
  })

  it('returns W3 on day 14 (first day of week 3)', () => {
    expect(getFlowerWeek(FLOWER_START, daysAfterFlowerStart(14))).toBe(3)
  })

  it('returns W10 on a realistic long case (day 63)', () => {
    // day 63 = 9 full weeks elapsed (63 / 7 = 9) -> week 10
    const today = new Date('2026-03-05T12:00:00') // 63 days after 2026-01-01
    expect(getFlowerWeek(FLOWER_START, today)).toBe(10)
  })

  it('returns null for a null flowerStart', () => {
    expect(getFlowerWeek(null, daysAfterFlowerStart(10))).toBeNull()
  })

  it('returns null for an empty-string flowerStart', () => {
    expect(getFlowerWeek('', daysAfterFlowerStart(10))).toBeNull()
  })

  it('clamps to W1 when today is before flowerStart', () => {
    const beforeStart = new Date('2025-12-25T12:00:00')
    expect(getFlowerWeek(FLOWER_START, beforeStart)).toBe(1)
  })

  // DST regressions — these dates are deliberately chosen to straddle a US
  // DST transition, not arbitrary. Do not "simplify" them to same-season
  // dates: getFlowerWeek used to compute elapsed days as a raw millisecond
  // delta divided by 86400000. A DST spring-forward day is only 23 hours, so
  // a true 14-calendar-day span measured ~13.958 days and floored down to
  // 13, showing the wrong week a day early. differenceInCalendarDays (which
  // the implementation now uses) is immune to this.
  it('counts calendar days correctly across a spring-forward DST boundary', () => {
    // Second Sunday of March 2027 (2027-03-14) is the US spring-forward
    // transition. 2027-03-01 -> 2027-03-15 is 14 calendar days -> W3.
    expect(getFlowerWeek('2027-03-01', new Date('2027-03-15T00:00:00'))).toBe(3)
  })

  it('counts calendar days correctly across a fall-back DST boundary', () => {
    // First Sunday of November 2026 (2026-11-01) is the US fall-back
    // transition. 2026-10-25 -> 2026-11-08 is 14 calendar days -> W3.
    expect(getFlowerWeek('2026-10-25', new Date('2026-11-08T00:00:00'))).toBe(3)
  })

  // Verified against live production data (today = 2026-08-06).
  it('matches production: F1 cycle 2 (flower_start 2026-07-27) -> W2', () => {
    expect(getFlowerWeek('2026-07-27', new Date('2026-08-06T00:00:00'))).toBe(2)
  })

  it('matches production: F3 cycle 2 (flower_start 2026-06-26) -> W6', () => {
    expect(getFlowerWeek('2026-06-26', new Date('2026-08-06T00:00:00'))).toBe(6)
  })

  it('matches production: F5 cycle 2 (flower_start 2026-06-23) -> W7', () => {
    expect(getFlowerWeek('2026-06-23', new Date('2026-08-06T00:00:00'))).toBe(7)
  })
})

describe('getCycleStageLabel', () => {
  it('labels a flower-stage cycle with its week', () => {
    expect(getCycleStageLabel('flower', FLOWER_START, daysAfterFlowerStart(7))).toBe(
      'Flower W2'
    )
  })

  it('falls back to plain "Flower" when the week cannot be computed', () => {
    expect(getCycleStageLabel('flower', null, daysAfterFlowerStart(7))).toBe('Flower')
  })

  it('labels non-flower stages via PHASE_CONFIG, unaffected by flowerStart', () => {
    expect(getCycleStageLabel('veg', FLOWER_START, daysAfterFlowerStart(7))).toBe('Veg')
    expect(getCycleStageLabel('dome', null)).toBe('Dome')
    expect(getCycleStageLabel('harvest', null)).toBe('Harvest')
    expect(getCycleStageLabel('dry', null)).toBe('Dry')
    expect(getCycleStageLabel('trim', null)).toBe('Trim')
  })

  it('falls back to the raw stage string for an unrecognized stage', () => {
    expect(getCycleStageLabel('mystery-stage', null)).toBe('mystery-stage')
  })
})

describe('resolveTaskPhaseAndDay', () => {
  // Milestones spaced with generous buffers so day_number sweeps in the
  // round-trip test below land squarely inside each phase and never spill
  // into the next one — a spillover isn't a bug (see the "picks by date"
  // test), it would just make the round-trip assertion meaningless.
  const SPACED_MILESTONES: CycleMilestones = {
    dome: '2026-01-01',
    veg: '2026-01-10', // 9-day buffer for dome
    flower: '2026-01-24', // 14-day buffer for veg
    harvest: '2026-03-25', // 60-day buffer for flower
    dry: '2026-04-05', // 11-day buffer for harvest
    trim: '2026-04-16', // 11-day buffer for dry
  }

  it('round-trips through resolveTaskDueDate for day_number 1..5 in every phase', () => {
    for (const phase of STAGE_ORDER) {
      for (const day of [1, 2, 3, 4, 5]) {
        const dueDate = resolveTaskDueDate(SPACED_MILESTONES, phase, day)
        const result = resolveTaskPhaseAndDay(SPACED_MILESTONES, dueDate)
        expect(result).toEqual({ phase, day_number: day })
      }
    }
  })

  it('returns day 1 when the due date lands exactly on a milestone', () => {
    expect(resolveTaskPhaseAndDay(SPACED_MILESTONES, '2026-01-24')).toEqual({
      phase: 'flower',
      day_number: 1,
    })
  })

  it('resolves a harvest_date === dry_start tie to dry (later in STAGE_ORDER)', () => {
    // flip-room-dialog.tsx defaults dry_start to harvest_date, so this tie
    // happens on essentially every cycle created through the normal UI.
    const milestones: CycleMilestones = {
      ...SPACED_MILESTONES,
      harvest: '2026-03-25',
      dry: '2026-03-25',
    }
    expect(resolveTaskPhaseAndDay(milestones, '2026-03-25')).toEqual({
      phase: 'dry',
      day_number: 1,
    })
  })

  it('never returns a phase whose milestone is null/empty', () => {
    // Cycle is only as far as flower — harvest/dry/trim aren't set yet.
    const milestones: CycleMilestones = {
      dome: '2026-01-01',
      veg: '2026-01-10',
      flower: '2026-01-24',
      harvest: '',
      dry: '',
      trim: '',
    }
    // Even a due date far in the future can't resolve to harvest/dry/trim
    // since those milestones don't exist yet.
    const result = resolveTaskPhaseAndDay(milestones, '2026-12-31')
    expect(result?.phase).toBe('flower')
  })

  it('returns null when the due date is before every known milestone', () => {
    expect(resolveTaskPhaseAndDay(SPACED_MILESTONES, '2025-12-25')).toBeNull()
  })

  it('picks the candidate by actual date value, not STAGE_ORDER index, when milestones are stored out of order', () => {
    // dome_start stored AFTER veg_start — startCycle never validates
    // ordering (only updateCycle does), so this can genuinely happen.
    const milestones: CycleMilestones = {
      dome: '2026-01-10',
      veg: '2026-01-05',
      flower: '',
      harvest: '',
      dry: '',
      trim: '',
    }
    // Both dome (01-10) and veg (01-05) qualify as candidates for this due
    // date; dome's date is later, so dome wins even though its STAGE_ORDER
    // index (0) is earlier than veg's (1).
    expect(resolveTaskPhaseAndDay(milestones, '2026-01-20')).toEqual({
      phase: 'dome',
      day_number: 11,
    })
  })

  it('returns trim with an unbounded (large) day_number for a due date long past the last milestone', () => {
    const milestones: CycleMilestones = { ...SPACED_MILESTONES }
    // ~46 days after trim_start (2026-04-16) — phases are unbounded, the
    // forward function clamps nothing, so neither does the inverse.
    expect(resolveTaskPhaseAndDay(milestones, '2026-06-01')).toEqual({
      phase: 'trim',
      day_number: 47,
    })
  })
})
