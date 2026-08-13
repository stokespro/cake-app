import {
  addDays,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
} from 'date-fns'
import { parseLocalDate } from '@/lib/utils'

/**
 * Shared date-preset filtering used by list pages (orders, cultivation tasks, …).
 *
 * The preset union is the superset of every preset any list page offers; each
 * page picks the subset it wants (see ORDER_DATE_PRESETS /
 * CULTIVATION_TASK_DATE_PRESETS) and passes it to <DatePresetFilter>. Ranges are
 * always resolved to inclusive `yyyy-MM-dd` local-date strings (or null for an
 * unbounded edge) so they can be handed straight to a Supabase gte/lte filter or
 * compared client-side without timezone drift.
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

/** Weeks run Monday → Sunday everywhere in the app. */
const WEEK_OPTIONS = { weekStartsOn: 1 } as const

const toDateString = (date: Date) => format(date, 'yyyy-MM-dd')

/** Today as a `yyyy-MM-dd` local-date string — handy for seeding custom inputs. */
export function todayDateString(referenceDate: Date = new Date()): string {
  return toDateString(referenceDate)
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
