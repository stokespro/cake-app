// Date presets and URL state for the Harvest & Trim reports page, anchored to America/Chicago.
//
// lib/date-filters.ts resolves presets with date-fns, i.e. against the DEVICE's clock and zone. The report
// action reads the resulting YYYY-MM-DD strings as America/Chicago days (lib/trim/day-range.ts). On a
// Chicago device the two agree; on any other they diverge and "Today" silently means the wrong day. So the
// trim page never hands the resolver a raw `new Date()`: it hands it a reference date whose LOCAL calendar
// day is Chicago's current day, and everything downstream (labels, keys, shared <DatePresetFilter>)
// stays the shared code. Orders and cultivation tasks keep their device-local behaviour untouched.
//
// Pure: safe in client components and tests.

import {
  TRIM_REPORT_DATE_PRESETS,
  resolveDatePresetRange,
  type DatePresetKey,
} from '@/lib/date-filters'
import { chicagoToday, isValidDay } from './day-range'

/**
 * A Date whose local calendar day (in whatever zone the device is in) is Chicago's current day. Noon, so
 * no device DST shift can move it across midnight. Meaningful ONLY for reading its local Y/M/D, which is
 * exactly what the date-fns based resolver does.
 */
export function chicagoReferenceDate(now: Date = new Date()): Date {
  const [y, m, d] = chicagoToday(now).split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

export interface TrimReportFilters {
  preset: DatePresetKey
  /** Only meaningful when preset === 'custom'; empty strings otherwise. */
  customFrom: string
  customTo: string
  trimmer: string | null
  batch: string | null
}

/** The inclusive Chicago-day range a filter selection means right now. Always bounded. */
export function resolveTrimReportRange(
  f: Pick<TrimReportFilters, 'preset' | 'customFrom' | 'customTo'>,
  now: Date = new Date()
): { from: string; to: string } {
  const today = chicagoToday(now)
  if (f.preset === 'custom') {
    const from = isValidDay(f.customFrom) ? f.customFrom : isValidDay(f.customTo) ? f.customTo : today
    const to = isValidDay(f.customTo) && f.customTo >= from ? f.customTo : from
    return { from, to }
  }
  const { dateFrom, dateTo } = resolveDatePresetRange(f.preset, {}, chicagoReferenceDate(now))
  return { from: dateFrom ?? today, to: dateTo ?? today }
}

function isTrimPreset(v: unknown): v is DatePresetKey {
  return typeof v === 'string' && (TRIM_REPORT_DATE_PRESETS as string[]).includes(v)
}

/**
 * URL -> filters. `?preset=` carries the preset key; `?from=&to=` ride along for 'custom'. A link with
 * from/to but no (valid) preset predates the preset dropdown and is read as a custom range. Anything
 * unrecognised falls back to today.
 */
export function readTrimReportFilters(sp: URLSearchParams, now: Date = new Date()): TrimReportFilters {
  const today = chicagoToday(now)
  const rawFrom = sp.get('from')
  const rawTo = sp.get('to')
  const hasDates = isValidDay(rawFrom) || isValidDay(rawTo)
  const rawPreset = sp.get('preset')

  let preset: DatePresetKey = 'today'
  if (isTrimPreset(rawPreset)) preset = rawPreset
  else if (hasDates) preset = 'custom'

  let customFrom = ''
  let customTo = ''
  if (preset === 'custom') {
    customFrom = isValidDay(rawFrom) ? rawFrom : isValidDay(rawTo) ? rawTo : today
    customTo = isValidDay(rawTo) ? rawTo : customFrom
    if (customTo < customFrom) customTo = customFrom
  }
  return { preset, customFrom, customTo, trimmer: sp.get('trimmer') || null, batch: sp.get('batch') || null }
}

/** Filters -> `?query` (or ''). The default (today, no trimmer, no batch) is the bare URL. */
export function trimReportFiltersToQuery(f: TrimReportFilters): string {
  const q = new URLSearchParams()
  if (f.preset !== 'today') q.set('preset', f.preset)
  if (f.preset === 'custom') {
    q.set('from', f.customFrom)
    q.set('to', f.customTo)
  }
  if (f.trimmer) q.set('trimmer', f.trimmer)
  if (f.batch) q.set('batch', f.batch)
  const s = q.toString()
  return s ? `?${s}` : ''
}

/**
 * The page's default filters: today (Chicago), every batch, every trimmer. There is no "all dates" option on
 * this page, so "cleared" means today, not unbounded. It serialises to the bare URL.
 */
export const DEFAULT_TRIM_REPORT_FILTERS: TrimReportFilters = {
  preset: 'today',
  customFrom: '',
  customTo: '',
  trimmer: null,
  batch: null,
}

/**
 * True when anything differs from the default, i.e. when "Clear Filters" has something to do. Display
 * preferences (the column choice) are not filters and are not part of this.
 */
export function hasActiveTrimFilters(f: Pick<TrimReportFilters, 'preset' | 'trimmer' | 'batch'>): boolean {
  return f.preset !== DEFAULT_TRIM_REPORT_FILTERS.preset || f.trimmer !== null || f.batch !== null
}
