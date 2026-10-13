'use server'

// Harvest & Trim: trim staff (non-login trimmers), their pay rate and their finance vendor mapping.
//
// Authorization is enforced HERE (RLS is not a backstop): every exported function calls requireRole()
// first. The actor is always auth.session.userId.
//
// Pay rates are set by whoever hires (TRIM_STAFF_ADMIN_ROLES includes trim_manager, R2.15). Every
// change is written to trim_events with the old and new value, and the rate is snapshotted onto the
// checkout by fn_trim_checkout, so a change can never reach work already issued.
//
// A 'use server' module may only export async functions (scripts/check-server-exports.mjs fails the
// build on re-exports). Type declarations are erased and fine.

import { requireRole } from '@/lib/auth/session'
import { createServiceClient } from '@/lib/supabase/server'
import { TRIM_OPS_ROLES, TRIM_STAFF_ADMIN_ROLES, TRIM_VIEW_ROLES, roleAllowed } from '@/lib/trim/roles'
import { isValidRate } from '@/lib/trim/pay'
import { roundCents } from '@/lib/units'
import {
  GENERIC_ERROR,
  dbFailure as sharedDbFailure,
  denied,
  fail,
  invalid,
  type ConstraintRule,
} from '@/lib/trim/db-errors'
import type { ActionResult } from '@/types/harvest-trim'

// ─── Shared plumbing (error mapping lives in lib/trim/db-errors.ts; a 'use server' file cannot export helpers) ───

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

function ok<T>(data: T): ActionResult<T> {
  return { success: true, data }
}

const DUPLICATE_STAFF_MESSAGE = 'An active trimmer with that name already exists.'

/** Table-specific violations on top of the shared ones in lib/trim/db-errors.ts. */
const STAFF_CONSTRAINT_RULES: readonly ConstraintRule[] = [
  { sqlState: '23505', match: 'uidx_trim_staff_active_name', message: DUPLICATE_STAFF_MESSAGE, code: 'INVALID' },
  { sqlState: '23503', match: 'vendor', message: 'That vendor does not exist.', code: 'INVALID' },
]

function dbFailure<T>(fn: string, err: unknown): ActionResult<T> {
  return sharedDbFailure<T>(fn, err, STAFF_CONSTRAINT_RULES)
}

/** Audit row for a direct write. Best effort: the write it describes has already happened. */
async function logEvent(
  db: Awaited<ReturnType<typeof createServiceClient>>,
  actorId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const { error } = await db
      .from('trim_events')
      .insert({ actor_user_id: actorId, event_type: eventType, payload })
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

function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Contact details, notes, vendor and pay rate are only populated for TRIM_STAFF_ADMIN_ROLES; other
 * viewers (grow) get names and active state with the rest null.
 */
export interface TrimStaffRow {
  id: string
  fullName: string
  displayName: string | null
  isActive: boolean
  startDate: string | null
  phone: string | null
  email: string | null
  payPerLb: number | null
  vendorId: string | null
  vendorName: string | null
  notes: string | null
}

export interface RateChange {
  occurredAt: string
  actorUserId: string | null
  oldRate: number | null
  newRate: number | null
}

export interface TrimStaffDetail extends TrimStaffRow {
  createdAt: string
  updatedAt: string
  /** Newest first; null for viewers without rate access. */
  rateHistory: RateChange[] | null
}

export interface VendorOption {
  id: string
  name: string
  category: string | null
}

export interface TrimStaffInput {
  fullName: string
  displayName?: string | null
  phone?: string | null
  email?: string | null
  startDate?: string | null
  /** Dollars per lb of flower, 0..1000. */
  payPerLb: number
  vendorId?: string | null
  notes?: string | null
}

export interface TrimStaffPatch {
  fullName?: string
  displayName?: string | null
  phone?: string | null
  email?: string | null
  startDate?: string | null
  vendorId?: string | null
  notes?: string | null
}

const STAFF_ADMIN_COLS =
  'id, full_name, display_name, phone, email, start_date, pay_per_lb, vendor_id, is_active, notes, ' +
  'created_at, updated_at, vendor:finance_vendors(id, name)'
const STAFF_VIEW_COLS = 'id, full_name, display_name, start_date, is_active, created_at, updated_at'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function toStaff(r: Row, privileged: boolean): TrimStaffRow {
  const vendor = one(r.vendor)
  return {
    id: String(r.id),
    fullName: String(r.full_name),
    displayName: str(r.display_name),
    isActive: r.is_active === true,
    startDate: str(r.start_date),
    phone: privileged ? str(r.phone) : null,
    email: privileged ? str(r.email) : null,
    payPerLb: privileged ? num(r.pay_per_lb) : null,
    vendorId: privileged ? str(r.vendor_id) : null,
    vendorName: privileged && vendor ? str(vendor.name) : null,
    notes: privileged ? str(r.notes) : null,
  }
}

/** Optional text field: undefined = leave alone, '' / null = clear, otherwise trimmed and length-checked. */
function textField(v: unknown, max: number): { ok: true; value: string | null | undefined } | { ok: false } {
  if (v === undefined) return { ok: true, value: undefined }
  if (v === null) return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false }
  const t = v.trim()
  if (t.length > max) return { ok: false }
  return { ok: true, value: t === '' ? null : t }
}

/** Validate the optional columns shared by create and update; returns the DB columns to write. */
function buildOptionalColumns(src: Row): { ok: true; columns: Row } | { ok: false; message: string } {
  const columns: Row = {}

  const display = textField(src.displayName, 60)
  if (!display.ok) return { ok: false, message: 'Display name is too long.' }
  if (display.value !== undefined) columns.display_name = display.value

  const phone = textField(src.phone, 40)
  if (!phone.ok) return { ok: false, message: 'Phone number is too long.' }
  if (phone.value !== undefined) columns.phone = phone.value

  const email = textField(src.email, 200)
  if (!email.ok || (typeof email.value === 'string' && !EMAIL_RE.test(email.value))) {
    return { ok: false, message: 'Enter a valid email address.' }
  }
  if (email.value !== undefined) columns.email = email.value

  const notes = textField(src.notes, 1000)
  if (!notes.ok) return { ok: false, message: 'Notes are too long.' }
  if (notes.value !== undefined) columns.notes = notes.value

  if (src.startDate !== undefined) {
    if (src.startDate !== null && !validDate(src.startDate)) return { ok: false, message: 'Start date must be YYYY-MM-DD.' }
    columns.start_date = src.startDate
  }
  if (src.vendorId !== undefined) {
    if (src.vendorId !== null && !isUuid(src.vendorId)) return { ok: false, message: 'Unknown vendor.' }
    columns.vendor_id = src.vendorId
  }
  return { ok: true, columns }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function listTrimStaff(
  opts: { includeInactive?: boolean } = {}
): Promise<ActionResult<TrimStaffRow[]>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  const privileged = roleAllowed(TRIM_STAFF_ADMIN_ROLES, auth.session.role)

  try {
    const db = await createServiceClient()
    let query = db
      .from('trim_staff')
      .select(privileged ? STAFF_ADMIN_COLS : STAFF_VIEW_COLS)
      .order('full_name', { ascending: true })
    if (opts?.includeInactive !== true) query = query.eq('is_active', true)

    const { data, error } = await query
    if (error) return dbFailure('listTrimStaff', error)
    return ok(many(data).map((r) => toStaff(r, privileged)))
  } catch (err) {
    return dbFailure('listTrimStaff', err)
  }
}

export async function getTrimStaff(id: string): Promise<ActionResult<TrimStaffDetail>> {
  const auth = await requireRole(TRIM_VIEW_ROLES)
  if (!auth.authorized) return denied(auth.reason)
  if (!isUuid(id)) return invalid('Unknown trimmer.')
  const privileged = roleAllowed(TRIM_STAFF_ADMIN_ROLES, auth.session.role)

  try {
    const db = await createServiceClient()
    const [staffRes, historyRes] = await Promise.all([
      db
        .from('trim_staff')
        .select(privileged ? STAFF_ADMIN_COLS : STAFF_VIEW_COLS)
        .eq('id', id)
        .maybeSingle(),
      privileged
        ? db
            .from('trim_events')
            .select('occurred_at, actor_user_id, payload')
            .eq('event_type', 'trim_staff_rate_changed')
            .eq('payload->>trimmer_id', id)
            .order('occurred_at', { ascending: false })
            .limit(50)
        : Promise.resolve({ data: null, error: null }),
    ])
    if (staffRes.error) return dbFailure('getTrimStaff', staffRes.error)
    if (historyRes.error) return dbFailure('getTrimStaff', historyRes.error)
    if (!staffRes.data) return fail('Trimmer not found.', 'NOT_FOUND')

    const row = staffRes.data as unknown as Row
    return ok({
      ...toStaff(row, privileged),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      rateHistory: privileged
        ? many(historyRes.data).map((e) => {
            const payload = (e.payload ?? {}) as Row
            return {
              occurredAt: String(e.occurred_at),
              actorUserId: str(e.actor_user_id),
              oldRate: num(payload.old_rate),
              newRate: num(payload.new_rate),
            }
          })
        : null,
    })
  } catch (err) {
    return dbFailure('getTrimStaff', err)
  }
}

/**
 * Active finance vendors for the trimmer's payment mapping, payroll first. A minimal read guarded by
 * TRIM_STAFF_ADMIN_ROLES: getVendors() in actions/finance.ts is requireFinance()-gated, and that gate
 * is deliberately not widened. Only id, name and category are returned.
 */
export async function listTrimVendors(): Promise<ActionResult<VendorOption[]>> {
  const auth = await requireRole(TRIM_STAFF_ADMIN_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  try {
    const db = await createServiceClient()
    const { data, error } = await db
      .from('finance_vendors')
      .select('id, name, category')
      .eq('is_active', true)
      .order('name', { ascending: true })
    if (error) return dbFailure('listTrimVendors', error)

    const vendors = many(data).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      category: str(r.category),
    }))
    const rank = (v: VendorOption) => (v.category === 'payroll' ? 0 : 1)
    vendors.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    return ok(vendors)
  } catch (err) {
    return dbFailure('listTrimVendors', err)
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/** Hire a trimmer. The rate is entered at hire time by whoever hires; there is no "rate needed" placeholder. */
export async function createTrimStaff(input: TrimStaffInput): Promise<ActionResult<{ id: string }>> {
  const auth = await requireRole(TRIM_STAFF_ADMIN_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  const fullName = typeof input?.fullName === 'string' ? input.fullName.trim() : ''
  if (fullName.length < 1 || fullName.length > 120) return invalid('Enter the trimmer\'s name.')
  if (typeof input.payPerLb !== 'number' || !isValidRate(input.payPerLb)) {
    return invalid('Pay per lb must be a number from 0 to 1000.')
  }
  const optional = buildOptionalColumns(input as unknown as Row)
  if (!optional.ok) return invalid(optional.message)

  try {
    const db = await createServiceClient()
    const row = {
      ...optional.columns,
      full_name: fullName,
      pay_per_lb: roundCents(input.payPerLb),
      created_by: auth.session.userId,
    }
    const { data, error } = await db.from('trim_staff').insert(row).select('id').single()
    if (error) return dbFailure('createTrimStaff', error)
    const id = str((data as Row | null)?.id)
    if (!id) return fail(GENERIC_ERROR)

    await logEvent(db, auth.session.userId, 'trim_staff_created', {
      trimmer_id: id,
      trimmer_name: fullName,
      pay_per_lb: row.pay_per_lb,
    })
    return ok({ id })
  } catch (err) {
    return dbFailure('createTrimStaff', err)
  }
}

/**
 * Edit a trimmer's details. Deliberately cannot touch the pay rate (updateTrimStaffRate, which is
 * audited) or the active flag (setTrimStaffActive): only the whitelisted keys below are read from
 * `patch`, anything else the client sends is ignored.
 */
export async function updateTrimStaff(id: string, patch: TrimStaffPatch): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(id)) return invalid('Unknown trimmer.')
  const src = (patch ?? {}) as unknown as Row
  const optional = buildOptionalColumns(src)
  if (!optional.ok) return invalid(optional.message)
  const columns = optional.columns
  if (src.fullName !== undefined) {
    const fullName = typeof src.fullName === 'string' ? src.fullName.trim() : ''
    if (fullName.length < 1 || fullName.length > 120) return invalid('Enter the trimmer\'s name.')
    columns.full_name = fullName
  }
  if (Object.keys(columns).length === 0) return invalid('Nothing to change.')

  try {
    const db = await createServiceClient()
    const { data, error } = await db.from('trim_staff').update(columns).eq('id', id).select('id')
    if (error) return dbFailure('updateTrimStaff', error)
    if (!Array.isArray(data) || data.length !== 1) return fail('Trimmer not found.', 'NOT_FOUND')
    return ok(null)
  } catch (err) {
    return dbFailure('updateTrimStaff', err)
  }
}

/**
 * Change a trimmer's pay per lb. Affects future checkouts only (the rate is snapshotted at checkout).
 * Compare-and-swap on the old rate, then an audit event with old and new value; if the audit row
 * cannot be written the change is rolled back, because the audit trail is the control on this field.
 */
export async function updateTrimStaffRate(id: string, payPerLb: number): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_STAFF_ADMIN_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(id)) return invalid('Unknown trimmer.')
  if (typeof payPerLb !== 'number' || !isValidRate(payPerLb)) return invalid('Pay per lb must be a number from 0 to 1000.')
  const newRate = roundCents(payPerLb)

  try {
    const db = await createServiceClient()
    const { data: current, error: readErr } = await db
      .from('trim_staff')
      .select('id, full_name, pay_per_lb')
      .eq('id', id)
      .maybeSingle()
    if (readErr) return dbFailure('updateTrimStaffRate', readErr)
    if (!current) return fail('Trimmer not found.', 'NOT_FOUND')

    const oldRate = Number((current as Row).pay_per_lb)
    if (oldRate === newRate) return ok(null)

    const { data, error } = await db
      .from('trim_staff')
      .update({ pay_per_lb: newRate })
      .eq('id', id)
      .eq('pay_per_lb', oldRate)
      .select('id')
    if (error) return dbFailure('updateTrimStaffRate', error)
    if (!Array.isArray(data) || data.length !== 1) {
      return fail('The rate changed while you were editing it. Reload and try again.', 'STATE')
    }

    const { error: eventErr } = await db.from('trim_events').insert({
      actor_user_id: auth.session.userId,
      event_type: 'trim_staff_rate_changed',
      payload: {
        trimmer_id: id,
        trimmer_name: (current as Row).full_name,
        old_rate: oldRate,
        new_rate: newRate,
      },
    })
    if (eventErr) {
      console.error('[harvest-trim] updateTrimStaffRate audit failed, rolling back:', eventErr)
      const { error: rollbackErr } = await db
        .from('trim_staff')
        .update({ pay_per_lb: oldRate })
        .eq('id', id)
        .eq('pay_per_lb', newRate)
      if (rollbackErr) console.error('[harvest-trim] updateTrimStaffRate rollback failed:', rollbackErr)
      return fail('The rate was not saved because it could not be recorded. Please try again.')
    }
    return ok(null)
  } catch (err) {
    return dbFailure('updateTrimStaffRate', err)
  }
}

/** Deactivate / reactivate. Refuses to deactivate a trimmer who is holding a hanger. */
export async function setTrimStaffActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const auth = await requireRole(TRIM_OPS_ROLES)
  if (!auth.authorized) return denied(auth.reason)

  if (!isUuid(id)) return invalid('Unknown trimmer.')
  if (typeof active !== 'boolean') return invalid('Active must be true or false.')

  try {
    const db = await createServiceClient()
    if (!active) {
      const { data: held, error: heldErr } = await db
        .from('trim_checkouts')
        .select('id')
        .eq('trimmer_id', id)
        .eq('status', 'out')
        .limit(1)
      if (heldErr) return dbFailure('setTrimStaffActive', heldErr)
      if (many(held).length > 0) {
        return fail('This trimmer is still holding a hanger. Check it in or release it first.', 'STATE')
      }
    }

    const { data, error } = await db.from('trim_staff').update({ is_active: active }).eq('id', id).select('id')
    if (error) return dbFailure('setTrimStaffActive', error)
    if (!Array.isArray(data) || data.length !== 1) return fail('Trimmer not found.', 'NOT_FOUND')
    return ok(null)
  } catch (err) {
    return dbFailure('setTrimStaffActive', err)
  }
}
