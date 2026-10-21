'use server'

// Harvest & Trim: read-only yield and trimmer-performance reports (Phase 1 reads).
//
// Authorization is enforced HERE (RLS is not a backstop): every exported function calls requireRole()
// first. All arithmetic lives in the pure lib/trim/yield.ts; this file only fetches and shapes.
// Dollar figures are returned only to roles in TRIM_PAY_APPROVE_ROLES (never to `grow`).
//
// No pay-register or per-batch pay report here: those are Phase 3 (payout / bill workflow).
//
// A 'use server' module may only export async functions (scripts/check-server-exports.mjs fails the
// build on re-exports). Type declarations are erased and fine.

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { TRIM_PAY_APPROVE_ROLES, TRIM_VIEW_ROLES, roleAllowed } from '@/lib/trim/roles'
import {
  computeYield,
  emptyYieldTotals,
  summarizeYield,
  type YieldEpisodeInput,
  type YieldLoadInput,
  type YieldSummary,
} from '@/lib/trim/yield'
import { dbFailure, denied, fail, invalid } from '@/lib/trim/db-errors'
import { sumMoney } from '@/lib/trim/pay'
import { chicagoDayRangeToUtc, daysBetween, isValidDay } from '@/lib/trim/day-range'
import { gramsToLb, roundLb, roundTo } from '@/lib/units'
import type {
  ActionResult,
  CheckoutStatus,
  HangerLoadStatus,
  ReturnKind,
  VarianceStatus,
} from '@/types/harvest-trim'

// ─── Shared plumbing (error mapping lives in lib/trim/db-errors.ts; a 'use server' file cannot export helpers) ───

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

function ok<T>(data: T): ActionResult<T> {
  return { success: true, data }
}

type Row = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function one(v: unknown): Row | null {
  if (Array.isArray(v)) return (v[0] as Row | undefined) ?? null
  return v && typeof v === 'object' ? (v as Row) : null
}

function many(v: unknown): Row[] {
  return Array.isArray(v) ? (v as Row[]) : []
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface YieldBatchReport {
  batchId: string
  batchName: string
  harvestDate: string | null
  strainId: string | null
  strainName: string | null
  cycleId: string | null
  /** Loads not yet reconciled or void. */
  openLoads: number
  /** Has loads and none are open (Phase 3 adds an explicit batch close; this is the derived equivalent). */
  complete: boolean
  summary: YieldSummary
}

export interface CycleYieldReport {
  cycleId: string
  batches: YieldBatchReport[]
  total: YieldSummary
}

export interface StrainYieldHistory {
  strainId: string
  strainName: string | null
  /** Newest harvest first. Includes batches still in progress: check `complete`. */
  batches: YieldBatchReport[]
}

export interface TrimmerPerformanceRow {
  trimmerId: string
  trimmerName: string
  /** Returned episodes in the range. */
  episodes: number
  /** Distinct hangers (loads) those episodes belong to. */
  hangers: number
  flowerG: number
  trimG: number
  stemsG: number
  returnedTotalG: number
  processedG: number
  flowerSharePct: number | null
  /** This trimmer's flower share minus the baseline (median across trimmers), in percentage points. */
  flowerShareDeltaPts: number | null
  /** The only check that sees material moved from the trim bin to the flower bin. */
  isFlowerShareOutlier: boolean
  avgTurnaroundHours: number | null
  avgVariancePct: number | null
  avgAbsVariancePct: number | null
  /** Episodes that tripped the flag (currently flagged or later accepted). */
  flaggedReturns: number
  acceptedReturns: number
  /** Null unless the viewer has pay access. */
  payAmount: number | null
}

export interface TrimmerPerformanceReport {
  from: string
  to: string
  /** The row cap was hit: narrow the date range. */
  truncated: boolean
  /** Everyone's pooled flower share, for context. */
  cohortFlowerSharePct: number | null
  /**
   * What outliers are measured against: the MEDIAN share among trimmers with enough material. A mean
   * would be dragged toward the very outlier it is meant to expose.
   */
  baselineFlowerSharePct: number | null
  rows: TrimmerPerformanceRow[]
}

/** A trimmer's rollup for the day report: the performance row plus a position in the crew. */
export interface TrimDayTrimmerRow extends TrimmerPerformanceRow {
  /** 1 = most flower. Ties share a rank. Always the position in the WHOLE crew, never within a filter. */
  rank: number
  issuedG: number
  /** flower / issued, as a percentage. */
  flowerYieldPct: number | null
  /** Database sign (loss positive); see TrimDayEpisode.varianceG. */
  varianceG: number
  /** Total variance over total processed grams, as a percentage. Same sign as varianceG. */
  variancePct: number | null
}

/** One returned custody episode: the per-hanger detail row. */
export interface TrimDayEpisode {
  checkoutId: string
  seq: number
  hangerCode: string
  loadId: string
  batchId: string | null
  batchName: string | null
  strainName: string | null
  trimmerId: string
  trimmerName: string
  checkedOutAt: string | null
  returnedAt: string | null
  turnaroundHours: number | null
  issuedG: number | null
  flowerG: number | null
  trimG: number | null
  stemsG: number | null
  returnedTotalG: number | null
  /**
   * Database sign: issued minus (flower + trim + stems + left on hanger), so a LOSS is POSITIVE. The
   * screens flip it for display (negative = weight missing); raw here so it matches the SQL.
   */
  varianceG: number | null
  /** varianceG / processed grams * 100 (the database's own denominator). Same sign as varianceG. */
  variancePct: number | null
  varianceStatus: VarianceStatus | null
  returnKind: ReturnKind | null
  /** Null unless the viewer has pay access. */
  ratePerLb: number | null
  /** Null unless the viewer has pay access, and null when no pay line exists yet (e.g. still flagged). */
  payAmount: number | null
}

export interface TrimDayTotals {
  /** Returned episodes. */
  episodes: number
  /** Distinct hangers (loads) those episodes belong to. */
  hangers: number
  issuedG: number
  flowerG: number
  flowerLb: number
  trimG: number
  stemsG: number
  returnedTotalG: number
  /** flower / (flower + trim + stems), as a percentage. */
  flowerSharePct: number | null
  /** flower / issued, as a percentage: the "what came off the hanger as flower" number. */
  flowerYieldPct: number | null
  /** Database sign (loss positive); see TrimDayEpisode.varianceG. */
  varianceG: number
  /** Total variance over total processed grams (issued minus left on hanger), as a percentage. */
  variancePct: number | null
  /** Episodes that tripped the flag (currently flagged or later accepted). */
  flaggedReturns: number
  /** Null unless the viewer has pay access. */
  payAmount: number | null
}

export interface TrimDayReport {
  from: string
  to: string
  /** Echo of the filters applied. */
  trimmerId: string | null
  batchId: string | null
  /** False for roles without pay access (grow): every dollar and rate field is null. */
  moneyVisible: boolean
  /** The row cap was hit: narrow the range. */
  truncated: boolean
  /** What outliers are measured against: the crew median, ALWAYS over the whole crew (see crew). */
  baselineFlowerSharePct: number | null
  /** Honours the trimmer and batch filters. */
  totals: TrimDayTotals
  /** Per-trimmer rollups honouring the trimmer filter; rank and outlier flags come from the whole crew. */
  trimmers: TrimDayTrimmerRow[]
  /**
   * The WHOLE crew for the date range and batch, never narrowed by trimmerId, so a single trimmer's
   * view can still show where they sit. Equals `trimmers` when no trimmer is selected.
   */
  crew: TrimDayTrimmerRow[]
  /** The per-hanger detail, oldest checkout first. */
  episodes: TrimDayEpisode[]
}

export interface TrimBatchOption {
  id: string
  name: string
  strainName: string | null
  harvestDate: string | null
}

export interface BatchLoadEpisode {
  id: string
  seq: number
  trimmerId: string
  trimmerName: string
  status: CheckoutStatus
  returnKind: ReturnKind | null
  issuedG: number | null
  flowerG: number | null
  trimG: number | null
  stemsG: number | null
  varianceG: number | null
  variancePct: number | null
  varianceStatus: VarianceStatus | null
  checkedOutAt: string | null
  returnedAt: string | null
}

export interface BatchLoadRow {
  loadId: string
  hangerCode: string
  status: HangerLoadStatus
  plantCount: number | null
  wetG: number | null
  dryG: number | null
  remainingG: number | null
  remainingPlantCount: number | null
  /** Oldest first (seq). Includes out and released episodes; only `returned` ones count in the rollups. */
  episodes: BatchLoadEpisode[]
}

export interface BatchTrimmerRollup {
  trimmerId: string
  trimmerName: string
  /** Returned episodes on this batch. */
  episodes: number
  /** Distinct hangers those episodes belong to. */
  hangers: number
  flowerG: number
  flowerLb: number
  returnedTotalG: number
  /** flower / (flower + trim + stems), as a percentage. */
  flowerSharePct: number | null
  /** Share minus the batch baseline (median among trimmers with enough material), in points. */
  flowerShareDeltaPts: number | null
  isFlowerShareOutlier: boolean
  /** Returned episodes still flagged: nothing is owed on them until they are resolved. */
  pendingFlaggedEpisodes: number
  /** Distinct $/lb applied across this trimmer's episodes, ascending. Null unless the viewer has pay access. */
  ratesPerLb: number[] | null
  /** Sum of this trimmer's pay entries on the batch. Null unless the viewer has pay access. */
  amountOwed: number | null
}

export interface BatchLoadTotals {
  /** Non-void loads. */
  loads: number
  voidLoads: number
  /** Non-void loads that are not yet reconciled. */
  openLoads: number
  plants: number
  wetG: number
  dryG: number
  remainingG: number
  /** Returned episodes. */
  episodes: number
  flowerG: number
  flowerLb: number
  trimG: number
  stemsG: number
  returnedTotalG: number
  flowerSharePct: number | null
  /** Null unless the viewer has pay access. */
  amountOwed: number | null
}

export interface BatchLoadsReport {
  batchId: string
  batchName: string
  /** False for roles without pay access (grow): every dollar and rate field is null. */
  moneyVisible: boolean
  /** What per-trimmer outliers are measured against (median share among trimmers with enough material). */
  baselineFlowerSharePct: number | null
  /** By hanger code. Void loads are included (status 'void') but excluded from the rollups and totals. */
  loads: BatchLoadRow[]
  /** By flower grams, descending. */
  trimmers: BatchTrimmerRollup[]
  totals: BatchLoadTotals
}

const OUTLIER_DELTA_PTS = 10
const OUTLIER_MIN_RETURNED_G = 2000
const PERFORMANCE_ROW_CAP = 1000
const MAX_RANGE_DAYS = 366
const BATCH_OPTIONS_CAP = 200
const DEFAULT_HISTORY_LIMIT = 10
const MAX_HISTORY_LIMIT = 50

/**
 * The flower-share outlier baseline, shared by the performance report and the per-batch trimmer
 * rollup so there is exactly one definition: the MEDIAN flower share among trimmers with at least
 * OUTLIER_MIN_RETURNED_G of returned material. A mean would be dragged toward the very outlier it
 * is meant to expose. Null when nobody has enough material.
 */
function flowerShareBaseline(trimmers: Iterable<{ flower: number; total: number }>): number | null {
  const shares = [...trimmers]
    .filter((t) => t.total >= OUTLIER_MIN_RETURNED_G)
    .map((t) => (t.flower / t.total) * 100)
    .sort((x, y) => x - y)
  if (shares.length === 0) return null
  const mid = Math.floor(shares.length / 2)
  return shares.length % 2 ? shares[mid] : (shares[mid - 1] + shares[mid]) / 2
}

/** One trimmer's flower share against the baseline. Unrounded; callers round for display. */
function flowerShareVerdict(
  t: { flower: number; total: number },
  baseline: number | null
): { sharePct: number | null; deltaPts: number | null; isOutlier: boolean } {
  const sharePct = t.total > 0 ? (t.flower / t.total) * 100 : null
  const deltaPts = sharePct !== null && baseline !== null ? sharePct - baseline : null
  return {
    sharePct,
    deltaPts,
    isOutlier: deltaPts !== null && Math.abs(deltaPts) > OUTLIER_DELTA_PTS && t.total >= OUTLIER_MIN_RETURNED_G,
  }
}

const EPISODE_YIELD_COLS = 'status, flower_g, trim_g, stems_g, processed_g, plants_finished'
const LOAD_YIELD_COLS =
  'id, batch_id, status, plant_count, wet_g, dry_g, remaining_g, remaining_plant_count'
const LOAD_YIELD_SELECT = `${LOAD_YIELD_COLS}, trim_checkouts(${EPISODE_YIELD_COLS})`

function toYieldInputs(loadRows: Row[]): { loads: YieldLoadInput[]; episodes: YieldEpisodeInput[] } {
  const loads: YieldLoadInput[] = []
  const episodes: YieldEpisodeInput[] = []
  for (const l of loadRows) {
    const id = String(l.id)
    loads.push({
      id,
      batchId: String(l.batch_id),
      status: l.status as HangerLoadStatus,
      plantCount: num(l.plant_count),
      wetG: num(l.wet_g),
      dryG: num(l.dry_g),
      remainingG: num(l.remaining_g),
      remainingPlantCount: num(l.remaining_plant_count),
    })
    for (const e of many(l.trim_checkouts)) {
      episodes.push({
        loadId: id,
        status: e.status as YieldEpisodeInput['status'],
        flowerG: num(e.flower_g),
        trimG: num(e.trim_g),
        stemsG: num(e.stems_g),
        processedG: num(e.processed_g),
        plantsFinished: num(e.plants_finished),
      })
    }
  }
  return { loads, episodes }
}

/** One batch's report from its row + its loads (embedded rows as returned by PostgREST). */
function batchReport(
  batch: Row,
  loadRows: Row[],
  totals: ReturnType<typeof computeYield>['byBatch']
): YieldBatchReport {
  const strain = one(batch.strain)
  const batchId = String(batch.id)
  const live = loadRows.filter((l) => l.status !== 'void')
  const openLoads = live.filter((l) => l.status !== 'reconciled').length
  return {
    batchId,
    batchName: String(batch.name),
    harvestDate: str(batch.harvest_date),
    strainId: strain ? String(strain.id) : null,
    strainName: strain ? str(strain.name) : null,
    cycleId: str(batch.room_cycle_id),
    openLoads,
    complete: live.length > 0 && openLoads === 0,
    summary: summarizeYield(totals.get(batchId) ?? emptyYieldTotals()),
  }
}

// ─── Yield ───────────────────────────────────────────────────────────────────

/** Yield for one batch. Every ratio reports its coverage; void loads are excluded. */
export async function getBatchYield(batchId: string): Promise<ActionResult<YieldBatchReport>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (!isUuid(batchId)) return invalid('Unknown batch.')

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('batches')
      .select(
        'id, name, harvest_date, room_cycle_id, strain:strains(id, name), hanger_loads(' + LOAD_YIELD_SELECT + ')'
      )
      .eq('id', batchId)
      .maybeSingle()
    if (error) return dbFailure('getBatchYield', error)
    if (!data) return fail('Batch not found.', 'NOT_FOUND')

    const batch = data as unknown as Row
    const loadRows = many(batch.hanger_loads)
    const { loads, episodes } = toYieldInputs(loadRows)
    return ok(batchReport(batch, loadRows, computeYield(loads, episodes).byBatch))
  } catch (err) {
    return dbFailure('getBatchYield', err)
  }
}

/** Per-batch rows plus the cycle roll-up (which equals computing the cycle directly, by construction). */
export async function getCycleYield(cycleId: string): Promise<ActionResult<CycleYieldReport>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (!isUuid(cycleId)) return invalid('Unknown cycle.')

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('batches')
      .select(
        'id, name, harvest_date, room_cycle_id, strain:strains(id, name), hanger_loads(' + LOAD_YIELD_SELECT + ')'
      )
      .eq('room_cycle_id', cycleId)
      .order('name', { ascending: true })
    if (error) return dbFailure('getCycleYield', error)

    const batchRows = many(data)
    const allLoadRows = batchRows.flatMap((b) => many(b.hanger_loads))
    const { loads, episodes } = toYieldInputs(allLoadRows)
    const computed = computeYield(loads, episodes)

    return ok({
      cycleId,
      batches: batchRows.map((b) => batchReport(b, many(b.hanger_loads), computed.byBatch)),
      total: summarizeYield(computed.total),
    })
  } catch (err) {
    return dbFailure('getCycleYield', err)
  }
}

/** The strain's most recent batches that have loads, newest harvest first, for comparison across harvests. */
export async function getStrainYieldHistory(
  strainId: string,
  limit: number = DEFAULT_HISTORY_LIMIT
): Promise<ActionResult<StrainYieldHistory>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (!isUuid(strainId)) return invalid('Unknown strain.')
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    return invalid(`Limit must be a whole number from 1 to ${MAX_HISTORY_LIMIT}.`)
  }

  try {
    const db = await createServiceClient()
    // !inner keeps only batches that have at least one load (the 130+ legacy batches have none).
    const { data, error } = await db
      .from('batches')
      .select(
        'id, name, harvest_date, room_cycle_id, strain:strains(id, name), hanger_loads!inner(' +
          LOAD_YIELD_SELECT +
          ')'
      )
      .eq('strain_id', strainId)
      .order('harvest_date', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (error) return dbFailure('getStrainYieldHistory', error)

    const batchRows = many(data)
    const { loads, episodes } = toYieldInputs(batchRows.flatMap((b) => many(b.hanger_loads)))
    const computed = computeYield(loads, episodes)
    const batches = batchRows.map((b) => batchReport(b, many(b.hanger_loads), computed.byBatch))

    let strainName = batches.find((b) => b.strainName)?.strainName ?? null
    if (strainName === null && batches.length === 0) {
      const { data: strain, error: strainErr } = await db.from('strains').select('id, name').eq('id', strainId).maybeSingle()
      if (strainErr) return dbFailure('getStrainYieldHistory', strainErr)
      if (!strain) return fail('Strain not found.', 'NOT_FOUND')
      strainName = str((strain as Row).name)
    }
    return ok({ strainId, strainName, batches })
  } catch (err) {
    return dbFailure('getStrainYieldHistory', err)
  }
}

// ─── Per-batch loads and per-trimmer rollup ──────────────────────────────────

const BATCH_LOAD_COLS = 'id, status, plant_count, wet_g, dry_g, remaining_g, remaining_plant_count, hanger:hangers(code)'
const BATCH_EPISODE_COLS =
  'id, seq, trimmer_id, trimmer_name, status, return_kind, flower_g, trim_g, stems_g, ' +
  'variance_g, variance_pct, variance_status, issued_g, checked_out_at, returned_at'
/** Added only for roles with pay access: the rate snapshot and the pay line. Grow never even selects them. */
const BATCH_EPISODE_MONEY_COLS = ', rate_per_lb_applied, trim_pay_entries(amount)'

/**
 * Everything the batch detail page needs in ONE round trip (nested embed batches -> hanger_loads ->
 * trim_checkouts -> trim_pay_entries): the per-load weights table, a per-trimmer rollup (episodes,
 * flower, rate(s), amount owed, flower share against the batch median) and batch totals.
 *
 * Dollars (rates, amounts owed) are returned only to roles in TRIM_PAY_APPROVE_ROLES; `grow` gets
 * null in those fields and the money columns are not selected for them at all.
 */
export async function getBatchLoads(batchId: string): Promise<ActionResult<BatchLoadsReport>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (!isUuid(batchId)) return invalid('Unknown batch.')
  const seesMoney = roleAllowed(TRIM_PAY_APPROVE_ROLES, auth.session.role)

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('batches')
      .select(
        'id, name, hanger_loads(' +
          BATCH_LOAD_COLS +
          ', trim_checkouts(' +
          BATCH_EPISODE_COLS +
          (seesMoney ? BATCH_EPISODE_MONEY_COLS : '') +
          '))'
      )
      .eq('id', batchId)
      .maybeSingle()
    if (error) return dbFailure('getBatchLoads', error)
    if (!data) return fail('Batch not found.', 'NOT_FOUND')

    const batch = data as unknown as Row
    // Rate and pay line per episode id, kept apart from the returned shape (never populated for grow).
    const money = new Map<string, { rate: number | null; amount: number | null }>()
    const loads: BatchLoadRow[] = many(batch.hanger_loads).map((l) => ({
      loadId: String(l.id),
      hangerCode: str(one(l.hanger)?.code) ?? '',
      status: l.status as HangerLoadStatus,
      plantCount: num(l.plant_count),
      wetG: num(l.wet_g),
      dryG: num(l.dry_g),
      remainingG: num(l.remaining_g),
      remainingPlantCount: num(l.remaining_plant_count),
      episodes: many(l.trim_checkouts)
        .map((e) => {
          if (seesMoney) {
            money.set(String(e.id), { rate: num(e.rate_per_lb_applied), amount: num(one(e.trim_pay_entries)?.amount) })
          }
          return {
            id: String(e.id),
            seq: num(e.seq) ?? 0,
            trimmerId: String(e.trimmer_id),
            trimmerName: String(e.trimmer_name),
            status: e.status as CheckoutStatus,
            returnKind: (str(e.return_kind) as ReturnKind | null) ?? null,
            issuedG: num(e.issued_g),
            flowerG: num(e.flower_g),
            trimG: num(e.trim_g),
            stemsG: num(e.stems_g),
            varianceG: num(e.variance_g),
            variancePct: num(e.variance_pct),
            varianceStatus: (str(e.variance_status) as VarianceStatus | null) ?? null,
            checkedOutAt: str(e.checked_out_at),
            returnedAt: str(e.returned_at),
            }
        })
        .sort((a, b) => a.seq - b.seq),
    }))
    loads.sort((a, b) => a.hangerCode.localeCompare(b.hangerCode, undefined, { numeric: true }))

    interface Acc {
      name: string
      episodes: number
      loads: Set<string>
      flower: number
      trim: number
      stems: number
      total: number
      pendingFlagged: number
      rates: Set<number>
      amounts: number[]
    }
    const byTrimmer = new Map<string, Acc>()
    const totals = {
      loads: 0, voidLoads: 0, openLoads: 0, plants: 0, wet: 0, dry: 0, remaining: 0,
      episodes: 0, flower: 0, trim: 0, stems: 0, amounts: [] as number[],
    }

    for (const load of loads) {
      if (load.status === 'void') {
        totals.voidLoads++
        continue
      }
      totals.loads++
      if (load.status !== 'reconciled') totals.openLoads++
      totals.plants += load.plantCount ?? 0
      totals.wet += load.wetG ?? 0
      totals.dry += load.dryG ?? 0
      totals.remaining += load.remainingG ?? 0

      for (const e of load.episodes) {
        if (e.status !== 'returned') continue
        const flower = e.flowerG ?? 0
        const trim = e.trimG ?? 0
        const stems = e.stemsG ?? 0
        let a = byTrimmer.get(e.trimmerId)
        if (!a) {
          a = { name: e.trimmerName, episodes: 0, loads: new Set(), flower: 0, trim: 0, stems: 0, total: 0, pendingFlagged: 0, rates: new Set(), amounts: [] }
          byTrimmer.set(e.trimmerId, a)
        }
        a.name = e.trimmerName
        a.episodes++
        a.loads.add(load.loadId)
        a.flower += flower
        a.trim += trim
        a.stems += stems
        a.total += flower + trim + stems
        if (e.varianceStatus === 'flagged') a.pendingFlagged++
        const pay = money.get(e.id)
        if (pay) {
          if (pay.rate !== null) a.rates.add(pay.rate)
          if (pay.amount !== null) {
            a.amounts.push(pay.amount)
            totals.amounts.push(pay.amount)
          }
        }
        totals.episodes++
        totals.flower += flower
        totals.trim += trim
        totals.stems += stems
      }
    }

    const baseline = flowerShareBaseline(byTrimmer.values())
    const trimmers: BatchTrimmerRollup[] = [...byTrimmer.entries()]
      .map(([trimmerId, a]) => {
        const { sharePct, deltaPts, isOutlier } = flowerShareVerdict(a, baseline)
        return {
          trimmerId,
          trimmerName: a.name,
          episodes: a.episodes,
          hangers: a.loads.size,
          flowerG: roundTo(a.flower, 2),
          flowerLb: roundLb(gramsToLb(a.flower)),
          returnedTotalG: roundTo(a.total, 2),
          flowerSharePct: sharePct === null ? null : roundTo(sharePct, 2),
          flowerShareDeltaPts: deltaPts === null ? null : roundTo(deltaPts, 2),
          isFlowerShareOutlier: isOutlier,
          pendingFlaggedEpisodes: a.pendingFlagged,
          ratesPerLb: seesMoney ? [...a.rates].sort((x, y) => x - y) : null,
          amountOwed: seesMoney ? sumMoney(a.amounts) : null,
        }
      })
      .sort((x, y) => y.flowerG - x.flowerG)

    const returnedTotal = totals.flower + totals.trim + totals.stems
    const report: BatchLoadsReport = {
      batchId: String(batch.id),
      batchName: String(batch.name),
      moneyVisible: seesMoney,
      baselineFlowerSharePct: baseline === null ? null : roundTo(baseline, 2),
      loads,
      trimmers,
      totals: {
        loads: totals.loads,
        voidLoads: totals.voidLoads,
        openLoads: totals.openLoads,
        plants: totals.plants,
        wetG: roundTo(totals.wet, 2),
        dryG: roundTo(totals.dry, 2),
        remainingG: roundTo(totals.remaining, 2),
        episodes: totals.episodes,
        flowerG: roundTo(totals.flower, 2),
        flowerLb: roundLb(gramsToLb(totals.flower)),
        trimG: roundTo(totals.trim, 2),
        stemsG: roundTo(totals.stems, 2),
        returnedTotalG: roundTo(returnedTotal, 2),
        flowerSharePct: returnedTotal > 0 ? roundTo((totals.flower / returnedTotal) * 100, 2) : null,
        amountOwed: seesMoney ? sumMoney(totals.amounts) : null,
      },
    }
    return ok(report)
  } catch (err) {
    return dbFailure('getBatchLoads', err)
  }
}

// ─── Trimmer performance ─────────────────────────────────────────────────────

/** Columns the per-trimmer rollup reads (plus `trim_pay_entries(amount)` for roles with pay access). */
const ROLLUP_COLS =
  'trimmer_id, trimmer_name, load_id, checked_out_at, returned_at, flower_g, trim_g, stems_g, processed_g, ' +
  'returned_total_g, variance_pct, variance_status'

/**
 * Validate an inclusive local-day range and convert it to UTC instants. "A day" is a calendar day in
 * America/Chicago (lib/trim/day-range.ts), the same for every report in this module. Returns an error
 * message, or the half-open [fromIso, toExclusiveIso) bounds.
 */
function resolveDayRange(from: unknown, to: unknown): { error: string } | { fromIso: string; toExclusiveIso: string } {
  if (!isValidDay(from) || !isValidDay(to)) return { error: 'Dates must be YYYY-MM-DD.' }
  if (to < from) return { error: 'The end date is before the start date.' }
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return { error: 'Choose a range of a year or less.' }
  const range = chicagoDayRangeToUtc(from, to)
  return range ?? { error: 'Dates must be YYYY-MM-DD.' }
}

/**
 * The per-trimmer rollup shared by getTrimmerPerformance and getTrimDayReport, so the two cannot drift
 * apart. `rows` are trim_checkouts rows selected with ROLLUP_COLS. Sorted by flower grams, descending.
 * Dollars are summed only when `seesMoney`; otherwise `payAmount` is null (callers also must not have
 * selected the money columns).
 */
function summarizeTrimmers(
  rows: Row[],
  seesMoney: boolean
): { rows: TrimmerPerformanceRow[]; cohortFlowerSharePct: number | null; baselineFlowerSharePct: number | null } {
  interface Acc {
    name: string
    episodes: number
    loads: Set<string>
    flower: number
    trim: number
    stems: number
    total: number
    processed: number
    turnaroundMs: number
    turnaroundN: number
    varSum: number
    absVarSum: number
    varN: number
    flagged: number
    accepted: number
    pay: number
  }
  const byTrimmer = new Map<string, Acc>()
  let cohortFlower = 0
  let cohortTotal = 0

  for (const r of rows) {
    const id = String(r.trimmer_id)
    let a = byTrimmer.get(id)
    if (!a) {
      a = {
        name: String(r.trimmer_name),
        episodes: 0,
        loads: new Set(),
        flower: 0,
        trim: 0,
        stems: 0,
        total: 0,
        processed: 0,
        turnaroundMs: 0,
        turnaroundN: 0,
        varSum: 0,
        absVarSum: 0,
        varN: 0,
        flagged: 0,
        accepted: 0,
        pay: 0,
      }
      byTrimmer.set(id, a)
    }
    a.name = String(r.trimmer_name)
    a.episodes++
    a.loads.add(String(r.load_id))
    const flower = num(r.flower_g) ?? 0
    const total = num(r.returned_total_g) ?? 0
    a.flower += flower
    a.trim += num(r.trim_g) ?? 0
    a.stems += num(r.stems_g) ?? 0
    a.total += total
    a.processed += num(r.processed_g) ?? 0
    cohortFlower += flower
    cohortTotal += total

    const out = Date.parse(String(r.checked_out_at))
    const back = Date.parse(String(r.returned_at))
    if (Number.isFinite(out) && Number.isFinite(back) && back >= out) {
      a.turnaroundMs += back - out
      a.turnaroundN++
    }
    const pct = num(r.variance_pct)
    if (pct !== null) {
      a.varSum += pct
      a.absVarSum += Math.abs(pct)
      a.varN++
    }
    if (r.variance_status === 'flagged' || r.variance_status === 'accepted') a.flagged++
    if (r.variance_status === 'accepted') a.accepted++
    if (seesMoney) a.pay += num(one(r.trim_pay_entries)?.amount) ?? 0
  }

  const cohortShare = cohortTotal > 0 ? (cohortFlower / cohortTotal) * 100 : null
  const baseline = flowerShareBaseline(byTrimmer.values())

  const out: TrimmerPerformanceRow[] = [...byTrimmer.entries()].map(([trimmerId, a]) => {
    const { sharePct: share, deltaPts: delta, isOutlier } = flowerShareVerdict(a, baseline)
    return {
      trimmerId,
      trimmerName: a.name,
      episodes: a.episodes,
      hangers: a.loads.size,
      flowerG: roundTo(a.flower, 2),
      trimG: roundTo(a.trim, 2),
      stemsG: roundTo(a.stems, 2),
      returnedTotalG: roundTo(a.total, 2),
      processedG: roundTo(a.processed, 2),
      flowerSharePct: share === null ? null : roundTo(share, 2),
      flowerShareDeltaPts: delta === null ? null : roundTo(delta, 2),
      isFlowerShareOutlier: isOutlier,
      avgTurnaroundHours: a.turnaroundN > 0 ? roundTo(a.turnaroundMs / a.turnaroundN / 3_600_000, 2) : null,
      avgVariancePct: a.varN > 0 ? roundTo(a.varSum / a.varN, 3) : null,
      avgAbsVariancePct: a.varN > 0 ? roundTo(a.absVarSum / a.varN, 3) : null,
      flaggedReturns: a.flagged,
      acceptedReturns: a.accepted,
      payAmount: seesMoney ? roundTo(a.pay, 2) : null,
    }
  })
  out.sort((x, y) => y.flowerG - x.flowerG)

  return {
    rows: out,
    cohortFlowerSharePct: cohortShare === null ? null : roundTo(cohortShare, 2),
    baselineFlowerSharePct: baseline === null ? null : roundTo(baseline, 2),
  }
}

/**
 * Per-trimmer metrics for episodes RETURNED in [from, to] (inclusive dates; each day is a calendar day
 * in America/Chicago, see lib/trim/day-range.ts). `trimmerId` narrows to one person. Dollars appear
 * only for roles with pay access.
 */
export async function getTrimmerPerformance(input: {
  trimmerId?: string
  from: string
  to: string
}): Promise<ActionResult<TrimmerPerformanceReport>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  const seesMoney = roleAllowed(TRIM_PAY_APPROVE_ROLES, auth.session.role)

  if (input?.trimmerId !== undefined && !isUuid(input.trimmerId)) return invalid('Unknown trimmer.')
  const range = resolveDayRange(input?.from, input?.to)
  if ('error' in range) return invalid(range.error)

  try {
    const db = await createServiceClient()
    let query = db
      .from('trim_checkouts')
      .select(ROLLUP_COLS + (seesMoney ? ', trim_pay_entries(amount)' : ''))
      .eq('status', 'returned')
      .gte('returned_at', range.fromIso)
      .lt('returned_at', range.toExclusiveIso)
      .order('returned_at', { ascending: true })
      .limit(PERFORMANCE_ROW_CAP)
    if (input.trimmerId) query = query.eq('trimmer_id', input.trimmerId)

    const { data, error } = await query
    if (error) return dbFailure('getTrimmerPerformance', error)
    const rows = many(data)
    const summary = summarizeTrimmers(rows, seesMoney)

    return ok({
      from: input.from,
      to: input.to,
      truncated: rows.length >= PERFORMANCE_ROW_CAP,
      cohortFlowerSharePct: summary.cohortFlowerSharePct,
      baselineFlowerSharePct: summary.baselineFlowerSharePct,
      rows: summary.rows,
    })
  } catch (err) {
    return dbFailure('getTrimmerPerformance', err)
  }
}

// ─── Trim day report (date x batch x trimmer, with per-hanger detail) ────────

const DAY_EPISODE_COLS =
  'id, seq, load_id, trimmer_id, trimmer_name, checked_out_at, returned_at, return_kind, issued_g, flower_g, ' +
  'trim_g, stems_g, processed_g, returned_total_g, variance_g, variance_pct, variance_status'
/** Added only for roles with pay access. Grow never even selects them. */
const DAY_EPISODE_MONEY_COLS = ', rate_per_lb_applied, trim_pay_entries(amount)'
/** to-one embed; !inner so a `hanger_loads.batch_id` filter drops non-matching checkouts instead of nulling the embed. */
const DAY_LOAD_EMBED = ', hanger_loads!inner(batch_id, hanger:hangers(code), batch:batches(name, strain:strains(name)))'

/**
 * The trim production report behind /dashboard/harvest-trim/reports: every episode RETURNED in an
 * inclusive local-day range (America/Chicago), optionally narrowed to one batch and/or one trimmer, as
 *   - totals    over the filtered episodes,
 *   - trimmers  per-trimmer rollups (same shape and baseline as getTrimmerPerformance, plus a rank),
 *   - crew      the whole crew's ranking, and
 *   - episodes  one row per hanger return (the per-hanger detail).
 *
 * Trimmer filter and the crew baseline: the query is NEVER narrowed by trimmerId. The whole crew is
 * fetched for the date range + batch, the baseline/rank/outlier flags are computed across everyone, and
 * only then are `totals`, `trimmers` and `episodes` narrowed to the selected trimmer. Asking the
 * database for one person would measure them against themselves (their own median) and lose the crew
 * ranking. The cost is that the row cap applies to the crew, not the person; `truncated` says so.
 *
 * Dollars (ratePerLb, payAmount) are returned only to roles in TRIM_PAY_APPROVE_ROLES; for `grow` they
 * are null and the money columns are not selected at all. That makes this the intended source for a
 * future trimmer-facing leaderboard / TV monitor: render `crew` and ignore the money fields.
 */
export async function getTrimDayReport(input: {
  from: string
  to: string
  trimmerId?: string
  batchId?: string
}): Promise<ActionResult<TrimDayReport>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  const seesMoney = roleAllowed(TRIM_PAY_APPROVE_ROLES, auth.session.role)

  const trimmerId = input?.trimmerId ?? null
  const batchId = input?.batchId ?? null
  if (trimmerId !== null && !isUuid(trimmerId)) return invalid('Unknown trimmer.')
  if (batchId !== null && !isUuid(batchId)) return invalid('Unknown batch.')
  const range = resolveDayRange(input?.from, input?.to)
  if ('error' in range) return invalid(range.error)

  try {
    const db = await createServiceClient()
    let query = db
      .from('trim_checkouts')
      .select(DAY_EPISODE_COLS + (seesMoney ? DAY_EPISODE_MONEY_COLS : '') + DAY_LOAD_EMBED)
      .eq('status', 'returned')
      .gte('returned_at', range.fromIso)
      .lt('returned_at', range.toExclusiveIso)
      .order('returned_at', { ascending: true })
      .limit(PERFORMANCE_ROW_CAP)
    // Batch lives on the load: trim_checkouts -> hanger_loads.batch_id (verified against PostgREST).
    if (batchId) query = query.eq('hanger_loads.batch_id', batchId)

    const { data, error } = await query
    if (error) return dbFailure('getTrimDayReport', error)
    const rows = many(data)

    // Crew first (everyone), so rank and baseline never depend on the trimmer filter.
    const summary = summarizeTrimmers(rows, seesMoney)
    const perTrimmer = new Map<string, { issued: number; variance: number; processed: number }>()
    for (const r of rows) {
      const id = String(r.trimmer_id)
      const a = perTrimmer.get(id) ?? { issued: 0, variance: 0, processed: 0 }
      a.issued += num(r.issued_g) ?? 0
      a.variance += num(r.variance_g) ?? 0
      a.processed += num(r.processed_g) ?? 0
      perTrimmer.set(id, a)
    }
    const ranked: TrimDayTrimmerRow[] = []
    for (const r of summary.rows) {
      const prev = ranked[ranked.length - 1]
      const t = perTrimmer.get(r.trimmerId) ?? { issued: 0, variance: 0, processed: 0 }
      ranked.push({
        ...r,
        rank: prev && prev.flowerG === r.flowerG ? prev.rank : ranked.length + 1,
        issuedG: roundTo(t.issued, 2),
        flowerYieldPct: t.issued > 0 ? roundTo((r.flowerG / t.issued) * 100, 2) : null,
        varianceG: roundTo(t.variance, 2),
        variancePct: t.processed > 0 ? roundTo((t.variance / t.processed) * 100, 3) : null,
      })
    }
    const crew = ranked
    const trimmers = trimmerId ? ranked.filter((t) => t.trimmerId === trimmerId) : ranked

    const selected = trimmerId ? rows.filter((r) => String(r.trimmer_id) === trimmerId) : rows

    const episodes: TrimDayEpisode[] = selected.map((r) => {
      const load = one(r.hanger_loads)
      const batch = one(load?.batch)
      const out = Date.parse(String(r.checked_out_at))
      const back = Date.parse(String(r.returned_at))
      return {
        checkoutId: String(r.id),
        seq: num(r.seq) ?? 0,
        hangerCode: str(one(load?.hanger)?.code) ?? '',
        loadId: String(r.load_id),
        batchId: str(load?.batch_id),
        batchName: str(batch?.name),
        strainName: str(one(batch?.strain)?.name),
        trimmerId: String(r.trimmer_id),
        trimmerName: String(r.trimmer_name),
        checkedOutAt: str(r.checked_out_at),
        returnedAt: str(r.returned_at),
        turnaroundHours:
          Number.isFinite(out) && Number.isFinite(back) && back >= out ? roundTo((back - out) / 3_600_000, 2) : null,
        issuedG: num(r.issued_g),
        flowerG: num(r.flower_g),
        trimG: num(r.trim_g),
        stemsG: num(r.stems_g),
        returnedTotalG: num(r.returned_total_g),
        varianceG: num(r.variance_g),
        variancePct: num(r.variance_pct),
        varianceStatus: (str(r.variance_status) as VarianceStatus | null) ?? null,
        returnKind: (str(r.return_kind) as ReturnKind | null) ?? null,
        ratePerLb: seesMoney ? num(r.rate_per_lb_applied) : null,
        payAmount: seesMoney ? num(one(r.trim_pay_entries)?.amount) : null,
      }
    })
    episodes.sort(
      (a, b) =>
        (Date.parse(a.checkedOutAt ?? '') || 0) - (Date.parse(b.checkedOutAt ?? '') || 0) || a.seq - b.seq
    )

    let issued = 0
    let flower = 0
    let trim = 0
    let stems = 0
    let returnedTotal = 0
    let variance = 0
    let processed = 0
    let flagged = 0
    const loadIds = new Set<string>()
    const amounts: number[] = []
    for (const r of selected) {
      loadIds.add(String(r.load_id))
      issued += num(r.issued_g) ?? 0
      flower += num(r.flower_g) ?? 0
      trim += num(r.trim_g) ?? 0
      stems += num(r.stems_g) ?? 0
      returnedTotal += num(r.returned_total_g) ?? 0
      variance += num(r.variance_g) ?? 0
      processed += num(r.processed_g) ?? 0
      if (r.variance_status === 'flagged' || r.variance_status === 'accepted') flagged++
      const amount = seesMoney ? num(one(r.trim_pay_entries)?.amount) : null
      if (amount !== null) amounts.push(amount)
    }

    return ok({
      from: input.from,
      to: input.to,
      trimmerId,
      batchId,
      moneyVisible: seesMoney,
      truncated: rows.length >= PERFORMANCE_ROW_CAP,
      baselineFlowerSharePct: summary.baselineFlowerSharePct,
      totals: {
        episodes: selected.length,
        hangers: loadIds.size,
        issuedG: roundTo(issued, 2),
        flowerG: roundTo(flower, 2),
        flowerLb: roundLb(gramsToLb(flower)),
        trimG: roundTo(trim, 2),
        stemsG: roundTo(stems, 2),
        returnedTotalG: roundTo(returnedTotal, 2),
        flowerSharePct: returnedTotal > 0 ? roundTo((flower / returnedTotal) * 100, 2) : null,
        flowerYieldPct: issued > 0 ? roundTo((flower / issued) * 100, 2) : null,
        varianceG: roundTo(variance, 2),
        variancePct: processed > 0 ? roundTo((variance / processed) * 100, 3) : null,
        flaggedReturns: flagged,
        payAmount: seesMoney ? sumMoney(amounts) : null,
      },
      trimmers,
      crew,
      episodes,
    })
  } catch (err) {
    return dbFailure('getTrimDayReport', err)
  }
}

/**
 * Batches that have at least one hanger load, newest harvest first, for the report's batch filter.
 * Capped at BATCH_OPTIONS_CAP: older batches fall off the list, never newer ones.
 */
export async function listTrimBatchOptions(): Promise<ActionResult<TrimBatchOption[]>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  try {
    const db = await createServiceClient()
    // !inner drops batches with no loads (the 130+ legacy batches); limit 1 on the embed keeps it to a
    // single load id per batch rather than shipping every load.
    const { data, error } = await db
      .from('batches')
      .select('id, name, harvest_date, strain:strains(name), hanger_loads!inner(id)')
      .order('harvest_date', { ascending: false, nullsFirst: false })
      .limit(1, { referencedTable: 'hanger_loads' })
      .limit(BATCH_OPTIONS_CAP)
    if (error) return dbFailure('listTrimBatchOptions', error)

    return ok(
      many(data).map((b) => ({
        id: String(b.id),
        name: String(b.name),
        strainName: str(one(b.strain)?.name),
        harvestDate: str(b.harvest_date),
      }))
    )
  } catch (err) {
    return dbFailure('listTrimBatchOptions', err)
  }
}
