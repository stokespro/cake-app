// One definition of "a day" for Harvest & Trim reports: a calendar day in America/Chicago.
//
// The crew works in Oklahoma. A return at 7:30pm CDT is 00:30Z the NEXT UTC day, so slicing days on UTC
// boundaries (`${date}T00:00:00Z`) credits an evening's work to tomorrow. Every report that takes a
// YYYY-MM-DD range converts it here, so the staff page, the reports page and the actions all agree.
//
// Pure: no I/O, no dependencies beyond Intl (no date-fns-tz). Safe in client components, 'use server'
// action files and tests.

export const TRIM_TIME_ZONE = 'America/Chicago'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-30 and the like). */
export function isValidDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** Calendar arithmetic on a YYYY-MM-DD string (time zone free). Assumes `day` is valid. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** Whole calendar days from `from` to `to` (to - from). Assumes both are valid. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TRIM_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** Milliseconds the zone is ahead of UTC at `utcMs` (negative for Chicago: -5h CDT, -6h CST). */
function offsetMs(utcMs: number): number {
  const p: Record<string, number> = {}
  for (const part of partsFormat.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asIfUtc - Math.floor(utcMs / 1000) * 1000
}

/**
 * The UTC instant at which the Chicago wall clock reads 00:00 on `day`. Two passes because the offset
 * has to be looked up at the answer, not at the guess (matters only on the transition day itself;
 * Chicago changes at 2am so local midnight always exists exactly once).
 */
function chicagoMidnightMs(day: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`)
  const first = guess - offsetMs(guess)
  return guess - offsetMs(first)
}

export interface UtcDayRange {
  /** Inclusive lower bound: local midnight at the start of `from`, as a UTC ISO instant. */
  fromIso: string
  /** Exclusive upper bound: local midnight at the START of the day after `to`. */
  toExclusiveIso: string
}

/**
 * An inclusive local-day range [from, to] as half-open UTC instants [fromIso, toExclusiveIso).
 * Null when either date is invalid or `to` is before `from`. A day is 23h on spring-forward and 25h on
 * fall-back, which is why the upper bound is the next local midnight rather than from + 24h.
 */
export function chicagoDayRangeToUtc(from: string, to: string): UtcDayRange | null {
  if (!isValidDay(from) || !isValidDay(to) || to < from) return null
  return {
    fromIso: new Date(chicagoMidnightMs(from)).toISOString(),
    toExclusiveIso: new Date(chicagoMidnightMs(addDays(to, 1))).toISOString(),
  }
}

/** Today's date in America/Chicago as YYYY-MM-DD (en-CA formats ISO natively). */
export function chicagoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TRIM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TRIM_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
})
const dateClockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TRIM_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/**
 * An instant as Chicago wall-clock text: "2:05 PM", or "Oct 21, 2:05 PM" with `withDate`. Reports show
 * times in the same zone their day boundaries are drawn in, whatever the viewer's device says.
 */
export function chicagoClockText(iso: string | null | undefined, withDate = false): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return (withDate ? dateClockFormat : clockFormat).format(d).replace(/\u202f/g, ' ')
}
