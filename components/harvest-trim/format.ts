// Display helpers for the Harvest & Trim screens. Pure: no I/O, safe anywhere.
//
// Weights are stored in grams; the floor thinks in pounds. Everything shown to
// a person leads with pounds and keeps grams alongside so a figure can always
// be checked against either scale.

import { format, formatDistanceToNowStrict } from 'date-fns'
import { gramsToLb } from '@/lib/units'
import { parseLocalDate } from '@/lib/utils'
import type { HangerLoadStatus, HangerStatus } from '@/types/harvest-trim'

const EM_DASH = '—'

export function lbText(g: number | null | undefined, dp = 2): string {
  if (g === null || g === undefined || !Number.isFinite(g)) return EM_DASH
  return `${gramsToLb(g).toFixed(dp)} lb`
}

export function gramsText(g: number | null | undefined): string {
  if (g === null || g === undefined || !Number.isFinite(g)) return EM_DASH
  return `${g.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} g`
}

/** "3.82 lb (1,733 g)" */
export function massText(g: number | null | undefined): string {
  if (g === null || g === undefined || !Number.isFinite(g)) return EM_DASH
  return `${lbText(g)} (${gramsText(g)})`
}

/** Signed grams, e.g. "-419 g" / "+12.5 g". */
export function signedGramsText(g: number | null | undefined): string {
  if (g === null || g === undefined || !Number.isFinite(g)) return EM_DASH
  const sign = g > 0 ? '+' : g < 0 ? '-' : ''
  return `${sign}${gramsText(Math.abs(g))}`
}

export function pctText(p: number | null | undefined, dp = 1, signed = false): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return EM_DASH
  const sign = signed && p > 0 ? '+' : p < 0 ? '-' : ''
  return `${sign}${Math.abs(p).toFixed(dp)}%`
}

export function whenText(iso: string | null | undefined): string {
  if (!iso) return EM_DASH
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? EM_DASH : format(d, 'MMM d, h:mm a')
}

export function agoText(iso: string | null | undefined): string {
  if (!iso) return EM_DASH
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? EM_DASH : `${formatDistanceToNowStrict(d)} ago`
}

/** 'yyyy-MM-dd' (a calendar date, not an instant) -> "Oct 1, 2026". */
export function dateOnlyText(date: string | null | undefined): string {
  if (!date) return EM_DASH
  const d = parseLocalDate(date)
  return Number.isNaN(d.getTime()) ? EM_DASH : format(d, 'MMM d, yyyy')
}

export function hoursText(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return EM_DASH
  if (h < 1) return `${Math.round(h * 60)} min`
  return `${h.toFixed(1)} h`
}

export function plantsText(n: number | null | undefined): string {
  if (n === null || n === undefined) return EM_DASH
  return `${n} ${n === 1 ? 'plant' : 'plants'}`
}

export function trimmerName(s: { fullName: string; displayName: string | null }): string {
  return s.displayName?.trim() || s.fullName
}

export function moneyText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

// ─── Status vocabulary ───────────────────────────────────────────────────────

export interface LoadStatusMeta {
  /** Plain words for a status line. */
  label: string
  /** One line saying what happens next. */
  hint: string
  /** Pill classes (border + bg + text), readable in light and dark. */
  pill: string
  /** Solid dot / bar colour. */
  solid: string
}

export const LOAD_STATUS_META: Record<HangerLoadStatus, LoadStatusMeta> = {
  hung: {
    label: 'Hung (wet)',
    hint: 'Waiting to be dried and weighed.',
    pill: 'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300',
    solid: 'bg-sky-500',
  },
  dried: {
    label: 'Dried, ready to issue',
    hint: 'Dry weight is recorded. Ready to hand to a trimmer.',
    pill: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    solid: 'bg-emerald-500',
  },
  checked_out: {
    label: 'Checked out',
    hint: 'A trimmer is working on it.',
    pill: 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300',
    solid: 'bg-amber-500',
  },
  partial: {
    label: 'Unfinished, plants left',
    hint: 'Came back with plants still on it. Ready to reissue.',
    pill: 'border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300',
    solid: 'bg-violet-500',
  },
  returned: {
    label: 'Flagged, needs a decision',
    hint: 'The weights did not add up. It cannot be reissued until resolved.',
    pill: 'border-red-500/50 bg-red-500/15 text-red-700 dark:text-red-300',
    solid: 'bg-red-500',
  },
  reconciled: {
    label: 'Finished',
    hint: 'Trimmed and reconciled.',
    pill: 'border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-300',
    solid: 'bg-green-600',
  },
  void: {
    label: 'Void',
    hint: 'Cancelled. Excluded from every total.',
    pill: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
    solid: 'bg-zinc-500',
  },
}

export const LOAD_STATUS_ORDER: HangerLoadStatus[] = [
  'hung',
  'dried',
  'checked_out',
  'partial',
  'returned',
  'reconciled',
  'void',
]

export const HANGER_STATUS_META: Record<HangerStatus, { label: string; pill: string }> = {
  active: {
    label: 'Active',
    pill: 'border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-300',
  },
  retired: {
    label: 'Retired',
    pill: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
  },
  lost: {
    label: 'Lost',
    pill: 'border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300',
  },
}

/** Humanise an audit event type: "trim_staff_rate_changed" -> "Trim staff rate changed". */
export function eventLabel(type: string): string {
  const t = type.replace(/_/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** One-line summary of an audit payload: up to six scalar fields. */
export function payloadSummary(payload: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined || typeof v === 'object') continue
    parts.push(`${k.replace(/_/g, ' ')}: ${String(v)}`)
    if (parts.length >= 6) break
  }
  return parts.join(' · ')
}

// ─── Pay ─────────────────────────────────────────────────────────────────────

/** "$225.00/lb", or "$225.00-$250.00/lb" when the rate changed inside the window. Dash when unknown. */
export function rateRangeText(min: number | null | undefined, max: number | null | undefined): string {
  if (min === null || min === undefined || max === null || max === undefined) return EM_DASH
  if (min === max) return `${moneyText(min)}/lb`
  return `${moneyText(Math.min(min, max))}\u2013${moneyText(Math.max(min, max))}/lb`
}

/** A list of distinct rates (ascending) as one range. */
export function ratesText(rates: readonly number[]): string {
  if (rates.length === 0) return EM_DASH
  return rateRangeText(Math.min(...rates), Math.max(...rates))
}

/** The finance bill's payment state, read live from the ledger. */
export const BILL_STATUS_META: Record<string, { label: string; pill: string }> = {
  unpaid: {
    label: 'Unpaid',
    pill: 'border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300',
  },
  partial: {
    label: 'Part paid',
    pill: 'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300',
  },
  paid: {
    label: 'Paid',
    pill: 'border-green-500/40 bg-green-500/15 text-green-700 dark:text-green-300',
  },
  void: {
    label: 'Void',
    pill: 'border-zinc-500/40 bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
  },
}

export function billStatusMeta(status: string | null | undefined): { label: string; pill: string } {
  return (status && BILL_STATUS_META[status]) || { label: status ?? 'No bill', pill: BILL_STATUS_META.void.pill }
}
