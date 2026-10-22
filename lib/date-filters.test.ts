import { describe, expect, it } from 'vitest'
import {
  CULTIVATION_TASK_DATE_PRESETS,
  DATE_PRESET_LABELS,
  ORDER_DATE_PRESETS,
  TRIM_REPORT_DATE_PRESETS,
  datePresetOptions,
  resolveDatePresetRange,
  type DatePresetKey,
} from './date-filters'

// Wednesday 2026-10-21, noon local, so the device zone cannot move it across a day boundary.
const REF = new Date(2026, 9, 21, 12, 0, 0)

describe('resolveDatePresetRange: rolling windows', () => {
  it('last_7_days is today-6 … today, inclusive (7 calendar days)', () => {
    expect(resolveDatePresetRange('last_7_days', {}, REF)).toEqual({ dateFrom: '2026-10-15', dateTo: '2026-10-21' })
  })

  it('last_30_days is today-29 … today, inclusive (30 calendar days)', () => {
    expect(resolveDatePresetRange('last_30_days', {}, REF)).toEqual({ dateFrom: '2026-09-22', dateTo: '2026-10-21' })
  })

  it('crosses month and year boundaries', () => {
    const newYear = new Date(2027, 0, 3, 12)
    expect(resolveDatePresetRange('last_7_days', {}, newYear)).toEqual({ dateFrom: '2026-12-28', dateTo: '2027-01-03' })
    expect(resolveDatePresetRange('last_30_days', {}, newYear)).toEqual({ dateFrom: '2026-12-05', dateTo: '2027-01-03' })
  })

  it('counts a leap day', () => {
    expect(resolveDatePresetRange('last_7_days', {}, new Date(2028, 2, 2, 12))).toEqual({
      dateFrom: '2028-02-25',
      dateTo: '2028-03-02',
    })
  })

  it('both labels exist', () => {
    expect(DATE_PRESET_LABELS.last_7_days).toBe('Last 7 Days')
    expect(DATE_PRESET_LABELS.last_30_days).toBe('Last 30 Days')
  })
})

describe('resolveDatePresetRange: existing keys are unchanged', () => {
  it.each<[DatePresetKey, { dateFrom: string | null; dateTo: string | null }]>([
    ['all', { dateFrom: null, dateTo: null }],
    ['past_due_today', { dateFrom: null, dateTo: '2026-10-21' }],
    ['today', { dateFrom: '2026-10-21', dateTo: '2026-10-21' }],
    ['yesterday', { dateFrom: '2026-10-20', dateTo: '2026-10-20' }],
    ['this_week', { dateFrom: '2026-10-19', dateTo: '2026-10-25' }],
    ['next_week', { dateFrom: '2026-10-26', dateTo: '2026-11-01' }],
    ['next_14_days', { dateFrom: '2026-10-21', dateTo: '2026-11-04' }],
    ['this_month', { dateFrom: '2026-10-01', dateTo: '2026-10-31' }],
    ['last_month', { dateFrom: '2026-09-01', dateTo: '2026-09-30' }],
  ])('%s', (key, expected) => {
    expect(resolveDatePresetRange(key, {}, REF)).toEqual(expected)
  })

  it('custom passes the entered dates through, and is unbounded when empty', () => {
    expect(resolveDatePresetRange('custom', { from: '2026-01-02', to: '2026-01-09' }, REF)).toEqual({
      dateFrom: '2026-01-02',
      dateTo: '2026-01-09',
    })
    expect(resolveDatePresetRange('custom', {}, REF)).toEqual({ dateFrom: null, dateTo: null })
  })
})

describe('preset lists', () => {
  it('orders and cultivation tasks do not offer the new rolling windows', () => {
    for (const list of [ORDER_DATE_PRESETS, CULTIVATION_TASK_DATE_PRESETS]) {
      expect(list).not.toContain('last_7_days')
      expect(list).not.toContain('last_30_days')
    }
  })

  it('orders and cultivation tasks keep exactly their previous dropdowns', () => {
    expect(ORDER_DATE_PRESETS).toEqual(['all', 'today', 'yesterday', 'this_week', 'next_week', 'last_month', 'this_month', 'custom'])
    expect(CULTIVATION_TASK_DATE_PRESETS).toEqual([
      'past_due_today',
      'today',
      'yesterday',
      'this_week',
      'next_week',
      'next_14_days',
      'custom',
    ])
  })

  it('trim reports: historical presets only, in display order, ending in custom', () => {
    expect(TRIM_REPORT_DATE_PRESETS).toEqual([
      'today',
      'yesterday',
      'last_7_days',
      'last_30_days',
      'this_week',
      'this_month',
      'last_month',
      'custom',
    ])
  })

  it('trim reports: nothing forward-looking and nothing unbounded', () => {
    for (const banned of ['next_week', 'next_14_days', 'past_due_today', 'all'] as DatePresetKey[]) {
      expect(TRIM_REPORT_DATE_PRESETS).not.toContain(banned)
    }
  })

  it('every non-custom trim preset resolves to a bounded range', () => {
    for (const key of TRIM_REPORT_DATE_PRESETS.filter((k) => k !== 'custom')) {
      const r = resolveDatePresetRange(key, {}, REF)
      expect(r.dateFrom, key).not.toBeNull()
      expect(r.dateTo, key).not.toBeNull()
    }
  })

  it('every preset offered anywhere has a label', () => {
    const labels = datePresetOptions([...ORDER_DATE_PRESETS, ...CULTIVATION_TASK_DATE_PRESETS, ...TRIM_REPORT_DATE_PRESETS])
    for (const o of labels) expect(o.label, o.value).toBeTruthy()
  })
})
