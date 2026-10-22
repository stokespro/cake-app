import { afterEach, describe, expect, it } from 'vitest'
import { resolveDatePresetRange } from '@/lib/date-filters'
import {
  chicagoReferenceDate,
  readTrimReportFilters,
  resolveTrimReportRange,
  trimReportFiltersToQuery,
} from './report-presets'

const originalTz = process.env.TZ
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

/** Run `fn` with the process (i.e. "the device") in `tz`. Node re-reads TZ on assignment. */
function inZone<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz
  return fn()
}

const q = (s: string) => new URLSearchParams(s)

// 2026-10-22T03:30Z is 22:30 on Oct 21 in Chicago (CDT) but already Oct 22 in UTC and everywhere east of it.
const LATE_EVENING_CHICAGO = new Date('2026-10-22T03:30:00Z')
// 2026-10-22T06:00Z is 01:00 on Oct 22 in Chicago but still Oct 21 (20:00) in Honolulu.
const EARLY_MORNING_CHICAGO = new Date('2026-10-22T06:00:00Z')

const ZONES = ['America/Chicago', 'UTC', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Pacific/Honolulu', 'Asia/Kolkata', 'Europe/London']

describe('the device-zone problem this module exists to solve', () => {
  it('the raw shared resolver DOES disagree with Chicago on a non-Chicago device', () => {
    // Guards the tests below: if this ever stopped diverging they would prove nothing.
    inZone('UTC', () => {
      expect(resolveDatePresetRange('today', {}, LATE_EVENING_CHICAGO).dateFrom).toBe('2026-10-22')
    })
    inZone('Pacific/Honolulu', () => {
      expect(resolveDatePresetRange('today', {}, EARLY_MORNING_CHICAGO).dateFrom).toBe('2026-10-21')
    })
  })
})

describe.each(ZONES)('presets resolve against Chicago from a device in %s', (tz) => {
  it('today is Chicago’s day late in the evening there', () => {
    inZone(tz, () => {
      expect(resolveTrimReportRange({ preset: 'today', customFrom: '', customTo: '' }, LATE_EVENING_CHICAGO)).toEqual({
        from: '2026-10-21',
        to: '2026-10-21',
      })
    })
  })

  it('today is Chicago’s day early in the morning there', () => {
    inZone(tz, () => {
      expect(resolveTrimReportRange({ preset: 'today', customFrom: '', customTo: '' }, EARLY_MORNING_CHICAGO)).toEqual({
        from: '2026-10-22',
        to: '2026-10-22',
      })
    })
  })

  it('every preset is anchored on Chicago’s date', () => {
    inZone(tz, () => {
      const r = (preset: Parameters<typeof resolveTrimReportRange>[0]['preset']) =>
        resolveTrimReportRange({ preset, customFrom: '', customTo: '' }, LATE_EVENING_CHICAGO)
      // Chicago's today is Wednesday 2026-10-21.
      expect(r('yesterday')).toEqual({ from: '2026-10-20', to: '2026-10-20' })
      expect(r('last_7_days')).toEqual({ from: '2026-10-15', to: '2026-10-21' })
      expect(r('last_30_days')).toEqual({ from: '2026-09-22', to: '2026-10-21' })
      expect(r('this_week')).toEqual({ from: '2026-10-19', to: '2026-10-25' })
      expect(r('this_month')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
      expect(r('last_month')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    })
  })

  it('the week and month roll on Chicago midnight, not the device’s', () => {
    inZone(tz, () => {
      // Sunday 2026-11-01 22:30 CST in Chicago is Monday Nov 2 04:30Z: still the week of Oct 26, already November.
      const sundayNight = new Date('2026-11-02T04:30:00Z')
      expect(resolveTrimReportRange({ preset: 'this_week', customFrom: '', customTo: '' }, sundayNight)).toEqual({
        from: '2026-10-26',
        to: '2026-11-01',
      })
      expect(resolveTrimReportRange({ preset: 'this_month', customFrom: '', customTo: '' }, sundayNight)).toEqual({
        from: '2026-11-01',
        to: '2026-11-30',
      })
    })
  })

  it('chicagoReferenceDate has Chicago’s Y/M/D as its LOCAL calendar day', () => {
    inZone(tz, () => {
      const d = chicagoReferenceDate(LATE_EVENING_CHICAGO)
      expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 10, 21])
    })
  })
})

describe('custom ranges', () => {
  const now = LATE_EVENING_CHICAGO

  it('pass through unchanged, whatever the device zone', () => {
    for (const tz of ZONES) {
      inZone(tz, () => {
        expect(resolveTrimReportRange({ preset: 'custom', customFrom: '2026-10-01', customTo: '2026-10-09' }, now)).toEqual({
          from: '2026-10-01',
          to: '2026-10-09',
        })
      })
    }
  })

  it('fall back to Chicago today when empty or invalid, and never invert', () => {
    expect(resolveTrimReportRange({ preset: 'custom', customFrom: '', customTo: '' }, now)).toEqual({ from: '2026-10-21', to: '2026-10-21' })
    expect(resolveTrimReportRange({ preset: 'custom', customFrom: 'nope', customTo: '2026-10-05' }, now)).toEqual({ from: '2026-10-05', to: '2026-10-05' })
    expect(resolveTrimReportRange({ preset: 'custom', customFrom: '2026-10-09', customTo: '2026-10-01' }, now)).toEqual({ from: '2026-10-09', to: '2026-10-09' })
  })
})

describe('readTrimReportFilters', () => {
  const now = LATE_EVENING_CHICAGO

  it('the bare URL is today with no trimmer or batch', () => {
    expect(readTrimReportFilters(q(''), now)).toEqual({ preset: 'today', customFrom: '', customTo: '', trimmer: null, batch: null })
  })

  it('reads a preset, trimmer and batch', () => {
    expect(readTrimReportFilters(q('preset=last_7_days&trimmer=t1&batch=b1'), now)).toEqual({
      preset: 'last_7_days',
      customFrom: '',
      customTo: '',
      trimmer: 't1',
      batch: 'b1',
    })
  })

  it('reads a custom range', () => {
    expect(readTrimReportFilters(q('preset=custom&from=2026-10-01&to=2026-10-09'), now)).toMatchObject({
      preset: 'custom',
      customFrom: '2026-10-01',
      customTo: '2026-10-09',
    })
  })

  it('a preset carries no dates: stray from/to are ignored', () => {
    expect(readTrimReportFilters(q('preset=yesterday&from=2026-10-01&to=2026-10-09'), now)).toMatchObject({
      preset: 'yesterday',
      customFrom: '',
      customTo: '',
    })
  })

  it('a pre-dropdown link (from/to, no preset) is a custom range', () => {
    expect(readTrimReportFilters(q('from=2026-10-01&to=2026-10-09&trimmer=t1'), now)).toMatchObject({
      preset: 'custom',
      customFrom: '2026-10-01',
      customTo: '2026-10-09',
      trimmer: 't1',
    })
    expect(readTrimReportFilters(q('from=2026-10-05'), now)).toMatchObject({ preset: 'custom', customFrom: '2026-10-05', customTo: '2026-10-05' })
  })

  it('unknown or non-trim presets fall back to today (all / next_week are not offered)', () => {
    for (const bad of ['all', 'next_week', 'past_due_today', 'bogus', '']) {
      expect(readTrimReportFilters(q(`preset=${bad}`), now).preset).toBe('today')
    }
  })

  it('custom with no usable dates seeds Chicago today; an inverted range is corrected', () => {
    expect(readTrimReportFilters(q('preset=custom'), now)).toMatchObject({ customFrom: '2026-10-21', customTo: '2026-10-21' })
    expect(readTrimReportFilters(q('preset=custom&from=2026-10-09&to=2026-10-01'), now)).toMatchObject({
      customFrom: '2026-10-09',
      customTo: '2026-10-09',
    })
  })
})

describe('trimReportFiltersToQuery', () => {
  const base = { preset: 'today' as const, customFrom: '', customTo: '', trimmer: null, batch: null }

  it('the default is the bare URL', () => {
    expect(trimReportFiltersToQuery(base)).toBe('')
  })

  it('carries the preset key, batch and trimmer', () => {
    expect(trimReportFiltersToQuery({ ...base, preset: 'last_30_days', trimmer: 't1', batch: 'b1' })).toBe('?preset=last_30_days&trimmer=t1&batch=b1')
  })

  it('carries from/to only for custom', () => {
    expect(trimReportFiltersToQuery({ ...base, preset: 'custom', customFrom: '2026-10-01', customTo: '2026-10-09' })).toBe(
      '?preset=custom&from=2026-10-01&to=2026-10-09'
    )
    expect(trimReportFiltersToQuery({ ...base, preset: 'yesterday', customFrom: '2026-10-01', customTo: '2026-10-09' })).toBe('?preset=yesterday')
  })

  it('round-trips through readTrimReportFilters', () => {
    const now = LATE_EVENING_CHICAGO
    const f = { preset: 'custom' as const, customFrom: '2026-10-01', customTo: '2026-10-09', trimmer: 't1', batch: 'b1' }
    expect(readTrimReportFilters(q(trimReportFiltersToQuery(f).slice(1)), now)).toEqual(f)
    const g = { ...base, preset: 'this_month' as const, batch: 'b1' }
    expect(readTrimReportFilters(q(trimReportFiltersToQuery(g).slice(1)), now)).toEqual(g)
  })
})
