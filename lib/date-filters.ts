import {
  addDays,
  addWeeks,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  endOfYear,
  format,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
} from 'date-fns'
import { parseLocalDate } from '@/lib/utils'

/**
 * Shared date-preset filtering used by every date-filtered list page (orders,
 * cultivation tasks, dispensaries, commissions, my commissions, compliance log).
 *
 * The preset union is the superset of every preset any list page offers; each
 * page picks the subset it wants (see the *_DATE_PRESETS arrays below) and
 * passes it to <DatePresetFilter>. Ranges are always resolved to inclusive
 * `yyyy-MM-dd` local-date strings (or null for an unbounded edge) so they can be
 * handed straight to a Supabase gte/lte filter or compared client-side without
 * timezone drift.
 */
export type DatePresetKey =
  | 'all'
  | 'past_due_today'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'next_week'
  | 'next_14_days'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  // `*_to_date` variants stop at today instead of running to the end of the
  // period. They exist because My Commissions has always shown quarter- and
  // year-to-date figures, so its ranges must never reach into the future.
  | 'quarter_to_date'
  | 'year_to_date'
  | 'custom'

/** Inclusive range. `null` on either edge means unbounded in that direction. */
export interface DateFilterRange {
  dateFrom: string | null
  dateTo: string | null
}

/** Custom (user-entered) range, as the raw `yyyy-MM-dd` strings from date inputs. */
export interface CustomDateRange {
  from?: string
  to?: string
}

export const DATE_PRESET_LABELS: Record<DatePresetKey, string> = {
  all: 'All Dates',
  past_due_today: 'Past Due & Today',
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This Week',
  next_week: 'Next Week',
  next_14_days: 'Next 14 Days',
  this_month: 'This Month',
  last_month: 'Last Month',
  this_quarter: 'This Quarter',
  this_year: 'This Year',
  // Same user-facing wording as the full-period variants: a page offers one or
  // the other, never both, and "This Quarter" is what the replaced My
  // Commissions button said.
  quarter_to_date: 'This Quarter',
  year_to_date: 'This Year',
  custom: 'Custom',
}

/** Orders page (SPRO-119) dropdown, in display order. */
export const ORDER_DATE_PRESETS: DatePresetKey[] = [
  'all',
  'today',
  'yesterday',
  'this_week',
  'next_week',
  'last_month',
  'this_month',
  'custom',
]

/** Cultivation tasks page dropdown, in display order. */
export const CULTIVATION_TASK_DATE_PRESETS: DatePresetKey[] = [
  'past_due_today',
  'today',
  'yesterday',
  'this_week',
  'next_week',
  'next_14_days',
  'custom',
]

/**
 * Dispensaries page dropdown (filters on order history), in display order.
 * Backward-looking only — a dispensary's order history never lies in the future.
 */
export const DISPENSARY_DATE_PRESETS: DatePresetKey[] = [
  'all',
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'custom',
]

/** Commission reports page dropdown (filters on order date), in display order. */
export const COMMISSION_DATE_PRESETS: DatePresetKey[] = [
  'all',
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'custom',
]

/**
 * My Commissions page dropdown, in display order. Mirrors the period buttons it
 * replaced (this month / last month / this quarter / this year / all time) plus
 * the shared Custom option.
 *
 * Quarter and year use the `*_to_date` keys because the buttons they replaced
 * ran from the start of the quarter/year to *today*, never to the end of the
 * period — commissions come from orders, whose order_date can be future-dated,
 * so a full-period end date would pull unearned future orders into the totals.
 */
export const MY_COMMISSION_DATE_PRESETS: DatePresetKey[] = [
  'all',
  'this_month',
  'last_month',
  'quarter_to_date',
  'year_to_date',
  'custom',
]

/** Compliance log page dropdown (filters on event date), in display order. */
export const COMPLIANCE_DATE_PRESETS: DatePresetKey[] = [
  'all',
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'last_month',
  'custom',
]

/** Weeks run Monday → Sunday everywhere in the app. */
const WEEK_OPTIONS = { weekStartsOn: 1 } as const

const toDateString = (date: Date) => format(date, 'yyyy-MM-dd')

/** Today as a `yyyy-MM-dd` local-date string — handy for seeding custom inputs. */
export function todayDateString(referenceDate: Date = new Date()): string {
  return toDateString(referenceDate)
}

/**
 * Narrows an untrusted string (URL param, persisted state) to one of `presets`,
 * falling back to `fallback` when it isn't an offered preset.
 */
export function parseDatePresetKey(
  value: string | null | undefined,
  presets: DatePresetKey[],
  fallback: DatePresetKey
): DatePresetKey {
  return presets.includes(value as DatePresetKey) ? (value as DatePresetKey) : fallback
}

export function datePresetOptions(
  presets: DatePresetKey[]
): { value: DatePresetKey; label: string }[] {
  return presets.map((value) => ({ value, label: DATE_PRESET_LABELS[value] }))
}

/**
 * Resolves a preset (or the user's custom dates) to an inclusive
 * `yyyy-MM-dd` window. `referenceDate` is injectable for testing.
 */
export function resolveDatePresetRange(
  preset: DatePresetKey,
  custom: CustomDateRange = {},
  referenceDate: Date = new Date()
): DateFilterRange {
  const today = referenceDate
  const todayStr = toDateString(today)

  switch (preset) {
    case 'today':
      return { dateFrom: todayStr, dateTo: todayStr }
    case 'yesterday': {
      const yesterdayStr = toDateString(subDays(today, 1))
      return { dateFrom: yesterdayStr, dateTo: yesterdayStr }
    }
    case 'this_week':
      return {
        dateFrom: toDateString(startOfWeek(today, WEEK_OPTIONS)),
        dateTo: toDateString(endOfWeek(today, WEEK_OPTIONS)),
      }
    case 'next_week': {
      const nextWeek = addWeeks(today, 1)
      return {
        dateFrom: toDateString(startOfWeek(nextWeek, WEEK_OPTIONS)),
        dateTo: toDateString(endOfWeek(nextWeek, WEEK_OPTIONS)),
      }
    }
    case 'next_14_days':
      return { dateFrom: todayStr, dateTo: toDateString(addDays(today, 14)) }
    case 'this_month':
      return {
        dateFrom: toDateString(startOfMonth(today)),
        dateTo: toDateString(endOfMonth(today)),
      }
    case 'last_month': {
      const lastMonth = subMonths(today, 1)
      return {
        dateFrom: toDateString(startOfMonth(lastMonth)),
        dateTo: toDateString(endOfMonth(lastMonth)),
      }
    }
    // Whole calendar quarter/year, including days still to come. Only offered on
    // pages whose rows are backward-looking (dispensary order history,
    // commission reports), where the trailing edge can't match anything yet.
    case 'this_quarter':
      return {
        dateFrom: toDateString(startOfQuarter(today)),
        dateTo: toDateString(endOfQuarter(today)),
      }
    case 'this_year':
      return {
        dateFrom: toDateString(startOfYear(today)),
        dateTo: toDateString(endOfYear(today)),
      }
    // Start of the quarter/year through today — future dates stay excluded.
    case 'quarter_to_date':
      return { dateFrom: toDateString(startOfQuarter(today)), dateTo: todayStr }
    case 'year_to_date':
      return { dateFrom: toDateString(startOfYear(today)), dateTo: todayStr }
    case 'custom':
      return { dateFrom: custom.from || null, dateTo: custom.to || null }
    case 'past_due_today':
      // Unbounded start so overdue rows always show, regardless of age.
      return { dateFrom: null, dateTo: todayStr }
    case 'all':
    default:
      return { dateFrom: null, dateTo: null }
  }
}

/**
 * True when `value` (a date-only string or an ISO timestamp) falls inside the
 * inclusive range. Rows with no date are excluded whenever the range is bounded,
 * matching the previous orders-page behaviour. Comparison happens on local
 * `yyyy-MM-dd` strings so a timestamp never lands on the wrong side of midnight.
 */
export function isWithinDateRange(
  value: string | null | undefined,
  range: DateFilterRange
): boolean {
  if (!range.dateFrom && !range.dateTo) return true
  if (!value) return false

  const day = toDateString(parseLocalDate(value))
  if (range.dateFrom && day < range.dateFrom) return false
  if (range.dateTo && day > range.dateTo) return false
  return true
}
