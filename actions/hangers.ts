'use server'

// Harvest & Trim: the hanger registry and the scan / lookup reads.
//
// Authorization is enforced HERE and nowhere else (RLS is not a backstop in this app): every exported
// function calls requireRole() before it touches the database. The actor is always
// auth.session.userId; no action accepts a person id from the client.
//
// A 'use server' module may only export async functions (scripts/check-server-exports.mjs fails the
// build on re-exports). Type declarations are erased and fine; shared constants live in lib/trim/*.

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { TRIM_OPS_ROLES, TRIM_PAY_APPROVE_ROLES, TRIM_VIEW_ROLES, roleAllowed } from '@/lib/trim/roles'
import {
  DEFAULT_HANGER_PREFIX,
  HANGER_DIGITS,
  MAX_HANGER_SEQ,
  parseHangerCodeLenient,
  parseHangerCodeStrict,
} from '@/lib/trim/hanger-code'
import { parseHangerImport, type HangerImportRejectReason } from '@/lib/trim/hanger-import'
import { GENERIC_ERROR, dbFailure, denied, fail, invalid, type DbError } from '@/lib/trim/db-errors'
import type {
  ActionResult,
  CheckoutStatus,
  HangerLoadStatus,
  HangerStatus,
  LoadSource,
  ReturnKind,
  ScanNextStep,
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

// ─── Types ───────────────────────────────────────────────────────────────────

/** wedge / camera read exactly what is printed (strict); typed entry is forgiven (lenient). */
export type ScanSource = 'wedge' | 'camera' | 'typed'

export interface ScanHanger {
  id: string
  code: string
  labelSeq: number
  status: HangerStatus
  notes: string | null
}

export interface ScanBatch {
  id: string
  name: string
  harvestDate: string | null
  strainId: string | null
  strainName: string | null
  cycleId: string | null
  cycleNumber: number | null
  cycleStatus: string | null
  cycleStage: string | null
  roomName: string | null
  roomNumber: number | null
}

/** One custody episode. Never carries a rate or any dollar figure. */
export interface ScanEpisode {
  id: string
  seq: number
  trimmerId: string
  trimmerName: string
  status: CheckoutStatus
  issuedG: number
  issuedPlantCount: number | null
  checkedOutAt: string
  returnedAt: string | null
  returnKind: ReturnKind | null
  flowerG: number | null
  trimG: number | null
  stemsG: number | null
  remainingG: number | null
  remainingPlantCount: number | null
  plantsFinished: number | null
  processedG: number | null
  returnedTotalG: number | null
  varianceG: number | null
  variancePct: number | null
  flagPctApplied: number | null
  flagFloorGApplied: number | null
  varianceStatus: VarianceStatus | null
  varianceReason: string | null
  releasedAt: string | null
  releaseReason: string | null
}

export interface ScanLoad {
  id: string
  status: HangerLoadStatus
  source: LoadSource
  plantCount: number | null
  wetG: number | null
  wetRecordedAt: string | null
  dryG: number | null
  dryRecordedAt: string | null
  remainingG: number | null
  remainingPlantCount: number | null
  createdAt: string
  updatedAt: string
  reconciledAt: string | null
  voidedAt: string | null
  voidReason: string | null
  batch: ScanBatch | null
  /** Oldest first. */
  episodes: ScanEpisode[]
}

export interface ScanResult {
  hanger: ScanHanger
  /** The open load (anything but reconciled / void), if any. */
  openLoad: ScanLoad | null
  /** The most recent finished load when there is no open one; null for a never-used hanger. */
  lastClosedLoad: ScanLoad | null
  /** The episode currently holding the open load (status 'out'), if any. */
  checkout: ScanEpisode | null
  /** Batch of whichever load is shown (open, else last closed). */
  batch: ScanBatch | null
  /** True when a new load can be started on this hanger (active and nothing open). */
  canStartLoad: boolean
  /** A hint for routing the station; the payload above is the point of the call (R2.9b). */
  nextStep: ScanNextStep
}

export interface LookupEvent {
  id: number
  occurredAt: string
  actorUserId: string | null
  actorName: string | null
  eventType: string
  loadId: string | null
  checkoutId: string | null
  batchId: string | null
  payload: Record<string, unknown>
}

export interface HangerLookup {
  hanger: ScanHanger
  /** Every load this tag has ever carried, newest first, each with its episodes. */
  loads: ScanLoad[]
  /** Newest first, capped at LOOKUP_EVENT_LIMIT. Dollar fields are stripped for roles without pay access. */
  events: LookupEvent[]
  openLoadId: string | null
  checkout: ScanEpisode | null
  nextStep: ScanNextStep
  canStartLoad: boolean
}

export interface HangerRow {
  id: string
  code: string
  labelSeq: number
  status: HangerStatus
  notes: string | null
  /** Latest load (open if any), for "last used batch" and the open flag. */
  latestLoad: { id: string; status: HangerLoadStatus; batchId: string; batchName: string | null } | null
  hasOpenLoad: boolean
}

export interface CreateHangersResult {
  start: number
  inserted: number
  skipped: number
  codes: string[]
}

export type ImportRejectReason = HangerImportRejectReason | 'width_collision'

export interface ImportReject {
  line: number
  raw: string
  reason: ImportRejectReason
  message: string
}

/**
 * Three outcomes, kept apart on purpose: `newCodes`/`insertedCodes` (written), `skippedCodes`
 * (already registered under the same code: the benign idempotent re-import) and `rejected`
 * (failed validation, or the same tag number exists at a different digit width: needs attention).
 */
export interface HangerImportReport {
  mode: 'preview' | 'imported'
  rowCount: number
  headerSkipped: boolean
  truncated: boolean
  nonStandardPrefixes: string[]
  rejected: ImportReject[]
  /** Codes that are new (preview: would be inserted; imported: the ones attempted). */
  newCodes: string[]
  skippedCodes: string[]
  /** null in preview. */
  insertedCodes: string[] | null
  inserted: number | null
  /** skipped = already registered + any lost to a concurrent import. */
  skipped: number
}

// ─── Column lists ────────────────────────────────────────────────────────────

const HANGER_COLS = 'id, code, label_seq, status, notes'

const EPISODE_COLS =
  'id, seq, trimmer_id, trimmer_name, status, issued_g, issued_plant_count, checked_out_at, returned_at, ' +
  'return_kind, flower_g, trim_g, stems_g, remaining_g, remaining_plant_count, plants_finished, processed_g, ' +
  'returned_total_g, variance_g, variance_pct, flag_pct_applied, flag_floor_g_applied, variance_status, ' +
  'variance_reason, released_at, release_reason'

const BATCH_EMBED =
  'batch:batches(id, name, harvest_date, strain:strains(id, name), ' +
  'cycle:room_cycles(id, cycle_number, status, current_stage, room:grow_rooms(room_name, room_number)))'

const LOAD_COLS =
  'id, status, source, plant_count, wet_g, wet_recorded_at, dry_g, dry_recorded_at, remaining_g, ' +
  'remaining_plant_count, created_at, updated_at, reconciled_at, voided_at, void_reason'

const LOAD_SELECT = `${LOAD_COLS}, ${BATCH_EMBED}, trim_checkouts(${EPISODE_COLS})`

const CLOSED_STATUSES: HangerLoadStatus[] = ['reconciled', 'void']
const LOOKUP_EVENT_LIMIT = 200
const MAX_IMPORT_TEXT_CHARS = 200_000

// ─── Row mappers ─────────────────────────────────────────────────────────────

function toHanger(r: Row): ScanHanger {
  return {
    id: String(r.id),
    code: String(r.code),
    labelSeq: Number(r.label_seq),
    status: r.status as HangerStatus,
    notes: str(r.notes),
  }
}

function toBatch(r: Row | null): ScanBatch | null {
  if (!r) return null
  const strain = one(r.strain)
  const cycle = one(r.cycle)
  const room = cycle ? one(cycle.room) : null
  return {
    id: String(r.id),
    name: String(r.name),
    harvestDate: str(r.harvest_date),
    strainId: strain ? String(strain.id) : null,
    strainName: strain ? str(strain.name) : null,
    cycleId: cycle ? String(cycle.id) : null,
    cycleNumber: cycle ? num(cycle.cycle_number) : null,
    cycleStatus: cycle ? str(cycle.status) : null,
    cycleStage: cycle ? str(cycle.current_stage) : null,
    roomName: room ? str(room.room_name) : null,
    roomNumber: room ? num(room.room_number) : null,
  }
}

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

function toLoad(r: Row): ScanLoad {
  return {
    id: String(r.id),
    status: r.status as HangerLoadStatus,
    source: r.source as LoadSource,
    plantCount: num(r.plant_count),
    wetG: num(r.wet_g),
    wetRecordedAt: str(r.wet_recorded_at),
    dryG: num(r.dry_g),
    dryRecordedAt: str(r.dry_recorded_at),
    remainingG: num(r.remaining_g),
    remainingPlantCount: num(r.remaining_plant_count),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    reconciledAt: str(r.reconciled_at),
    voidedAt: str(r.voided_at),
    voidReason: str(r.void_reason),
    batch: toBatch(one(r.batch)),
    episodes: many(r.trim_checkouts)
      .map(toEpisode)
      .sort((a, b) => a.seq - b.seq),
  }
}

function isOpen(status: HangerLoadStatus): boolean {
  return !CLOSED_STATUSES.includes(status)
}

function nextStepFor(hanger: ScanHanger, load: ScanLoad | null): ScanNextStep {
  if (hanger.status !== 'active') return 'inactive'
  if (!load) return 'new_load'
  switch (load.status) {
    case 'hung':
      return 'record_dry'
    case 'dried':
      return 'checkout'
    case 'checked_out':
      return 'checkin'
    case 'partial':
      return 'reissue'
    case 'returned':
      return 'resolve_variance'
    default:
      return 'closed_out'
  }
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

function parseScan(rawCode: unknown, source: unknown): { ok: true; code: string } | { ok: false; message: string } {
  if (typeof rawCode !== 'string') return { ok: false, message: 'Enter a hanger code.' }
  if (source !== 'wedge' && source !== 'camera' && source !== 'typed') {
    return { ok: false, message: 'Unknown scan source.' }
  }
  const parsed = source === 'typed' ? parseHangerCodeLenient(rawCode) : parseHangerCodeStrict(rawCode)
  return parsed.ok ? { ok: true, code: parsed.code } : { ok: false, message: parsed.message }
}

// ─── resolveScan: the hot path (one round trip) ──────────────────────────────

/**
 * Scan or type a code and get the hanger's full status payload plus a routing hint. ONE query: the
 * hanger, its newest load (the open one when there is one: a second open load is impossible), that
 * load's batch / strain / room / cycle and all of its custody episodes are fetched as nested embeds.
 */
export async function resolveScan(rawCode: string, source: ScanSource): Promise<ActionResult<ScanResult>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  const parsed = parseScan(rawCode, source)
  if (!parsed.ok) return invalid(parsed.message)

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('hangers')
      .select(`${HANGER_COLS}, hanger_loads(${LOAD_SELECT})`)
      .eq('code', parsed.code)
      .order('created_at', { ascending: false, referencedTable: 'hanger_loads' })
      .limit(1, { referencedTable: 'hanger_loads' })
      .maybeSingle()
    if (error) return dbFailure('resolveScan', error)
    if (!data) return fail(`${parsed.code} is not in the hanger registry.`, 'NOT_FOUND')

    const row = data as Row
    const hanger = toHanger(row)
    const latestRow = many(row.hanger_loads)[0]
    const latest = latestRow ? toLoad(latestRow) : null
    const openLoad = latest && isOpen(latest.status) ? latest : null
    const lastClosedLoad = latest && !openLoad ? latest : null
    const shown = openLoad ?? lastClosedLoad

    return ok({
      hanger,
      openLoad,
      lastClosedLoad,
      checkout: openLoad?.episodes.find((e) => e.status === 'out') ?? null,
      batch: shown?.batch ?? null,
      canStartLoad: hanger.status === 'active' && !openLoad,
      nextStep: nextStepFor(hanger, latest),
    })
  } catch (err) {
    return dbFailure('resolveScan', err)
  }
}

/**
 * "Tell me what this tag is" (R2.9b): every load the tag has carried, with all episodes, plus the
 * audit trail. Works in every state, including never-used, reconciled, void and retired.
 */
export async function lookupHanger(rawCode: string, source: ScanSource = 'typed'): Promise<ActionResult<HangerLookup>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  const parsed = parseScan(rawCode, source)
  if (!parsed.ok) return invalid(parsed.message)
  const seesMoney = roleAllowed(TRIM_PAY_APPROVE_ROLES, auth.session.role)

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('hangers')
      .select(
        `${HANGER_COLS}, hanger_loads(${LOAD_SELECT}), ` +
          'trim_events(id, occurred_at, actor_user_id, event_type, load_id, checkout_id, batch_id, payload, actor:users(name))'
      )
      .eq('code', parsed.code)
      .order('created_at', { ascending: false, referencedTable: 'hanger_loads' })
      .order('occurred_at', { ascending: false, referencedTable: 'trim_events' })
      .limit(LOOKUP_EVENT_LIMIT, { referencedTable: 'trim_events' })
      .maybeSingle()
    if (error) return dbFailure('lookupHanger', error)
    if (!data) return fail(`${parsed.code} is not in the hanger registry.`, 'NOT_FOUND')

    const row = data as unknown as Row
    const hanger = toHanger(row)
    const loads = many(row.hanger_loads)
      .map(toLoad)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    const open = loads.find((l) => isOpen(l.status)) ?? null
    const events: LookupEvent[] = many(row.trim_events).map((e) => {
      const payload = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>
      return {
        id: Number(e.id),
        occurredAt: String(e.occurred_at),
        actorUserId: str(e.actor_user_id),
        actorName: str(one(e.actor)?.name),
        eventType: String(e.event_type),
        loadId: str(e.load_id),
        checkoutId: str(e.checkout_id),
        batchId: str(e.batch_id),
        payload: (seesMoney ? payload : redactPayload(payload)) as Record<string, unknown>,
      }
    })

    return ok({
      hanger,
      loads,
      events,
      openLoadId: open?.id ?? null,
      checkout: open?.episodes.find((e) => e.status === 'out') ?? null,
      nextStep: nextStepFor(hanger, loads[0] ?? null),
      canStartLoad: hanger.status === 'active' && !open,
    })
  } catch (err) {
    return dbFailure('lookupHanger', err)
  }
}

// ─── Registry reads ──────────────────────────────────────────────────────────

export async function listHangers(
  opts: { status?: HangerStatus; search?: string } = {}
): Promise<ActionResult<HangerRow[]>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  const status = opts?.status
  if (status !== undefined && status !== 'active' && status !== 'retired' && status !== 'lost') {
    return invalid('Unknown hanger status.')
  }
  const search =
    typeof opts?.search === 'string' ? opts.search.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20) : ''

  try {
    const db = await createServiceClient()
    // One query: each hanger with its single newest load (which is the open one when there is one).
    let query = db
      .from('hangers')
      .select(`${HANGER_COLS}, hanger_loads(id, status, batch_id, created_at, batch:batches(name))`)
      .order('label_seq', { ascending: true })
      .order('created_at', { ascending: false, referencedTable: 'hanger_loads' })
      .limit(1, { referencedTable: 'hanger_loads' })
    if (status) query = query.eq('status', status)
    if (search) query = query.ilike('code', `%${search}%`)

    const { data, error } = await query
    if (error) return dbFailure('listHangers', error)

    const rows: HangerRow[] = many(data).map((r) => {
      const h = toHanger(r)
      const l = many(r.hanger_loads)[0]
      const loadStatus = l ? (l.status as HangerLoadStatus) : null
      return {
        ...h,
        latestLoad: l
          ? {
              id: String(l.id),
              status: l.status as HangerLoadStatus,
              batchId: String(l.batch_id),
              batchName: str(one(l.batch)?.name),
            }
          : null,
        hasOpenLoad: loadStatus !== null && isOpen(loadStatus),
      }
    })
    return ok(rows)
  } catch (err) {
    return dbFailure('listHangers', err)
  }
}

// ─── Registry writes ─────────────────────────────────────────────────────────

/** Convenience seeder: the next `count` sequential IDs after the highest registered H1B number. */
export async function createHangers(count: number): Promise<ActionResult<CreateHangersResult>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!Number.isInteger(count) || count < 1 || count > MAX_HANGER_SEQ) {
    return invalid(`Enter a count between 1 and ${MAX_HANGER_SEQ}.`)
  }

  try {
    const db = await createServiceClient()
    const { data: top, error: topErr } = await db
      .from('hangers')
      .select('label_seq')
      .like('code', `${DEFAULT_HANGER_PREFIX}%`)
      .order('label_seq', { ascending: false })
      .limit(1)
    if (topErr) return dbFailure('createHangers', topErr)

    const start = (num(many(top)[0]?.label_seq) ?? 0) + 1
    if (start + count - 1 > MAX_HANGER_SEQ) {
      return invalid(
        `That would run past ${DEFAULT_HANGER_PREFIX}${MAX_HANGER_SEQ} (next free number is ${start}). Ask for a smaller batch.`
      )
    }

    const { data, error } = await db.rpc('fn_create_hangers', {
      p_prefix: DEFAULT_HANGER_PREFIX,
      p_start: start,
      p_count: count,
      p_digits: HANGER_DIGITS,
      p_actor: auth.session.userId,
    })
    if (error) return dbFailure('createHangers', error)
    if (!data || typeof data !== 'object') return fail(GENERIC_ERROR)

    const d = data as Row
    return ok({
      start,
      inserted: Number(d.inserted ?? 0),
      skipped: Number(d.skipped ?? 0),
      codes: Array.isArray(d.codes) ? (d.codes as string[]) : [],
    })
  } catch (err) {
    return dbFailure('createHangers', err)
  }
}

/**
 * R2.13: load the IDs printed by the standalone label tool. `confirm: false` (default) previews
 * without writing; `confirm: true` re-parses the same text SERVER-SIDE and writes.
 *
 * Writes are one bulk `INSERT ... ON CONFLICT (code) DO NOTHING`. That clause does not cover the
 * second unique index (prefix, label_seq): H1B-042 and H1B-0042 are different codes but the same tag
 * number, and one such row would abort the whole statement. So the incoming (prefix, number) pairs
 * are checked against the registry first (one read), collisions become per-row rejects, and only
 * the clean remainder is inserted. label_seq is always the value parseHangerImport derived from the
 * code's numeric tail, which is what the hangers_seq_matches_code CHECK requires.
 */
export async function importHangers(input: {
  text: string
  confirm?: boolean
}): Promise<ActionResult<HangerImportReport>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  const text = input?.text
  if (typeof text !== 'string' || text.trim() === '') return invalid('Paste or upload a list of hanger IDs.')
  if (text.length > MAX_IMPORT_TEXT_CHARS) return invalid('That list is too large to import.')
  const confirm = input.confirm === true

  const parsed = parseHangerImport(text)
  const rejected: ImportReject[] = [...parsed.rejected]

  try {
    const db = await createServiceClient()
    const { data: existing, error: existingErr } = await db.from('hangers').select('code, label_seq')
    if (existingErr) return dbFailure('importHangers', existingErr)

    const tail = (code: string) => code.replace(/[0-9]+$/, '')
    const existingCodes = new Set<string>()
    const existingByKey = new Map<string, string>()
    for (const r of many(existing)) {
      const code = String(r.code)
      existingCodes.add(code)
      existingByKey.set(`${tail(code)}|${Number(r.label_seq)}`, code)
    }

    const toInsert: Array<{ code: string; label_seq: number; created_by: string }> = []
    const skippedCodes: string[] = []
    // 1-based line of each code's first appearance, so a collision can point at the pasted row.
    const lineByCode = new Map<string, number>()
    text.split(/\r\n|\r|\n/).forEach((l, i) => {
      const first = l.split(/[,;\t]/)[0].trim().replace(/^"(.*)"$/, '$1').trim().toUpperCase()
      if (first && !lineByCode.has(first)) lineByCode.set(first, i + 1)
    })
    for (const row of parsed.accepted) {
      if (existingCodes.has(row.code)) {
        skippedCodes.push(row.code)
        continue
      }
      const clash = existingByKey.get(`${tail(row.code)}|${row.labelSeq}`)
      if (clash) {
        rejected.push({
          line: lineByCode.get(row.code) ?? 0,
          raw: row.code,
          reason: 'width_collision',
          message: `${row.code}: same tag number already registered at a different digit width (${clash}).`,
        })
        continue
      }
      toInsert.push({ code: row.code, label_seq: row.labelSeq, created_by: auth.session.userId })
    }

    const base = {
      rowCount: parsed.rowCount,
      headerSkipped: parsed.headerSkipped,
      truncated: parsed.truncated,
      nonStandardPrefixes: parsed.nonStandardPrefixes,
      rejected,
      newCodes: toInsert.map((r) => r.code),
      skippedCodes,
    }

    if (!confirm) {
      return ok({ mode: 'preview', ...base, insertedCodes: null, inserted: null, skipped: skippedCodes.length })
    }

    let insertedCodes: string[] = []
    if (toInsert.length > 0) {
      const { data: written, error } = await db
        .from('hangers')
        .upsert(toInsert, { onConflict: 'code', ignoreDuplicates: true })
        .select('code')
      if (error) {
        const hay = `${(error as DbError).message ?? ''} ${(error as DbError).details ?? ''}`
        if ((error as DbError).code === '23505' && hay.includes('uidx_hangers_prefix_seq')) {
          return fail('The registry changed while importing (a tag number now exists at another digit width). Preview again.', 'STATE')
        }
        return dbFailure('importHangers', error)
      }
      if (!Array.isArray(written)) return fail(GENERIC_ERROR)
      // Fewer rows than attempted means a concurrent import registered some first: reported as skipped.
      insertedCodes = written.map((r) => String((r as Row).code))
    }

    const skipped = skippedCodes.length + (toInsert.length - insertedCodes.length)
    await logEvent(db, auth.session.userId, 'hangers_imported', {}, {
      inserted: insertedCodes.length,
      skipped,
      rejected: rejected.length,
    })
    return ok({ mode: 'imported', ...base, insertedCodes, inserted: insertedCodes.length, skipped })
  } catch (err) {
    return dbFailure('importHangers', err)
  }
}

/** Retire / mark lost / reactivate. Refuses to retire or lose a hanger that has an open load. */
export async function setHangerStatus(
  hangerId: string,
  status: HangerStatus,
  reason?: string
): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(hangerId)) return invalid('Unknown hanger.')
  if (status !== 'active' && status !== 'retired' && status !== 'lost') return invalid('Unknown hanger status.')
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) return invalid('Reason is too long.')

  try {
    const db = await createServiceClient()
    const [hangerRes, openRes] = await Promise.all([
      db.from('hangers').select('id, code, status').eq('id', hangerId).maybeSingle(),
      db
        .from('hanger_loads')
        .select('id')
        .eq('hanger_id', hangerId)
        .not('status', 'in', '(reconciled,void)')
        .limit(1),
    ])
    if (hangerRes.error) return dbFailure('setHangerStatus', hangerRes.error)
    if (openRes.error) return dbFailure('setHangerStatus', openRes.error)
    if (!hangerRes.data) return fail('Hanger not found.', 'NOT_FOUND')

    const hanger = hangerRes.data as Row
    const previous = String(hanger.status)
    if (previous === status) return ok(null)
    if (status !== 'active' && many(openRes.data).length > 0) {
      return fail(`${hanger.code} has an open load. Finish or void it before retiring the hanger.`, 'STATE')
    }

    const { data, error } = await db
      .from('hangers')
      .update({ status })
      .eq('id', hangerId)
      .eq('status', previous)
      .select('id')
    if (error) return dbFailure('setHangerStatus', error)
    if (!Array.isArray(data) || data.length !== 1) {
      return fail('The hanger changed while you were editing it. Reload and try again.', 'STATE')
    }

    await logEvent(db, auth.session.userId, 'hanger_status_changed', { hanger_id: hangerId }, {
      hanger_code: hanger.code,
      from: previous,
      to: status,
      reason: reason?.trim() || null,
    })
    return ok(null)
  } catch (err) {
    return dbFailure('setHangerStatus', err)
  }
}
