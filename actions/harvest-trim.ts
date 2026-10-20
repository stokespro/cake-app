'use server'

// Harvest & Trim: batch declaration, load transitions (weigh-in -> dry -> checkout -> check-in),
// the board, and variance settings. Phase 0 + 1 only: no batch close, no payout / approval actions.
//
// Authorization is enforced HERE (RLS is not a backstop): every exported function calls requireRole()
// first. The actor is always auth.session.userId. The only client-supplied person id is `trimmerId`
// (a trim_staff id), which fn_trim_checkout validates as existing and active inside the same
// transaction that issues the hanger.
//
// Money rules: no action accepts a rate, threshold or issued weight. checkInLoad / correctReturn /
// resolveVariance read the checkout and trim_settings themselves, then run the pure
// evaluateVariance() and computePayAmount() and forward the results to the DB function.
//
// A 'use server' module may only export async functions (scripts/check-server-exports.mjs fails the
// build on re-exports). Type declarations are erased and fine.

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import {
  HARVEST_WEIGH_ROLES,
  TRIM_ADMIN_ROLES,
  TRIM_OPS_ROLES,
  TRIM_PAY_APPROVE_ROLES,
  TRIM_VIEW_ROLES,
  roleAllowed,
} from '@/lib/trim/roles'
import { evaluateVariance } from '@/lib/trim/variance'
import { computePayAmount } from '@/lib/trim/pay'
import { MAX_WEIGHT_G } from '@/lib/trim/weights'
import { roundGrams } from '@/lib/units'
import type { ScanEpisode } from '@/actions/hangers'
import { GENERIC_ERROR, dbFailure, denied, fail, invalid, type DbError } from '@/lib/trim/db-errors'
import type {
  ActionResult,
  CheckoutStatus,
  HangerLoadStatus,
  ReturnKind,
  TrimEvent,
  TrimSettings,
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

/** Audit row for a direct write. Best effort: the write it describes has already happened. */
async function logEvent(
  db: Awaited<ReturnType<typeof createServiceClient>>,
  actorId: string,
  eventType: string,
  refs: { hanger_id?: string | null; load_id?: string | null; batch_id?: string | null },
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await db
      .from('trim_events')
      .insert({ actor_user_id: actorId, event_type: eventType, ...refs, payload })
    if (error) console.error('[harvest-trim] audit event failed:', eventType, error)
  } catch (err) {
    console.error('[harvest-trim] audit event failed:', eventType, err)
  }
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

/**
 * A client weight -> stored grams (numeric(10,2)), or null when unusable. Rounding here means the
 * figure used for variance / pay is exactly the figure the column will hold.
 */
function toGrams(v: unknown, allowZero = false): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
  const g = roundGrams(v)
  if (g === 0 && !allowZero) return null
  return g > MAX_WEIGHT_G ? null : g
}

function toPlants(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 500 ? v : null
}

function cleanReason(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length >= 3 && t.length <= 500 ? t : null
}

function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** One rpc call; a null / empty / non-object result is a failure, never a success. */
async function callRpc(label: string, fn: string, params: Record<string, unknown>): Promise<ActionResult<Row>> {
  const db = await createServiceClient()
  const { data, error } = await db.rpc(fn, params)
  if (error) return dbFailure(label, error)
  if (data === null || data === undefined || typeof data !== 'object' || (Array.isArray(data) && data.length === 0)) {
    console.error(`[harvest-trim] ${label} error: empty rpc result from ${fn}`)
    return fail(GENERIC_ERROR)
  }
  return ok((Array.isArray(data) ? data[0] : data) as Row)
}

/** Strip anything that looks like money from an audit payload (roles without pay access). */
function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPayload)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/pay|rate|amount|dollar|price/i.test(k)) continue
      out[k] = redactPayload(v)
    }
    return out
  }
  return value
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CycleOption {
  id: string
  cycleNumber: number | null
  stage: string
  harvestDate: string | null
  dryStart: string | null
  trimStart: string | null
  roomId: string | null
  roomName: string | null
  roomNumber: number | null
  /** Batches already declared on this cycle; 0 drives the blocking "Declare batches" card. */
  batchCount: number
  /**
   * True for a cycle whose status is 'completed'. Only ever true when the caller asked for
   * `includeCompleted`. Always set by listHarvestCycles; optional only so hand-built fixtures compile.
   */
  isCompleted?: boolean
  /** The date the cycle was closed ('yyyy-MM-dd'); null while it is live. */
  actualEndDate?: string | null
}

export interface CycleBatch {
  id: string
  name: string
  harvestDate: string | null
  isActive: boolean
  strainId: string | null
  strainName: string | null
  loadCount: number
  /** Non-void loads by status. */
  counts: Partial<Record<HangerLoadStatus, number>>
}

export interface BatchOption {
  id: string
  name: string
  strainId: string | null
  strainName: string | null
  isActive: boolean
  createdAt: string | null
}

export interface DeclaredBatch {
  id: string
  name: string
  strainId: string
  harvestDate: string | null
}

export interface DeclareBatchesResult {
  created: DeclaredBatch[]
  /** Already declared on this cycle with the same name and strain (idempotent re-submit). */
  skipped: DeclaredBatch[]
}

export interface TrimStrainOption {
  id: string
  name: string
  /**
   * Name of this strain's most recent batch (any cycle, newest created_at), or null if it has none.
   * Feed it to deriveStrainAbbreviation as strainBatches: [{ name: latestBatchName, createdAt: latestBatchCreatedAt }].
   */
  latestBatchName: string | null
  latestBatchCreatedAt: string | null
  /** True when the requested cycle already has a batch for this strain; always false without a cycleId. */
  hasBatchInCycle: boolean
}

export interface HarvestWeightResult {
  loadId: string
  wetG: number
  /** Running totals for the batch, or null if that read failed (the weigh-in itself still succeeded). */
  batchTotals: { hangers: number; plants: number; wetG: number } | null
}

export interface CheckOutResult {
  checkoutId: string
  seq: number
  trimmerName: string
  issuedG: number
  issuedPlantCount: number | null
  loadStatus: HangerLoadStatus
}

export type ReturnOutcome = 'reconciled' | 'partial' | 'flagged'

export interface ReturnResult {
  checkoutId: string
  loadId: string
  /** The load's status after the call. */
  loadStatus: HangerLoadStatus
  /** reconciled = finished and in threshold; partial = unfinished and in threshold; flagged = out of threshold. */
  outcome: ReturnOutcome
  varianceStatus: 'ok' | 'flagged'
  returnKind: ReturnKind
  varianceG: number
  variancePct: number
  direction: 'loss' | 'gain' | 'none'
  /** flower + trim + stems. */
  totalG: number
  processedG: number
  remainingG: number
  remainingPlants: number
  plantsFinished: number | null
  /** The thresholds this was judged under. */
  thresholdPct: number
  thresholdFloorG: number
  /** Dollars earned for this episode; null when flagged (nothing is owed until it is resolved). */
  payAmount: number | null
}

export interface BoardBatch {
  id: string
  name: string
  harvestDate: string | null
  strainId: string | null
  strainName: string | null
  cycleId: string | null
  /** Loads by status (void included, so a count of voids is visible). */
  counts: Partial<Record<HangerLoadStatus, number>>
  /** Non-void loads. */
  loads: number
  plants: number
  wetG: number
  dryG: number
  remainingG: number
}

export interface BoardLoad {
  loadId: string
  hangerCode: string
  status: HangerLoadStatus
  batchId: string
  batchName: string
  plantCount: number | null
  dryG: number | null
  remainingG: number | null
  remainingPlants: number | null
  updatedAt: string
}

export interface BoardOut {
  loadId: string
  checkoutId: string
  hangerCode: string
  batchId: string
  batchName: string
  trimmerId: string
  trimmerName: string
  issuedG: number
  issuedPlantCount: number | null
  checkedOutAt: string
}

export interface BoardFlagged {
  loadId: string
  checkoutId: string
  hangerCode: string
  batchId: string
  batchName: string
  trimmerName: string
  returnKind: ReturnKind | null
  issuedG: number
  flowerG: number | null
  trimG: number | null
  stemsG: number | null
  remainingG: number | null
  varianceG: number | null
  variancePct: number | null
  returnedAt: string | null
}

export interface BoardTrimmer {
  id: string
  name: string
  hangersOut: number
  gramsOut: number
}

export interface TrimBoard {
  /** 'cycle' = every load of the cycle's batches; 'open_work' = open loads across all cycles. */
  scope: 'cycle' | 'open_work'
  cycleId: string | null
  batches: BoardBatch[]
  /** Flagged returns waiting on a decision. */
  flagged: BoardFlagged[]
  /** Hangers currently held by a trimmer. */
  out: BoardOut[]
  /** Unfinished hangers waiting to be reissued. */
  partial: BoardLoad[]
  /** Active trimmers with what they hold (within the scope above). */
  trimmers: BoardTrimmer[]
  generatedAt: string
}

export interface LoadHistory {
  events: TrimEvent[]
  /** Oldest first; no rates or dollars. */
  episodes: ScanEpisode[]
}

export interface DeclareBatchInput {
  strainId: string
  name: string
  harvestDate?: string
}

// ─── Column lists ────────────────────────────────────────────────────────────

const EPISODE_COLS =
  'id, seq, trimmer_id, trimmer_name, status, issued_g, issued_plant_count, checked_out_at, returned_at, ' +
  'return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, plants_finished, processed_g, ' +
  'returned_total_g, variance_g, variance_pct, flag_pct_applied, flag_floor_g_applied, variance_status, ' +
  'variance_reason, released_at, release_reason'

const OPEN_STATUS_FILTER = '(reconciled,void)'
const HARVEST_STAGES = ['flower', 'harvest', 'dry', 'trim']
const CYCLE_SELECT =
  'id, cycle_number, current_stage, status, harvest_date, dry_start, trim_start, actual_end_date, ' +
  'room:grow_rooms(id, room_name, room_number), batches(count)'
/**
 * How far back a completed cycle's harvest can be and still be offered for catch-up. Harvest to close is
 * weeks, and the paper records are keyed in after that, so 120 days covers a late catch-up without
 * listing the room's whole history.
 */
const COMPLETED_WINDOW_DAYS = 120

function toEpisode(r: Row): ScanEpisode {
  return {
    id: String(r.id),
    seq: Number(r.seq),
    trimmerId: String(r.trimmer_id),
    trimmerName: String(r.trimmer_name),
    status: r.status as CheckoutStatus,
    issuedG: Number(r.issued_g),
    issuedPlantCount: num(r.issued_plant_count),
    checkedOutAt: String(r.checked_out_at),
    returnedAt: str(r.returned_at),
    returnKind: (str(r.return_kind) as ReturnKind | null) ?? null,
    flowerG: num(r.flower_g),
    trimG: num(r.trim_g),
    stemsG: num(r.stems_g),
    remainingG: num(r.remaining_g),
    remainingPlantCount: num(r.remaining_plant_count),
    plantsFinished: num(r.plants_finished),
    processedG: num(r.processed_g),
    returnedTotalG: num(r.returned_total_g),
    varianceG: num(r.variance_g),
    variancePct: num(r.variance_pct),
    flagPctApplied: num(r.flag_pct_applied),
    flagFloorGApplied: num(r.flag_floor_g_applied),
    varianceStatus: (str(r.variance_status) as VarianceStatus | null) ?? null,
    varianceReason: str(r.variance_reason),
    releasedAt: str(r.released_at),
    releaseReason: str(r.release_reason),
  }
}

function toDeclared(r: Row): DeclaredBatch {
  return {
    id: String(r.id),
    name: String(r.name),
    strainId: String(r.strain_id),
    harvestDate: str(r.harvest_date),
  }
}

// ─── Cycle and batch reads ───────────────────────────────────────────────────

/**
 * Active cycles in flower / harvest / dry / trim, for the cycle picker. With `includeCompleted` it also
 * returns completed cycles in harvest / dry / trim whose harvest date is within the last 120 days, so a
 * harvest that already finished can still be caught up (late entry, linking a batch). Active cycles come
 * first (soonest harvest first), then completed ones, most recent harvest first. Each carries `isCompleted`.
 * The no-argument call is unchanged: active cycles only.
 */
export async function listHarvestCycles(
  options: { includeCompleted?: boolean } = {}
): Promise<ActionResult<CycleOption[]>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  const includeCompleted = options?.includeCompleted === true

  try {
    const db = await createServiceClient()
    const activeQuery = db
      .from('room_cycles')
      .select(CYCLE_SELECT)
      .eq('status', 'active')
      .in('current_stage', HARVEST_STAGES)
      .order('harvest_date', { ascending: true })

    let completedQuery = null
    if (includeCompleted) {
      const cutoff = new Date(Date.now() - COMPLETED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
      completedQuery = db
        .from('room_cycles')
        .select(CYCLE_SELECT)
        .eq('status', 'completed')
        // A completed cycle never sits in flower: it was harvested, so only the post-harvest stages count.
        .in('current_stage', HARVEST_STAGES.filter((s) => s !== 'flower'))
        .gte('harvest_date', cutoff)
        .order('harvest_date', { ascending: false })
    }

    const [active, completed] = await Promise.all([activeQuery, completedQuery])
    if (active.error) return dbFailure('listHarvestCycles', active.error)
    if (completed?.error) return dbFailure('listHarvestCycles', completed.error)

    const toOption = (r: Row): CycleOption => {
      const room = one(r.room)
      const isCompleted = r.status === 'completed'
      return {
        id: String(r.id),
        cycleNumber: num(r.cycle_number),
        stage: String(r.current_stage),
        harvestDate: str(r.harvest_date),
        dryStart: str(r.dry_start),
        trimStart: str(r.trim_start),
        roomId: room ? String(room.id) : null,
        roomName: room ? str(room.room_name) : null,
        roomNumber: room ? num(room.room_number) : null,
        batchCount: num(one(r.batches)?.count) ?? 0,
        isCompleted,
        actualEndDate: isCompleted ? str(r.actual_end_date) : null,
      }
    }

    return ok([...many(active.data).map(toOption), ...many(completed?.data).map(toOption)])
  } catch (err) {
    return dbFailure('listHarvestCycles', err)
  }
}

/** Batches declared on a cycle with their load counts. */
export async function getCycleBatches(cycleId: string): Promise<ActionResult<CycleBatch[]>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (!isUuid(cycleId)) return invalid('Unknown cycle.')

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('batches')
      .select('id, name, harvest_date, is_active, strain:strains(id, name), hanger_loads(status)')
      .eq('room_cycle_id', cycleId)
      .order('name', { ascending: true })
    if (error) return dbFailure('getCycleBatches', error)

    return ok(
      many(data).map((r) => {
        const strain = one(r.strain)
        const counts: Partial<Record<HangerLoadStatus, number>> = {}
        let loadCount = 0
        for (const l of many(r.hanger_loads)) {
          const s = l.status as HangerLoadStatus
          counts[s] = (counts[s] ?? 0) + 1
          if (s !== 'void') loadCount++
        }
        return {
          id: String(r.id),
          name: String(r.name),
          harvestDate: str(r.harvest_date),
          isActive: r.is_active === true,
          strainId: strain ? String(strain.id) : null,
          strainName: strain ? str(strain.name) : null,
          loadCount,
          counts,
        }
      })
    )
  } catch (err) {
    return dbFailure('getCycleBatches', err)
  }
}

/** Batches with no cycle (legacy), for linking. Its own action: getBatches is gated to vault roles. */
export async function listUnlinkedBatches(q?: string): Promise<ActionResult<BatchOption[]>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (q !== undefined && typeof q !== 'string') return invalid('Invalid search.')

  const term = (q ?? '').trim().replace(/[\\%_,()]/g, '').slice(0, 64)
  try {
    const db = await createServiceClient()
    let query = db
      .from('batches')
      .select('id, name, is_active, created_at, strain:strains(id, name)')
      .is('room_cycle_id', null)
      .order('created_at', { ascending: false })
      .limit(100)
    if (term) query = query.ilike('name', `%${term}%`)
    const { data, error } = await query
    if (error) return dbFailure('listUnlinkedBatches', error)

    return ok(
      many(data).map((r) => {
        const strain = one(r.strain)
        return {
          id: String(r.id),
          name: String(r.name),
          strainId: strain ? String(strain.id) : null,
          strainName: strain ? str(strain.name) : null,
          isActive: r.is_active === true,
          createdAt: str(r.created_at),
        }
      })
    )
  } catch (err) {
    return dbFailure('listUnlinkedBatches', err)
  }
}

// ─── Batch declaration (R2.5) ────────────────────────────────────────────────

/** How many of the newest batches are scanned for "latest batch per strain". Far above today's ~150. */
const STRAIN_BATCH_SCAN_LIMIT = 2000

/**
 * Every strain, by name, for the declare-batches multi-select. NO availability filter:
 * strains.availability is menu-facing and says nothing about what is grown. Per strain it also returns
 * the most recent batch's name (for the abbreviation suggestion) and, when `cycleId` is given,
 * whether that cycle already has a batch for it (so the form can untick or flag it).
 *
 * Two queries total. The batch scan is newest-first and capped, so a strain whose newest batch is
 * beyond the cap simply has no suggestion (the caller falls back to initials). The cycle flag is
 * advisory: fn_trim_declare_batches is idempotent and the name is unique-checked in the database.
 */
export async function listTrimStrains(cycleId?: string): Promise<ActionResult<TrimStrainOption[]>> {
  const auth = await requireRole(HARVEST_WEIGH_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (cycleId !== undefined && !isUuid(cycleId)) return invalid('Unknown cycle.')

  try {
    const db = await createServiceClient()
    const [strains, batches] = await Promise.all([
      db.from('strains').select('id, name').order('name', { ascending: true }),
      db
        .from('batches')
        .select('strain_id, name, created_at, room_cycle_id')
        .not('strain_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(STRAIN_BATCH_SCAN_LIMIT),
    ])
    if (strains.error) return dbFailure('listTrimStrains', strains.error)
    if (batches.error) return dbFailure('listTrimStrains', batches.error)

    const latest = new Map<string, { name: string; createdAt: string | null }>()
    const inCycle = new Set<string>()
    for (const b of many(batches.data)) {
      const strainId = str(b.strain_id)
      if (!strainId) continue
      if (!latest.has(strainId)) latest.set(strainId, { name: String(b.name), createdAt: str(b.created_at) })
      if (cycleId && b.room_cycle_id === cycleId) inCycle.add(strainId)
    }

    return ok(
      many(strains.data).map((r) => {
        const id = String(r.id)
        const last = latest.get(id)
        return {
          id,
          name: String(r.name),
          latestBatchName: last?.name ?? null,
          latestBatchCreatedAt: last?.createdAt ?? null,
          hasBatchInCycle: inCycle.has(id),
        }
      })
    )
  } catch (err) {
    return dbFailure('listTrimStrains', err)
  }
}

/**
 * Declare the strains coming out of a room. Atomic and idempotent per cycle (fn_trim_declare_batches);
 * creates batches inactive and writes nothing but `batches`. Open to `grow` so the phase-switcher
 * path can call it.
 */
export async function declareHarvestBatches(input: {
  cycleId: string
  batches: DeclareBatchInput[]
}): Promise<ActionResult<DeclareBatchesResult>> {
  const auth = await requireRole(HARVEST_WEIGH_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.cycleId)) return invalid('Unknown cycle.')
  const list = input.batches
  if (!Array.isArray(list) || list.length < 1 || list.length > 50) {
    return invalid('Declare between 1 and 50 batches.')
  }

  const payload: Array<{ strain_id: string; name: string; harvest_date?: string }> = []
  const seen = new Set<string>()
  for (const b of list) {
    const name = typeof b?.name === 'string' ? b.name.trim() : ''
    if (name.length < 1 || name.length > 64) return invalid('Each batch name must be 1 to 64 characters.')
    if (!isUuid(b.strainId)) return invalid(`Choose a strain for ${name}.`)
    if (b.harvestDate !== undefined && b.harvestDate !== null && !validDate(b.harvestDate)) {
      return invalid(`Harvest date for ${name} must be a valid YYYY-MM-DD date.`)
    }
    if (seen.has(name.toLowerCase())) return invalid(`The name ${name} appears twice. Use a -2 suffix for a split.`)
    seen.add(name.toLowerCase())
    // Only these keys are forwarded, so extra client fields never reach the database.
    payload.push(
      b.harvestDate ? { strain_id: b.strainId, name, harvest_date: b.harvestDate } : { strain_id: b.strainId, name }
    )
  }

  try {
    const res = await callRpc('declareHarvestBatches', 'fn_trim_declare_batches', {
      p_cycle_id: input.cycleId,
      p_batches: payload,
      p_actor: auth.session.userId,
    })
    if (!res.success) return res
    return ok({
      created: many(res.data.created).map(toDeclared),
      skipped: many(res.data.skipped).map(toDeclared),
    })
  } catch (err) {
    return dbFailure('declareHarvestBatches', err)
  }
}

/**
 * Rename / re-date / re-strain a DECLARED batch (inactive, linked to a cycle) that has no loads yet.
 * Legacy and active batches are untouchable here: the write itself is scoped to declared batches.
 */
export async function editDeclaredBatch(input: {
  batchId: string
  name?: string
  harvestDate?: string | null
  strainId?: string
}): Promise<ActionResult<null>> {
  const auth = await requireRole(HARVEST_WEIGH_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.batchId)) return invalid('Unknown batch.')
  const patch: Row = {}
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name.length < 1 || name.length > 64) return invalid('Batch name must be 1 to 64 characters.')
    patch.name = name
  }
  if (input.harvestDate !== undefined) {
    if (input.harvestDate !== null && !validDate(input.harvestDate)) return invalid('Harvest date must be YYYY-MM-DD.')
    patch.harvest_date = input.harvestDate
  }
  if (input.strainId !== undefined) {
    if (!isUuid(input.strainId)) return invalid('Unknown strain.')
    patch.strain_id = input.strainId
  }
  if (Object.keys(patch).length === 0) return invalid('Nothing to change.')

  try {
    const db = await createServiceClient()
    const [loads, clash] = await Promise.all([
      db.from('hanger_loads').select('id').eq('batch_id', input.batchId).limit(1),
      typeof patch.name === 'string'
        ? db
            .from('batches')
            .select('id')
            .ilike('name', patch.name.replace(/[\\%_]/g, '\\$&'))
            .neq('id', input.batchId)
            .limit(1)
        : Promise.resolve({ data: [] as Row[], error: null }),
    ])
    if (loads.error) return dbFailure('editDeclaredBatch', loads.error)
    if (clash.error) return dbFailure('editDeclaredBatch', clash.error)
    if (many(loads.data).length > 0) return fail('This batch already has hangers and can no longer be edited.', 'STATE')
    if (many(clash.data).length > 0) return fail('A batch with that name already exists.', 'DUPLICATE_NAME')

    const { data, error } = await db
      .from('batches')
      .update(patch)
      .eq('id', input.batchId)
      .eq('is_active', false)
      .not('room_cycle_id', 'is', null)
      .select('id')
    if (error) {
      if ((error as DbError).code === '23505') return fail('A batch with that name already exists.', 'DUPLICATE_NAME')
      return dbFailure('editDeclaredBatch', error)
    }
    if (!Array.isArray(data) || data.length !== 1) {
      return fail('Only a declared batch with no hangers can be edited.', 'STATE')
    }

    await logEvent(db, auth.session.userId, 'batch_edited', { batch_id: input.batchId }, { changes: patch })
    return ok(null)
  } catch (err) {
    return dbFailure('editDeclaredBatch', err)
  }
}

/** Delete a declared batch that has no loads. The FK from hanger_loads (RESTRICT) backs the check. */
export async function removeDeclaredBatch(batchId: string): Promise<ActionResult<null>> {
  const auth = await requireRole(HARVEST_WEIGH_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(batchId)) return invalid('Unknown batch.')

  try {
    const db = await createServiceClient()
    const [batch, loads] = await Promise.all([
      db.from('batches').select('id, name').eq('id', batchId).maybeSingle(),
      db.from('hanger_loads').select('id').eq('batch_id', batchId).limit(1),
    ])
    if (batch.error) return dbFailure('removeDeclaredBatch', batch.error)
    if (loads.error) return dbFailure('removeDeclaredBatch', loads.error)
    if (!batch.data) return fail('Batch not found.', 'NOT_FOUND')
    if (many(loads.data).length > 0) return fail('This batch already has hangers and cannot be removed.', 'STATE')

    const { data, error } = await db
      .from('batches')
      .delete()
      .eq('id', batchId)
      .eq('is_active', false)
      .not('room_cycle_id', 'is', null)
      .select('id')
    if (error) {
      if ((error as DbError).code === '23503') return fail('This batch is in use and cannot be removed.', 'STATE')
      return dbFailure('removeDeclaredBatch', error)
    }
    if (!Array.isArray(data) || data.length !== 1) {
      return fail('Only a declared batch with no hangers can be removed.', 'STATE')
    }

    // batch_id stays null on purpose: the row is gone and the FK would reject the audit entry.
    await logEvent(db, auth.session.userId, 'batch_removed', {}, {
      batch_id: batchId,
      batch_name: (batch.data as Row).name,
    })
    return ok(null)
  } catch (err) {
    return dbFailure('removeDeclaredBatch', err)
  }
}

/**
 * Link a legacy batch to a cycle (provenance only). Refuses to move a batch that already has loads
 * to a different cycle. The harvest date defaults to the cycle's, read-only; the cycle is never written.
 */
export async function linkBatchToCycle(
  batchId: string,
  cycleId: string,
  harvestDate?: string
): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(batchId)) return invalid('Unknown batch.')
  if (!isUuid(cycleId)) return invalid('Unknown cycle.')
  if (harvestDate !== undefined && harvestDate !== null && !validDate(harvestDate)) {
    return invalid('Harvest date must be YYYY-MM-DD.')
  }

  try {
    const db = await createServiceClient()
    const [batch, cycle, loads] = await Promise.all([
      db.from('batches').select('id, name, room_cycle_id, harvest_date').eq('id', batchId).maybeSingle(),
      db.from('room_cycles').select('id, harvest_date').eq('id', cycleId).maybeSingle(),
      db.from('hanger_loads').select('id').eq('batch_id', batchId).limit(1),
    ])
    if (batch.error) return dbFailure('linkBatchToCycle', batch.error)
    if (cycle.error) return dbFailure('linkBatchToCycle', cycle.error)
    if (loads.error) return dbFailure('linkBatchToCycle', loads.error)
    if (!batch.data) return fail('Batch not found.', 'NOT_FOUND')
    if (!cycle.data) return fail('Cycle not found.', 'NOT_FOUND')

    const b = batch.data as Row
    const prevCycle = str(b.room_cycle_id)
    if (many(loads.data).length > 0 && prevCycle !== cycleId) {
      return fail('This batch already has hangers under another cycle and cannot be moved.', 'STATE')
    }

    const date = harvestDate ?? str(b.harvest_date) ?? str((cycle.data as Row).harvest_date)
    let query = db.from('batches').update({ room_cycle_id: cycleId, harvest_date: date }).eq('id', batchId)
    // Compare-and-swap on the cycle we validated against.
    query = prevCycle === null ? query.is('room_cycle_id', null) : query.eq('room_cycle_id', prevCycle)
    const { data, error } = await query.select('id')
    if (error) return dbFailure('linkBatchToCycle', error)
    if (!Array.isArray(data) || data.length !== 1) {
      return fail('The batch changed while you were editing it. Reload and try again.', 'STATE')
    }

    await logEvent(db, auth.session.userId, 'batch_linked', { batch_id: batchId }, {
      batch_name: b.name,
      from_cycle_id: prevCycle,
      to_cycle_id: cycleId,
      harvest_date: date,
    })
    return ok(null)
  } catch (err) {
    return dbFailure('linkBatchToCycle', err)
  }
}

// ─── Load transitions ────────────────────────────────────────────────────────

/** Harvest-day weigh-in: creates a `hung` load. BATCH_REQUIRED if the batch is undeclared / its cycle inactive. */
export async function recordHarvestWeight(input: {
  hangerId: string
  batchId: string
  plantCount: number
  wetG: number
}): Promise<ActionResult<HarvestWeightResult>> {
  const auth = await requireRole(HARVEST_WEIGH_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.hangerId)) return invalid('Unknown hanger.')
  if (!isUuid(input.batchId)) return invalid('Choose a batch.')
  const plants = toPlants(input.plantCount)
  if (plants === null) return invalid('Plant count must be a whole number from 1 to 500.')
  const wet = toGrams(input.wetG)
  if (wet === null) return invalid('Enter a wet weight above zero.')

  try {
    const res = await callRpc('recordHarvestWeight', 'fn_trim_create_load', {
      p_hanger_id: input.hangerId,
      p_batch_id: input.batchId,
      p_plant_count: plants,
      p_wet_g: wet,
      p_dry_g: null,
      p_source: 'harvest',
      p_actor: auth.session.userId,
    })
    if (!res.success) return res
    const loadId = str(res.data.id)
    if (!loadId) return fail(GENERIC_ERROR)

    // Running totals are a convenience: a failure here must not turn a recorded weigh-in into an error.
    let batchTotals: HarvestWeightResult['batchTotals'] = null
    try {
      const db = await createServiceClient()
      const { data, error } = await db
        .from('hanger_loads')
        .select('plant_count, wet_g')
        .eq('batch_id', input.batchId)
        .neq('status', 'void')
      if (!error && Array.isArray(data)) {
        batchTotals = {
          hangers: data.length,
          plants: data.reduce((s, r) => s + (num((r as Row).plant_count) ?? 0), 0),
          wetG: roundGrams(data.reduce((s, r) => s + (num((r as Row).wet_g) ?? 0), 0)),
        }
      }
    } catch (err) {
      console.error('[harvest-trim] recordHarvestWeight totals error:', err)
    }
    return ok({ loadId, wetG: wet, batchTotals })
  } catch (err) {
    return dbFailure('recordHarvestWeight', err)
  }
}

/** Late entry at the trim station for a hanger already drying on paper: needs a dry weight, wet optional. */
export async function createLateEntryLoad(input: {
  hangerId: string
  batchId: string
  plantCount?: number
  wetG?: number
  dryG: number
}): Promise<ActionResult<{ loadId: string }>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.hangerId)) return invalid('Unknown hanger.')
  if (!isUuid(input.batchId)) return invalid('Choose a batch.')
  const dry = toGrams(input.dryG)
  if (dry === null) return invalid('Enter a dry weight above zero.')
  let plants: number | null = null
  if (input.plantCount !== undefined && input.plantCount !== null) {
    plants = toPlants(input.plantCount)
    if (plants === null) return invalid('Plant count must be a whole number from 1 to 500.')
  }
  let wet: number | null = null
  if (input.wetG !== undefined && input.wetG !== null) {
    wet = toGrams(input.wetG)
    if (wet === null) return invalid('Wet weight must be above zero.')
  }

  try {
    const res = await callRpc('createLateEntryLoad', 'fn_trim_create_load', {
      p_hanger_id: input.hangerId,
      p_batch_id: input.batchId,
      p_plant_count: plants,
      p_wet_g: wet,
      p_dry_g: dry,
      p_source: 'trim_station',
      p_actor: auth.session.userId,
    })
    if (!res.success) return res
    const loadId = str(res.data.id)
    return loadId ? ok({ loadId }) : fail(GENERIC_ERROR)
  } catch (err) {
    return dbFailure('createLateEntryLoad', err)
  }
}

/** Correct the wet weight and / or plant count while the load is hung or dried. */
export async function correctWetWeight(input: {
  loadId: string
  wetG?: number
  plantCount?: number
}): Promise<ActionResult<null>> {
  const auth = await requireRole(HARVEST_WEIGH_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.loadId)) return invalid('Unknown load.')
  let wet: number | null = null
  if (input.wetG !== undefined && input.wetG !== null) {
    wet = toGrams(input.wetG)
    if (wet === null) return invalid('Wet weight must be above zero.')
  }
  let plants: number | null = null
  if (input.plantCount !== undefined && input.plantCount !== null) {
    plants = toPlants(input.plantCount)
    if (plants === null) return invalid('Plant count must be a whole number from 1 to 500.')
  }
  if (wet === null && plants === null) return invalid('Enter a wet weight and / or a plant count.')

  try {
    const res = await callRpc('correctWetWeight', 'fn_trim_correct_wet', {
      p_load_id: input.loadId,
      p_wet_g: wet,
      p_plant_count: plants,
      p_actor: auth.session.userId,
    })
    return res.success ? ok(null) : res
  } catch (err) {
    return dbFailure('correctWetWeight', err)
  }
}

async function writeDryWeight(label: string, actorId: string, input: { loadId: string; dryG: number }) {
  if (!isUuid(input?.loadId)) return invalid<null>('Unknown load.')
  const dry = toGrams(input.dryG)
  if (dry === null) return invalid<null>('Enter a dry weight above zero.')
  try {
    const res = await callRpc(label, 'fn_trim_record_dry', {
      p_load_id: input.loadId,
      p_dry_g: dry,
      p_actor: actorId,
    })
    return res.success ? ok(null) : res
  } catch (err) {
    return dbFailure<null>(label, err)
  }
}

/** hung -> dried. */
export async function recordDryWeight(input: { loadId: string; dryG: number }): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  return writeDryWeight('recordDryWeight', auth.session.userId, input)
}

/** In-place correction while the load is dried (same DB function; it stays dried). */
export async function correctDryWeight(input: { loadId: string; dryG: number }): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  return writeDryWeight('correctDryWeight', auth.session.userId, input)
}

/**
 * Issue a hanger (or the remainder of a partial one) to a trimmer. The rate is copied inside
 * fn_trim_checkout; it is not a parameter. `dryG` is required while the load is hung and must be
 * omitted otherwise (the DB enforces both).
 */
export async function checkOutLoad(input: {
  loadId: string
  trimmerId: string
  dryG?: number
}): Promise<ActionResult<CheckOutResult>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.loadId)) return invalid('Unknown load.')
  if (!isUuid(input.trimmerId)) return invalid('Choose a trimmer.')
  let dry: number | null = null
  if (input.dryG !== undefined && input.dryG !== null) {
    dry = toGrams(input.dryG)
    if (dry === null) return invalid('Enter a dry weight above zero.')
  }

  try {
    const res = await callRpc('checkOutLoad', 'fn_trim_checkout', {
      p_load_id: input.loadId,
      p_trimmer_id: input.trimmerId,
      p_dry_g: dry,
      p_actor: auth.session.userId,
    })
    if (!res.success) return res
    const co = one(res.data.checkout)
    const load = one(res.data.load)
    if (!co || !load) return fail(GENERIC_ERROR)
    return ok({
      checkoutId: String(co.id),
      seq: Number(co.seq),
      trimmerName: String(co.trimmer_name),
      issuedG: Number(co.issued_g),
      issuedPlantCount: num(co.issued_plant_count),
      loadStatus: load.status as HangerLoadStatus,
    })
  } catch (err) {
    return dbFailure('checkOutLoad', err)
  }
}

/** Take a hanger back from the wrong trimmer. The episode is kept (status released) and excluded from every figure. */
export async function releaseCheckout(input: { checkoutId: string; reason: string }): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.checkoutId)) return invalid('Unknown checkout.')
  const reason = cleanReason(input.reason)
  if (!reason) return invalid('Give a reason of at least 3 characters.')

  try {
    const res = await callRpc('releaseCheckout', 'fn_trim_release', {
      p_checkout_id: input.checkoutId,
      p_reason: reason,
      p_actor: auth.session.userId,
    })
    return res.success ? ok(null) : res
  } catch (err) {
    return dbFailure('releaseCheckout', err)
  }
}

// ─── Check-in / correct return / resolve ─────────────────────────────────────

interface ReturnInput {
  checkoutId: string
  returnKind?: ReturnKind
  flowerG: number
  trimG: number
  stemsG: number
  remainingG?: number
  remainingPlants?: number
}

/**
 * Shared by checkInLoad and correctReturn. Trusts only the raw weights from the client: the issued
 * weight, the rate and the thresholds are read here, the flag decision and the pay come from the
 * pure evaluateVariance() / computePayAmount(), and those are what the DB function receives.
 */
async function submitReturn(
  label: string,
  rpcName: 'fn_trim_checkin' | 'fn_trim_correct_return',
  expectCheckoutStatus: CheckoutStatus,
  actorId: string,
  input: ReturnInput
): Promise<ActionResult<ReturnResult>> {
  if (!isUuid(input?.checkoutId)) return invalid('Unknown checkout.')
  const kind: ReturnKind = input.returnKind ?? 'complete'
  if (kind !== 'complete' && kind !== 'unfinished') return invalid('Return kind must be finished or unfinished.')

  const flower = toGrams(input.flowerG, true)
  const trim = toGrams(input.trimG, true)
  const stems = toGrams(input.stemsG, true)
  if (flower === null || trim === null || stems === null) {
    return invalid('Flower, trim and stems weights must be numbers of zero or more.')
  }

  let remainingG = 0
  let remainingPlants = 0
  if (kind === 'complete') {
    const rg = input.remainingG ?? 0
    const rp = input.remainingPlants ?? 0
    if (rg !== 0 || rp !== 0) return invalid('A finished hanger cannot have weight or plants left on it.')
  } else {
    const rg = toGrams(input.remainingG)
    if (rg === null) return invalid('Enter the weight of the plants left on the hanger.')
    const rp = toPlants(input.remainingPlants)
    if (rp === null) return invalid('Enter how many plants are left (at least 1).')
    remainingG = rg
    remainingPlants = rp
  }

  try {
    const db = await createServiceClient()
    const [coRes, settingsRes] = await Promise.all([
      db
        .from('trim_checkouts')
        .select('id, status, issued_g, issued_plant_count, rate_per_lb_applied')
        .eq('id', input.checkoutId)
        .maybeSingle(),
      db.from('trim_settings').select('variance_pct_threshold, variance_floor_g').eq('id', true).maybeSingle(),
    ])
    if (coRes.error) return dbFailure(label, coRes.error)
    if (settingsRes.error) return dbFailure(label, settingsRes.error)
    if (!coRes.data) return fail('Checkout not found.', 'NOT_FOUND')
    if (!settingsRes.data) {
      console.error(`[harvest-trim] ${label} error: trim_settings row missing`)
      return fail(GENERIC_ERROR)
    }

    const co = coRes.data as Row
    if (co.status !== expectCheckoutStatus) {
      return fail(
        expectCheckoutStatus === 'out'
          ? `This hanger is not checked out (checkout is ${String(co.status)}).`
          : `Only a returned checkout can be corrected (checkout is ${String(co.status)}).`,
        'STATE'
      )
    }
    const issuedG = Number(co.issued_g)
    const issuedPlants = num(co.issued_plant_count)
    if (kind === 'unfinished' && issuedPlants !== null && remainingPlants > issuedPlants) {
      return invalid(`Plants left (${remainingPlants}) cannot exceed plants issued (${issuedPlants}).`)
    }

    const s = settingsRes.data as Row
    const thresholds = {
      pctThreshold: Number(s.variance_pct_threshold),
      floorG: Number(s.variance_floor_g),
    }
    const ev = evaluateVariance({ issuedG, flowerG: flower, trimG: trim, stemsG: stems, remainingG }, thresholds)
    if (!ev.valid) return invalid(ev.message)

    const payAmount = computePayAmount(flower, Number(co.rate_per_lb_applied))

    const res = await callRpc(label, rpcName, {
      p_checkout_id: input.checkoutId,
      p_return_kind: kind,
      p_flower_g: flower,
      p_trim_g: trim,
      p_stems_g: stems,
      p_variance_status: ev.status,
      p_flag_pct: thresholds.pctThreshold,
      p_flag_floor_g: thresholds.floorG,
      p_pay_amount: payAmount,
      p_actor: actorId,
      p_remaining_g: remainingG,
      p_remaining_plants: remainingPlants,
    })
    if (!res.success) return res

    const load = one(res.data.load)
    const checkout = one(res.data.checkout)
    const loadStatus = load ? (load.status as HangerLoadStatus) : null
    if (!load || !checkout || (loadStatus !== 'reconciled' && loadStatus !== 'partial' && loadStatus !== 'returned')) {
      console.error(`[harvest-trim] ${label} error: unexpected rpc shape`)
      return fail(GENERIC_ERROR)
    }

    return ok({
      checkoutId: String(checkout.id),
      loadId: String(load.id),
      loadStatus,
      outcome: loadStatus === 'returned' ? 'flagged' : loadStatus,
      varianceStatus: ev.status,
      returnKind: kind,
      varianceG: ev.varianceG,
      variancePct: ev.variancePct,
      direction: ev.direction,
      totalG: ev.returnedTotalG,
      processedG: ev.processedG,
      remainingG: ev.remainingG,
      remainingPlants,
      plantsFinished: issuedPlants === null ? null : issuedPlants - remainingPlants,
      thresholdPct: thresholds.pctThreshold,
      thresholdFloorG: thresholds.floorG,
      payAmount: ev.status === 'ok' ? payAmount : null,
    })
  } catch (err) {
    return dbFailure(label, err)
  }
}

/** Record what came back. Finished (default) or unfinished with the plants / weight left on the hanger. */
export async function checkInLoad(input: ReturnInput): Promise<ActionResult<ReturnResult>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  return submitReturn('checkInLoad', 'fn_trim_checkin', 'out', auth.session.userId, input)
}

/** Re-weigh the newest returned episode. May change finished <-> unfinished; the flag is re-evaluated. */
export async function correctReturn(input: ReturnInput): Promise<ActionResult<ReturnResult>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  return submitReturn('correctReturn', 'fn_trim_correct_return', 'returned', auth.session.userId, input)
}

/** Accept a flagged return as-is. Needs a reason; the pay is computed here from the stored flower and rate. */
export async function resolveVariance(input: {
  checkoutId: string
  reason: string
}): Promise<ActionResult<{ loadStatus: HangerLoadStatus }>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.checkoutId)) return invalid('Unknown checkout.')
  const reason = cleanReason(input.reason)
  if (!reason) return invalid('Give a reason of at least 3 characters.')

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('trim_checkouts')
      .select('id, status, variance_status, flower_g, rate_per_lb_applied')
      .eq('id', input.checkoutId)
      .maybeSingle()
    if (error) return dbFailure('resolveVariance', error)
    if (!data) return fail('Checkout not found.', 'NOT_FOUND')

    const co = data as Row
    const flower = num(co.flower_g)
    if (co.status !== 'returned' || co.variance_status !== 'flagged' || flower === null) {
      return fail('This return is not flagged, so there is nothing to accept.', 'STATE')
    }

    const res = await callRpc('resolveVariance', 'fn_trim_resolve_variance', {
      p_checkout_id: input.checkoutId,
      p_reason: reason,
      p_pay_amount: computePayAmount(flower, Number(co.rate_per_lb_applied)),
      p_actor: auth.session.userId,
    })
    if (!res.success) return res
    const load = one(res.data.load)
    if (!load) return fail(GENERIC_ERROR)
    return ok({ loadStatus: load.status as HangerLoadStatus })
  } catch (err) {
    return dbFailure('resolveVariance', err)
  }
}

/** Reopen a reconciled load (admin / management). Refused once its pay entry has left `open`. */
export async function reopenLoad(input: { loadId: string; reason: string }): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_ADMIN_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.loadId)) return invalid('Unknown load.')
  const reason = cleanReason(input.reason)
  if (!reason) return invalid('Give a reason of at least 3 characters.')

  try {
    const res = await callRpc('reopenLoad', 'fn_trim_reopen', {
      p_load_id: input.loadId,
      p_reason: reason,
      p_actor: auth.session.userId,
    })
    return res.success ? ok(null) : res
  } catch (err) {
    return dbFailure('reopenLoad', err)
  }
}

/**
 * Void a hung or dried load. A `partial` load is admin / management only: the DB function re-reads
 * the actor's role and raises FORBIDDEN for anyone else, so that rule does not depend on this layer.
 */
export async function voidLoad(input: { loadId: string; reason: string }): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(input?.loadId)) return invalid('Unknown load.')
  const reason = cleanReason(input.reason)
  if (!reason) return invalid('Give a reason of at least 3 characters.')

  try {
    const res = await callRpc('voidLoad', 'fn_trim_void', {
      p_load_id: input.loadId,
      p_reason: reason,
      p_actor: auth.session.userId,
    })
    return res.success ? ok(null) : res
  } catch (err) {
    return dbFailure('voidLoad', err)
  }
}

// ─── The board ───────────────────────────────────────────────────────────────

/**
 * The one read the hub refetches. At most three queries however many hangers there are: the loads
 * (with hanger code, batch, strain and every episode as nested embeds), the cycle's declared batches
 * (cycle scope only, so empty batches show), and the active roster. Nothing fans out per hanger.
 */
export async function getTrimBoard(opts: { cycleId?: string } = {}): Promise<ActionResult<TrimBoard>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  const cycleId = opts?.cycleId
  if (cycleId !== undefined && !isUuid(cycleId)) return invalid('Unknown cycle.')

  try {
    const db = await createServiceClient()

    let loadsQuery = db
      .from('hanger_loads')
      .select(
        'id, status, plant_count, wet_g, dry_g, remaining_g, remaining_plant_count, updated_at, ' +
          'hanger:hangers(code), ' +
          'batch:batches!inner(id, name, harvest_date, room_cycle_id, strain:strains(id, name)), ' +
          'trim_checkouts(id, seq, status, trimmer_id, trimmer_name, issued_g, issued_plant_count, checked_out_at, ' +
          'returned_at, return_kind, flower_g, trim_g, stems_g, remaining_g, variance_g, variance_pct, variance_status)'
      )
      .order('updated_at', { ascending: false })
    loadsQuery = cycleId
      ? loadsQuery.eq('batch.room_cycle_id', cycleId)
      : loadsQuery.not('status', 'in', OPEN_STATUS_FILTER)

    const batchesQuery = cycleId
      ? db
          .from('batches')
          .select('id, name, harvest_date, room_cycle_id, strain:strains(id, name)')
          .eq('room_cycle_id', cycleId)
      : Promise.resolve({ data: [] as Row[], error: null })

    const staffQuery = db
      .from('trim_staff')
      .select('id, full_name, display_name')
      .eq('is_active', true)
      .order('full_name', { ascending: true })

    const [loadsRes, batchesRes, staffRes] = await Promise.all([loadsQuery, batchesQuery, staffQuery])
    if (loadsRes.error) return dbFailure('getTrimBoard', loadsRes.error)
    if (batchesRes.error) return dbFailure('getTrimBoard', batchesRes.error)
    if (staffRes.error) return dbFailure('getTrimBoard', staffRes.error)

    const batches = new Map<string, BoardBatch>()
    const ensureBatch = (b: Row): BoardBatch => {
      const id = String(b.id)
      let entry = batches.get(id)
      if (!entry) {
        const strain = one(b.strain)
        entry = {
          id,
          name: String(b.name),
          harvestDate: str(b.harvest_date),
          strainId: strain ? String(strain.id) : null,
          strainName: strain ? str(strain.name) : null,
          cycleId: str(b.room_cycle_id),
          counts: {},
          loads: 0,
          plants: 0,
          wetG: 0,
          dryG: 0,
          remainingG: 0,
        }
        batches.set(id, entry)
      }
      return entry
    }
    for (const b of many(batchesRes.data)) ensureBatch(b)

    const flagged: BoardFlagged[] = []
    const out: BoardOut[] = []
    const partial: BoardLoad[] = []

    for (const l of many(loadsRes.data)) {
      const batchRow = one(l.batch)
      if (!batchRow) continue
      const b = ensureBatch(batchRow)
      const status = l.status as HangerLoadStatus
      b.counts[status] = (b.counts[status] ?? 0) + 1

      const hangerCode = String(one(l.hanger)?.code ?? '')
      const episodes = many(l.trim_checkouts)
      if (status !== 'void') {
        b.loads++
        b.plants += num(l.plant_count) ?? 0
        b.wetG += num(l.wet_g) ?? 0
        b.dryG += num(l.dry_g) ?? 0
        if (status !== 'reconciled') b.remainingG += num(l.remaining_g) ?? 0
      }

      if (status === 'checked_out') {
        const co = episodes.find((e) => e.status === 'out')
        if (co) {
          out.push({
            loadId: String(l.id),
            checkoutId: String(co.id),
            hangerCode,
            batchId: b.id,
            batchName: b.name,
            trimmerId: String(co.trimmer_id),
            trimmerName: String(co.trimmer_name),
            issuedG: Number(co.issued_g),
            issuedPlantCount: num(co.issued_plant_count),
            checkedOutAt: String(co.checked_out_at),
          })
        }
      } else if (status === 'returned') {
        const newest = episodes
          .filter((e) => e.status === 'returned')
          .sort((a, c) => Number(c.seq) - Number(a.seq))[0]
        if (newest) {
          flagged.push({
            loadId: String(l.id),
            checkoutId: String(newest.id),
            hangerCode,
            batchId: b.id,
            batchName: b.name,
            trimmerName: String(newest.trimmer_name),
            returnKind: (str(newest.return_kind) as ReturnKind | null) ?? null,
            issuedG: Number(newest.issued_g),
            flowerG: num(newest.flower_g),
            trimG: num(newest.trim_g),
            stemsG: num(newest.stems_g),
            remainingG: num(newest.remaining_g),
            varianceG: num(newest.variance_g),
            variancePct: num(newest.variance_pct),
            returnedAt: str(newest.returned_at),
          })
        }
      } else if (status === 'partial') {
        partial.push({
          loadId: String(l.id),
          hangerCode,
          status,
          batchId: b.id,
          batchName: b.name,
          plantCount: num(l.plant_count),
          dryG: num(l.dry_g),
          remainingG: num(l.remaining_g),
          remainingPlants: num(l.remaining_plant_count),
          updatedAt: String(l.updated_at),
        })
      }
    }

    const roster = new Map<string, BoardTrimmer>()
    for (const s of many(staffRes.data)) {
      roster.set(String(s.id), {
        id: String(s.id),
        name: str(s.display_name) ?? String(s.full_name),
        hangersOut: 0,
        gramsOut: 0,
      })
    }
    for (const o of out) {
      const t = roster.get(o.trimmerId)
      if (t) {
        t.hangersOut++
        t.gramsOut = roundGrams(t.gramsOut + o.issuedG)
      }
    }

    const batchList = [...batches.values()].map((b) => ({
      ...b,
      wetG: roundGrams(b.wetG),
      dryG: roundGrams(b.dryG),
      remainingG: roundGrams(b.remainingG),
    }))
    batchList.sort((a, b) => a.name.localeCompare(b.name))

    return ok({
      scope: cycleId ? 'cycle' : 'open_work',
      cycleId: cycleId ?? null,
      batches: batchList,
      flagged,
      out,
      partial,
      trimmers: [...roster.values()],
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    return dbFailure('getTrimBoard', err)
  }
}

/** Audit trail and custody episodes for one load. Dollar fields are stripped for roles without pay access. */
export async function getLoadHistory(loadId: string): Promise<ActionResult<LoadHistory>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (!isUuid(loadId)) return invalid('Unknown load.')
  const seesMoney = roleAllowed(TRIM_PAY_APPROVE_ROLES, auth.session.role)

  try {
    const db = await createServiceClient()
    const [eventsRes, episodesRes] = await Promise.all([
      db
        .from('trim_events')
        .select('id, occurred_at, actor_user_id, event_type, hanger_id, load_id, checkout_id, batch_id, payload')
        .eq('load_id', loadId)
        .order('occurred_at', { ascending: true })
        .order('id', { ascending: true }),
      db.from('trim_checkouts').select(EPISODE_COLS).eq('load_id', loadId).order('seq', { ascending: true }),
    ])
    if (eventsRes.error) return dbFailure('getLoadHistory', eventsRes.error)
    if (episodesRes.error) return dbFailure('getLoadHistory', episodesRes.error)

    const events: TrimEvent[] = many(eventsRes.data).map((e) => {
      const payload = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>
      return {
        id: Number(e.id),
        occurred_at: String(e.occurred_at),
        actor_user_id: str(e.actor_user_id),
        event_type: String(e.event_type),
        hanger_id: str(e.hanger_id),
        load_id: str(e.load_id),
        checkout_id: str(e.checkout_id),
        batch_id: str(e.batch_id),
        payload: (seesMoney ? payload : redactPayload(payload)) as Record<string, unknown>,
      }
    })
    return ok({ events, episodes: many(episodesRes.data).map(toEpisode) })
  } catch (err) {
    return dbFailure('getLoadHistory', err)
  }
}

// ─── Variance settings ───────────────────────────────────────────────────────

function toSettings(r: Row): TrimSettings {
  return {
    variance_pct_threshold: Number(r.variance_pct_threshold),
    variance_floor_g: Number(r.variance_floor_g),
    updated_by: str(r.updated_by),
    updated_at: String(r.updated_at),
  }
}

export async function getTrimSettings(): Promise<ActionResult<TrimSettings>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('trim_settings')
      .select('variance_pct_threshold, variance_floor_g, updated_by, updated_at')
      .eq('id', true)
      .maybeSingle()
    if (error) return dbFailure('getTrimSettings', error)
    if (!data) return fail('Trim settings are missing.', 'NOT_FOUND')
    return ok(toSettings(data as Row))
  } catch (err) {
    return dbFailure('getTrimSettings', err)
  }
}

/** Change the flag thresholds (admin / management). Applies to future check-ins; each is snapshotted on its checkout. */
export async function updateTrimSettings(patch: {
  variancePctThreshold?: number
  varianceFloorG?: number
}): Promise<ActionResult<TrimSettings>> {
  const auth = await requireRole(TRIM_ADMIN_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  const update: Row = {}
  if (patch?.variancePctThreshold !== undefined) {
    const p = patch.variancePctThreshold
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
      return invalid('The percent threshold must be between 0 and 100.')
    }
    update.variance_pct_threshold = Math.round(p * 100) / 100
  }
  if (patch?.varianceFloorG !== undefined) {
    const f = patch.varianceFloorG
    if (typeof f !== 'number' || !Number.isFinite(f) || f < 0 || f > 10000) {
      return invalid('The gram floor must be between 0 and 10000.')
    }
    update.variance_floor_g = roundGrams(f)
  }
  if (Object.keys(update).length === 0) return invalid('Nothing to change.')

  try {
    const db = await createServiceClient()
    const { data: before, error: beforeErr } = await db
      .from('trim_settings')
      .select('variance_pct_threshold, variance_floor_g')
      .eq('id', true)
      .maybeSingle()
    if (beforeErr) return dbFailure('updateTrimSettings', beforeErr)

    const { data, error } = await db
      .from('trim_settings')
      .update({ ...update, updated_by: auth.session.userId })
      .eq('id', true)
      .select('variance_pct_threshold, variance_floor_g, updated_by, updated_at')
    if (error) return dbFailure('updateTrimSettings', error)
    if (!Array.isArray(data) || data.length !== 1) {
      console.error('[harvest-trim] updateTrimSettings error: zero rows updated')
      return fail('The settings were not saved. Please try again.')
    }

    await logEvent(db, auth.session.userId, 'settings_updated', {}, { before: before ?? null, after: update })
    return ok(toSettings(data[0] as Row))
  } catch (err) {
    return dbFailure('updateTrimSettings', err)
  }
}
