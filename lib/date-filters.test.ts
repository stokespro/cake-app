import { describe, expect, it } from 'vitest'
import {
  COMMISSION_DATE_PRESETS,
  COMPLIANCE_DATE_PRESETS,
  CULTIVATION_TASK_DATE_PRESETS,
  DATE_PRESET_LABELS,
  DISPENSARY_DATE_PRESETS,
  MY_COMMISSION_DATE_PRESETS,
  ORDER_DATE_PRESETS,
  datePresetOptions,
  isWithinDateRange,
  parseDatePresetKey,
  resolveDatePresetRange,
  todayDateString,
  type DatePresetKey,
} from '@/lib/date-filters'

/** Every page-level preset array, keyed by export name for readable failures. */
const PAGE_PRESETS: Record<string, DatePresetKey[]> = {
  ORDER_DATE_PRESETS,
  CULTIVATION_TASK_DATE_PRESETS,
  DISPENSARY_DATE_PRESETS,
  COMMISSION_DATE_PRESETS,
  MY_COMMISSION_DATE_PRESETS,
  COMPLIANCE_DATE_PRESETS,
}

/**
 * Wednesday 18 Mar 2026 — a mid-week, mid-month, mid-quarter reference date, so
 * every boundary a preset can land on is visibly distinct from it. Constructed
 * with the local-time Date constructor (not an ISO string) because every preset
 * resolves against local `yyyy-MM-dd`.
 */
const REFERENCE = new Date(2026, 2, 18)

describe('resolveDatePresetRange', () => {
  it('leaves both edges unbounded for "all"', () => {
    expect(resolveDatePresetRange('all', {}, REFERENCE)).toEqual({
      dateFrom: null,
      dateTo: null,
    })
  })

  it('resolves the orders-page presets against the reference date', () => {
    const cases: Record<string, { dateFrom: string | null; dateTo: string | null }> = {
      today: { dateFrom: '2026-03-18', dateTo: '2026-03-18' },
      yesterday: { dateFrom: '2026-03-17', dateTo: '2026-03-17' },
      this_week: { dateFrom: '2026-03-16', dateTo: '2026-03-22' },
      next_week: { dateFrom: '2026-03-23', dateTo: '2026-03-29' },
      last_month: { dateFrom: '2026-02-01', dateTo: '2026-02-28' },
      this_month: { dateFrom: '2026-03-01', dateTo: '2026-03-31' },
    }

    for (const [preset, expected] of Object.entries(cases)) {
      expect(resolveDatePresetRange(preset as DatePresetKey, {}, REFERENCE)).toEqual(expected)
    }
  })

  it('resolves the remaining presets against the reference date', () => {
    expect(resolveDatePresetRange('past_due_today', {}, REFERENCE)).toEqual({
      dateFrom: null,
      dateTo: '2026-03-18',
    })
    expect(resolveDatePresetRange('next_14_days', {}, REFERENCE)).toEqual({
      dateFrom: '2026-03-18',
      dateTo: '2026-04-01',
    })
    expect(resolveDatePresetRange('this_quarter', {}, REFERENCE)).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
    })
    expect(resolveDatePresetRange('this_year', {}, REFERENCE)).toEqual({
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
    })
  })

  it('runs weeks Monday → Sunday, whichever day of the week it is', () => {
    const monday = new Date(2026, 2, 16)
    const sunday = new Date(2026, 2, 22)
    const week = { dateFrom: '2026-03-16', dateTo: '2026-03-22' }

    expect(resolveDatePresetRange('this_week', {}, monday)).toEqual(week)
    expect(resolveDatePresetRange('this_week', {}, sunday)).toEqual(week)
    // Sunday still belongs to the week that started on the 16th, so "next week"
    // is the following Monday — not the next day.
    expect(resolveDatePresetRange('next_week', {}, sunday)).toEqual({
      dateFrom: '2026-03-23',
      dateTo: '2026-03-29',
    })
  })

  it('handles month-end and year-end rollovers', () => {
    // Mar 31 has no counterpart in February; last month must still be all of Feb.
    expect(resolveDatePresetRange('last_month', {}, new Date(2026, 2, 31))).toEqual({
      dateFrom: '2026-02-01',
      dateTo: '2026-02-28',
    })
    expect(resolveDatePresetRange('last_month', {}, new Date(2026, 0, 15))).toEqual({
      dateFrom: '2025-12-01',
      dateTo: '2025-12-31',
    })
    expect(resolveDatePresetRange('yesterday', {}, new Date(2026, 0, 1))).toEqual({
      dateFrom: '2025-12-31',
      dateTo: '2025-12-31',
    })
  })

  it('passes a bounded custom range straight through', () => {
    expect(
      resolveDatePresetRange('custom', { from: '2026-01-05', to: '2026-01-09' }, REFERENCE)
    ).toEqual({ dateFrom: '2026-01-05', dateTo: '2026-01-09' })
  })

  it('leaves the empty edge of a one-sided custom range unbounded', () => {
    expect(resolveDatePresetRange('custom', { from: '2026-01-05' }, REFERENCE)).toEqual({
      dateFrom: '2026-01-05',
      dateTo: null,
    })
    expect(resolveDatePresetRange('custom', { to: '2026-01-09' }, REFERENCE)).toEqual({
      dateFrom: null,
      dateTo: '2026-01-09',
    })
    expect(resolveDatePresetRange('custom', { from: '', to: '' }, REFERENCE)).toEqual({
      dateFrom: null,
      dateTo: null,
    })
    expect(resolveDatePresetRange('custom', {}, REFERENCE)).toEqual({
      dateFrom: null,
      dateTo: null,
    })
  })

  it('ignores custom dates for non-custom presets', () => {
    expect(
      resolveDatePresetRange('today', { from: '2020-01-01', to: '2020-12-31' }, REFERENCE)
    ).toEqual({ dateFrom: '2026-03-18', dateTo: '2026-03-18' })
  })
})

describe('isWithinDateRange', () => {
  const range = { dateFrom: '2026-03-10', dateTo: '2026-03-20' }

  it('includes both boundary dates for date-only values', () => {
    expect(isWithinDateRange('2026-03-10', range)).toBe(true)
    expect(isWithinDateRange('2026-03-20', range)).toBe(true)
    expect(isWithinDateRange('2026-03-15', range)).toBe(true)
  })

  it('excludes date-only values outside the range', () => {
    expect(isWithinDateRange('2026-03-09', range)).toBe(false)
    expect(isWithinDateRange('2026-03-21', range)).toBe(false)
  })

  it('includes timestamps anywhere on either boundary day', () => {
    expect(isWithinDateRange('2026-03-10T00:00:00', range)).toBe(true)
    expect(isWithinDateRange('2026-03-20T23:59:59', range)).toBe(true)
    expect(isWithinDateRange('2026-03-20T13:45:00', range)).toBe(true)
  })

  it('excludes timestamps that fall on a day outside the range', () => {
    expect(isWithinDateRange('2026-03-09T23:59:59', range)).toBe(false)
    expect(isWithinDateRange('2026-03-21T00:00:00', range)).toBe(false)
  })

  it('applies only the bounded edge of a one-sided range', () => {
    expect(isWithinDateRange('2026-01-01', { dateFrom: '2026-03-10', dateTo: null })).toBe(false)
    expect(isWithinDateRange('2026-12-31', { dateFrom: '2026-03-10', dateTo: null })).toBe(true)
    expect(isWithinDateRange('2026-01-01', { dateFrom: null, dateTo: '2026-03-20' })).toBe(true)
    expect(isWithinDateRange('2026-12-31', { dateFrom: null, dateTo: '2026-03-20' })).toBe(false)
  })

  it('keeps every row — including undated ones — when the range is unbounded', () => {
    const unbounded = { dateFrom: null, dateTo: null }
    expect(isWithinDateRange('2026-03-15', unbounded)).toBe(true)
    expect(isWithinDateRange(null, unbounded)).toBe(true)
    expect(isWithinDateRange(undefined, unbounded)).toBe(true)
    expect(isWithinDateRange('', unbounded)).toBe(true)
  })

  it('drops undated rows once the range is bounded', () => {
    expect(isWithinDateRange(null, range)).toBe(false)
    expect(isWithinDateRange(undefined, range)).toBe(false)
    expect(isWithinDateRange('', range)).toBe(false)
  })

  it('includes the last second of the end day for ISO timestamps', () => {
    // The per-page `dateTo + 'T23:59:59'` string comparison this replaced
    // dropped anything in the final second of the day.
    expect(isWithinDateRange('2026-03-20T23:59:59.999', range)).toBe(true)
  })

  it('reads "space" timestamps the way Postgres renders them', () => {
    expect(isWithinDateRange('2026-03-20 18:45:00', range)).toBe(true)
    expect(isWithinDateRange('2026-03-21 00:15:00', range)).toBe(false)
  })

  it('matches a single-day range against a timestamp on that day', () => {
    const singleDay = { dateFrom: '2026-03-18', dateTo: '2026-03-18' }
    expect(isWithinDateRange('2026-03-18T08:00:00', singleDay)).toBe(true)
    expect(isWithinDateRange('2026-03-17T23:00:00', singleDay)).toBe(false)
    expect(isWithinDateRange('2026-03-19T01:00:00', singleDay)).toBe(false)
  })

  it('matches the range a preset produces, end to end', () => {
    const thisWeek = resolveDatePresetRange('this_week', {}, REFERENCE)
    expect(isWithinDateRange('2026-03-16T00:00:00', thisWeek)).toBe(true)
    expect(isWithinDateRange('2026-03-22T23:59:00', thisWeek)).toBe(true)
    expect(isWithinDateRange('2026-03-23T00:00:00', thisWeek)).toBe(false)
  })
})

describe('parseDatePresetKey', () => {
  it('accepts a preset the page offers', () => {
    expect(parseDatePresetKey('this_week', ORDER_DATE_PRESETS, 'all')).toBe('this_week')
  })

  it('falls back for presets the page does not offer, junk, and missing values', () => {
    expect(parseDatePresetKey('next_14_days', ORDER_DATE_PRESETS, 'all')).toBe('all')
    expect(parseDatePresetKey('not-a-preset', ORDER_DATE_PRESETS, 'all')).toBe('all')
    expect(parseDatePresetKey(null, ORDER_DATE_PRESETS, 'all')).toBe('all')
    expect(parseDatePresetKey(undefined, ORDER_DATE_PRESETS, 'all')).toBe('all')
    expect(parseDatePresetKey('', ORDER_DATE_PRESETS, 'all')).toBe('all')
  })
})

describe('preset metadata', () => {
  it('labels every preset the orders page offers', () => {
    expect(ORDER_DATE_PRESETS.map((key) => DATE_PRESET_LABELS[key])).toEqual([
      'All Dates',
      'Today',
      'Yesterday',
      'This Week',
      'Next Week',
      'Last Month',
      'This Month',
      'Custom',
    ])
  })

  it('labels every preset offered by every page', () => {
    for (const [name, presets] of Object.entries(PAGE_PRESETS)) {
      for (const preset of presets) {
        expect(DATE_PRESET_LABELS[preset], `${name}/${preset}`).toBeTruthy()
      }
    }
  })

  it('offers Custom exactly once on every page', () => {
    for (const [name, presets] of Object.entries(PAGE_PRESETS)) {
      expect(presets, name).toContain('custom')
      expect(new Set(presets).size, name).toBe(presets.length)
    }
  })

  it('resolves every preset every page offers to a sane inclusive range', () => {
    const shape = /^\d{4}-\d{2}-\d{2}$/
    for (const [name, presets] of Object.entries(PAGE_PRESETS)) {
      for (const preset of presets) {
        const range = resolveDatePresetRange(
          preset,
          { from: '2026-01-05', to: '2026-01-09' },
          REFERENCE
        )
        for (const edge of [range.dateFrom, range.dateTo]) {
          expect(edge === null || shape.test(edge), `${name}/${preset}`).toBe(true)
        }
        if (range.dateFrom && range.dateTo) {
          expect(range.dateFrom <= range.dateTo, `${name}/${preset}`).toBe(true)
        }
      }
    }
  })

  it('keeps every period the My Commissions button row used to offer', () => {
    expect(MY_COMMISSION_DATE_PRESETS).toEqual([
      'all',
      'this_month',
      'last_month',
      'this_quarter',
      'this_year',
      'custom',
    ])
  })

  it('builds dropdown options in the given display order', () => {
    expect(datePresetOptions(['all', 'custom'])).toEqual([
      { value: 'all', label: 'All Dates' },
      { value: 'custom', label: 'Custom' },
    ])
  })

  it('formats today as a local yyyy-MM-dd string', () => {
    expect(todayDateString(REFERENCE)).toBe('2026-03-18')
  })

  it('uses local calendar days rather than UTC ones near midnight', () => {
    // 00:30 local on the 1st — a UTC-based formatter west of Greenwich would
    // report the previous day, and the previous month.
    expect(resolveDatePresetRange('today', {}, new Date(2026, 5, 1, 0, 30))).toEqual({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-01',
    })
    // 23:30 local on the last day of the month — a UTC-based formatter east of
    // Greenwich would roll into the next month.
    expect(resolveDatePresetRange('this_month', {}, new Date(2026, 5, 30, 23, 30))).toEqual({
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
    })
    expect(todayDateString(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01')
  })
})
