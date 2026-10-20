// Coverage for actions/trim-staff.ts. Same hermetic style as actions/packaging.test.ts: requireRole and
// createServiceClient are mocked, and a hand-rolled chainable fake records every (table, method, args).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TRIM_OPS_ROLES, TRIM_STAFF_ADMIN_ROLES, TRIM_VIEW_ROLES } from '@/lib/trim/roles'

const mockRequireRole = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

const mockCreateServiceClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}))

const real = await import('./trim-staff')
type Loose<M> = { [K in keyof M]: M[K] extends (...a: infer A) => Promise<unknown> ? (...a: A) => Promise<Result> : never }
const mod = real as unknown as Loose<typeof real>

// ─── Fake database ───────────────────────────────────────────────────────────

interface RecordedCall {
  kind: 'from' | 'rpc'
  /** Table name for from(), function name for rpc(). */
  name: string
  params?: Record<string, unknown>
  ops: Array<{ method: string; args: unknown[] }>
}

type Terminal = 'single' | 'maybeSingle' | 'await'
type Responder = (call: RecordedCall, terminal: Terminal) => unknown

const CHAIN_METHODS = [
  'select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lt', 'ilike', 'like', 'order', 'limit',
  'range', 'update', 'insert', 'upsert', 'delete',
]

function createFakeDb(responder: Responder) {
  const calls: RecordedCall[] = []

  const makeBuilder = (call: RecordedCall) => {
    const builder: Record<string, unknown> = {}
    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        call.ops.push({ method, args })
        return builder
      }
    }
    builder.single = () => Promise.resolve(responder(call, 'single'))
    builder.maybeSingle = () => Promise.resolve(responder(call, 'maybeSingle'))
    builder.then = (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
      Promise.resolve(responder(call, 'await')).then(onOk, onErr)
    return builder
  }

  const client = {
    from(table: string) {
      const call: RecordedCall = { kind: 'from', name: table, ops: [] }
      calls.push(call)
      return makeBuilder(call)
    },
    rpc(fn: string, params: Record<string, unknown>) {
      const call: RecordedCall = { kind: 'rpc', name: fn, params, ops: [] }
      calls.push(call)
      return makeBuilder(call)
    },
  }
  return { client, calls }
}


// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = '11111111-1111-4111-8111-111111111111'
const STAFF = '66666666-6666-4666-8666-666666666666'
const VENDOR = '99999999-9999-4999-8999-999999999999'

type Result = { success: boolean; error?: string; code?: string; data?: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

function asRole(role: string) {
  mockRequireRole.mockImplementation(async (allowed: string[]) =>
    allowed.includes(role)
      ? { authorized: true, session: { userId: ACTOR, role, name: 'Tester' } }
      : { authorized: false, reason: `Role '${role}' is not authorized for this action` }
  )
}

function installDb(responder: Responder = () => ({ data: [], error: null })) {
  const db = createFakeDb(responder)
  mockCreateServiceClient.mockResolvedValue(db.client)
  return db
}

beforeEach(() => {
  mockRequireRole.mockReset()
  mockCreateServiceClient.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  asRole('admin')
})

const staffRow = {
  id: STAFF,
  full_name: 'Maria Lopez',
  display_name: 'Maria',
  phone: '555-0100',
  email: 'm@example.com',
  start_date: '2026-09-01',
  pay_per_lb: '225.00',
  vendor_id: VENDOR,
  is_active: true,
  notes: 'fast',
  created_at: 'c',
  updated_at: 'u',
  vendor: { id: VENDOR, name: 'Maria Lopez (payroll)' },
}

const updates = (calls: RecordedCall[], table: string) =>
  calls.filter((c) => c.name === table && c.ops.some((o) => o.method === 'update'))
const updateArg = (call: RecordedCall) => call.ops.find((o) => o.method === 'update')!.args[0]

// ─── Auth gate ───────────────────────────────────────────────────────────────

const GATES: Record<string, string[]> = {
  listTrimStaff: TRIM_VIEW_ROLES,
  getTrimStaff: TRIM_VIEW_ROLES,
  listTrimVendors: TRIM_STAFF_ADMIN_ROLES,
  createTrimStaff: TRIM_STAFF_ADMIN_ROLES,
  updateTrimStaff: TRIM_OPS_ROLES,
  updateTrimStaffRate: TRIM_STAFF_ADMIN_ROLES,
  setTrimStaffActive: TRIM_OPS_ROLES,
}
const ALL_ROLES = ['admin', 'management', 'trim_manager', 'grow', 'sales', 'agent', 'vault', 'packaging', 'standard']
const exported = mod as unknown as Record<string, (...args: unknown[]) => Promise<Result>>

describe('auth gate', () => {
  it('the gate table covers exactly the module exports', () => {
    expect(Object.keys(mod).sort()).toEqual(Object.keys(GATES).sort())
  })

  describe.each(Object.entries(GATES))('%s', (name, allowed) => {
    it('asks requireRole for exactly its role set', async () => {
      installDb()
      await exported[name]({}, {}, {})
      expect(mockRequireRole).toHaveBeenCalledWith(allowed)
    })

    it.each(ALL_ROLES.filter((r) => !allowed.includes(r)))('denies %s without touching the database', async (role) => {
      asRole(role)
      const result = await exported[name]({}, {}, {})
      expect(result).toMatchObject({ success: false, code: 'FORBIDDEN' })
      expect(mockCreateServiceClient).not.toHaveBeenCalled()
    })

    it.each(allowed)('lets %s past the gate', async (role) => {
      asRole(role)
      installDb()
      const result = await exported[name]({}, {}, {})
      expect(result.error ?? '').not.toMatch(/not authorized/)
    })
  })

  it('the finance vendor read is never widened: it is its own TRIM_STAFF_ADMIN_ROLES-gated select', async () => {
    asRole('grow')
    expect(await mod.listTrimVendors()).toMatchObject({ success: false, code: 'FORBIDDEN' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })
})

// ─── Reads ───────────────────────────────────────────────────────────────────

describe('listTrimStaff', () => {
  it('gives staff admins the rate, vendor and contact details', async () => {
    asRole('trim_manager')
    const { calls } = installDb(() => ({ data: [staffRow], error: null }))
    const result = await mod.listTrimStaff()
    expect(String(calls[0].ops.find((o) => o.method === 'select')?.args[0])).toContain('pay_per_lb')
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['is_active', true] })
    expect(result.data?.[0]).toMatchObject({ payPerLb: 225, vendorName: 'Maria Lopez (payroll)', phone: '555-0100' })
  })

  it('never selects or returns rates or contact details for grow', async () => {
    asRole('grow')
    const { calls } = installDb(() => ({ data: [staffRow], error: null }))
    const result = await mod.listTrimStaff({ includeInactive: true })
    const select = String(calls[0].ops.find((o) => o.method === 'select')?.args[0])
    expect(select).not.toMatch(/pay_per_lb|phone|email|vendor|notes/)
    expect(calls[0].ops.some((o) => o.method === 'eq' && o.args[0] === 'is_active')).toBe(false)
    expect(result.data?.[0]).toMatchObject({
      fullName: 'Maria Lopez',
      payPerLb: null,
      phone: null,
      email: null,
      vendorId: null,
      vendorName: null,
      notes: null,
    })
  })
})

describe('getTrimStaff', () => {
  const events = [
    { occurred_at: 't2', actor_user_id: ACTOR, payload: { old_rate: 200, new_rate: 225 } },
    { occurred_at: 't1', actor_user_id: ACTOR, payload: { old_rate: 180, new_rate: 200 } },
  ]
  const responder: Responder = (call, terminal) => {
    if (call.name === 'trim_staff' && terminal === 'maybeSingle') return { data: staffRow, error: null }
    if (call.name === 'trim_events') return { data: events, error: null }
    return { data: [], error: null }
  }

  it('includes the rate history for staff admins', async () => {
    asRole('trim_manager')
    const { calls } = installDb(responder)
    const result = await mod.getTrimStaff(STAFF)
    expect(result.data?.rateHistory).toEqual([
      { occurredAt: 't2', actorUserId: ACTOR, oldRate: 200, newRate: 225 },
      { occurredAt: 't1', actorUserId: ACTOR, oldRate: 180, newRate: 200 },
    ])
    const history = calls.find((c) => c.name === 'trim_events')!
    expect(history.ops).toContainEqual({ method: 'eq', args: ['payload->>trimmer_id', STAFF] })
  })

  it('withholds rate and history from grow, and does not even query the audit log', async () => {
    asRole('grow')
    const { calls } = installDb(responder)
    const result = await mod.getTrimStaff(STAFF)
    expect(result.data).toMatchObject({ payPerLb: null, rateHistory: null })
    expect(calls.some((c) => c.name === 'trim_events')).toBe(false)
  })

  it('NOT_FOUND for an unknown trimmer; INVALID for a bad id without a query', async () => {
    installDb(() => ({ data: null, error: null }))
    expect(await mod.getTrimStaff(STAFF)).toMatchObject({ success: false, code: 'NOT_FOUND' })
    mockCreateServiceClient.mockClear()
    expect(await mod.getTrimStaff('nope')).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })
})

describe('listTrimVendors', () => {
  it('reads only active vendors, three columns, payroll first', async () => {
    const { calls } = installDb(() => ({
      data: [
        { id: 'a', name: 'Acme', category: 'utilities' },
        { id: 'b', name: 'Zed Person', category: 'payroll' },
        { id: 'c', name: 'Abe Person', category: 'payroll' },
      ],
      error: null,
    }))
    const result = await mod.listTrimVendors()
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('finance_vendors')
    expect(calls[0].ops).toContainEqual({ method: 'select', args: ['id, name, category'] })
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['is_active', true] })
    expect(result.data?.map((v: { name: string }) => v.name)).toEqual(['Abe Person', 'Zed Person', 'Acme'])
  })
})

// ─── createTrimStaff ─────────────────────────────────────────────────────────

describe('createTrimStaff', () => {
  it('inserts only the whitelisted columns, with the session user as creator and an audit event', async () => {
    const { calls } = installDb((call) =>
      call.name === 'trim_staff' ? { data: { id: STAFF }, error: null } : { data: [], error: null }
    )
    const result = await mod.createTrimStaff({
      fullName: '  Maria Lopez ',
      displayName: 'Maria',
      phone: '555-0100',
      email: 'm@example.com',
      startDate: '2026-09-01',
      payPerLb: 225.499,
      vendorId: VENDOR,
      notes: '',
      // hostile
      is_active: false,
      created_by: 'evil',
      id: 'evil',
      userId: 'evil',
    } as never)
    expect(result).toEqual({ success: true, data: { id: STAFF } })

    const insert = calls.find((c) => c.name === 'trim_staff')!
    expect(insert.ops.find((o) => o.method === 'insert')?.args[0]).toEqual({
      full_name: 'Maria Lopez',
      display_name: 'Maria',
      phone: '555-0100',
      email: 'm@example.com',
      start_date: '2026-09-01',
      vendor_id: VENDOR,
      notes: null,
      pay_per_lb: 225.5,
      created_by: ACTOR,
    })
    const event = calls.find((c) => c.name === 'trim_events')!
    expect(event.ops.find((o) => o.method === 'insert')?.args[0]).toMatchObject({
      actor_user_id: ACTOR,
      event_type: 'trim_staff_created',
    })
  })

  it('a trim manager can set the rate at hire time (R2.15)', async () => {
    asRole('trim_manager')
    installDb((call) => (call.name === 'trim_staff' ? { data: { id: STAFF }, error: null } : { data: [], error: null }))
    expect((await mod.createTrimStaff({ fullName: 'Sam', payPerLb: 250 })).success).toBe(true)
  })

  it.each([
    ['negative rate', { fullName: 'A', payPerLb: -1 }],
    ['rate over the 1000 ceiling', { fullName: 'A', payPerLb: 1000.01 }],
    ['NaN rate', { fullName: 'A', payPerLb: Number.NaN }],
    ['string rate', { fullName: 'A', payPerLb: '225' as never }],
    ['missing rate', { fullName: 'A' } as never],
    ['blank name', { fullName: '   ', payPerLb: 100 }],
    ['name too long', { fullName: 'x'.repeat(121), payPerLb: 100 }],
    ['bad email', { fullName: 'A', payPerLb: 100, email: 'nope' }],
    ['bad date', { fullName: 'A', payPerLb: 100, startDate: '2026-13-01' }],
    ['bad vendor id', { fullName: 'A', payPerLb: 100, vendorId: 'x' }],
  ])('rejects %s before the database', async (_label, input) => {
    expect(await mod.createTrimStaff(input)).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('maps the duplicate-active-name index and a missing vendor to friendly INVALID errors', async () => {
    installDb(() => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "uidx_trim_staff_active_name"' },
    }))
    expect(await mod.createTrimStaff({ fullName: 'Maria', payPerLb: 200 })).toEqual({
      success: false,
      error: 'An active trimmer with that name already exists.',
      code: 'INVALID',
    })

    installDb(() => ({
      data: null,
      error: { code: '23503', message: 'insert violates foreign key constraint "trim_staff_vendor_id_fkey"' },
    }))
    expect(await mod.createTrimStaff({ fullName: 'Maria', payPerLb: 200, vendorId: VENDOR })).toMatchObject({
      success: false,
      code: 'INVALID',
    })
  })
})

// ─── updateTrimStaff ─────────────────────────────────────────────────────────

describe('updateTrimStaff', () => {
  it('cannot touch the rate, the active flag or any other column: only the whitelist is written', async () => {
    const { calls } = installDb(() => ({ data: [{ id: STAFF }], error: null }))
    const result = await mod.updateTrimStaff(STAFF, {
      fullName: 'Maria L',
      phone: null,
      vendorId: VENDOR,
      payPerLb: 9999,
      pay_per_lb: 9999,
      is_active: false,
      id: 'evil',
      created_by: 'evil',
    } as never)
    expect(result).toEqual({ success: true, data: null })
    expect(updates(calls, 'trim_staff')).toHaveLength(1)
    expect(updateArg(updates(calls, 'trim_staff')[0])).toEqual({ full_name: 'Maria L', phone: null, vendor_id: VENDOR })
  })

  it('an empty or all-unknown patch is rejected without a write', async () => {
    expect(await mod.updateTrimStaff(STAFF, {})).toMatchObject({ success: false, code: 'INVALID' })
    expect(await mod.updateTrimStaff(STAFF, { payPerLb: 5 } as never)).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('fails on a zero-row update', async () => {
    installDb(() => ({ data: [], error: null }))
    expect(await mod.updateTrimStaff(STAFF, { notes: 'x' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })
})

// ─── updateTrimStaffRate ─────────────────────────────────────────────────────

describe('updateTrimStaffRate', () => {
  const respond = (opts: { updated?: unknown[]; eventError?: unknown; current?: number | null } = {}): Responder =>
    (call, terminal) => {
      if (call.name === 'trim_staff' && terminal === 'maybeSingle') {
        return { data: opts.current === null ? null : { id: STAFF, full_name: 'Maria Lopez', pay_per_lb: String(opts.current ?? 200) }, error: null }
      }
      if (call.name === 'trim_staff') return { data: opts.updated ?? [{ id: STAFF }], error: null }
      if (call.name === 'trim_events') return { data: null, error: opts.eventError ?? null }
      return { data: [], error: null }
    }

  it('compare-and-swaps on the old rate and records old and new in trim_events', async () => {
    const { calls } = installDb(respond())
    expect(await mod.updateTrimStaffRate(STAFF, 225)).toEqual({ success: true, data: null })

    const [update] = updates(calls, 'trim_staff')
    expect(update.ops).toEqual(
      expect.arrayContaining([
        { method: 'update', args: [{ pay_per_lb: 225 }] },
        { method: 'eq', args: ['id', STAFF] },
        { method: 'eq', args: ['pay_per_lb', 200] },
        { method: 'select', args: ['id'] },
      ])
    )
    const event = calls.find((c) => c.name === 'trim_events')!
    expect(event.ops.find((o) => o.method === 'insert')?.args[0]).toEqual({
      actor_user_id: ACTOR,
      event_type: 'trim_staff_rate_changed',
      payload: { trimmer_id: STAFF, trimmer_name: 'Maria Lopez', old_rate: 200, new_rate: 225 },
    })
  })

  it('a trim manager may change the rate (R2.15)', async () => {
    asRole('trim_manager')
    installDb(respond())
    expect((await mod.updateTrimStaffRate(STAFF, 250)).success).toBe(true)
  })

  it('an unchanged rate writes nothing and logs nothing', async () => {
    const { calls } = installDb(respond({ current: 225 }))
    expect((await mod.updateTrimStaffRate(STAFF, 225)).success).toBe(true)
    expect(updates(calls, 'trim_staff')).toHaveLength(0)
    expect(calls.some((c) => c.name === 'trim_events')).toBe(false)
  })

  it('a zero-row update (someone else changed the rate) fails and logs nothing', async () => {
    const { calls } = installDb(respond({ updated: [] }))
    expect(await mod.updateTrimStaffRate(STAFF, 225)).toMatchObject({ success: false, code: 'STATE' })
    expect(calls.some((c) => c.name === 'trim_events')).toBe(false)
  })

  it('rolls the rate back and fails if the audit row cannot be written', async () => {
    const { calls } = installDb(respond({ eventError: { code: '500', message: 'boom' } }))
    const result = await mod.updateTrimStaffRate(STAFF, 225)
    expect(result.success).toBe(false)
    const writes = updates(calls, 'trim_staff').map(updateArg)
    expect(writes).toEqual([{ pay_per_lb: 225 }, { pay_per_lb: 200 }])
  })

  it('NOT_FOUND for an unknown trimmer', async () => {
    installDb(respond({ current: null }))
    expect(await mod.updateTrimStaffRate(STAFF, 225)).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it.each([-1, 1001, Number.NaN, Infinity, '225' as never, null as never])('rejects a rate of %s before the database', async (rate) => {
    expect(await mod.updateTrimStaffRate(STAFF, rate)).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('accepts the boundaries 0 and 1000', async () => {
    installDb(respond())
    expect((await mod.updateTrimStaffRate(STAFF, 0)).success).toBe(true)
    installDb(respond())
    expect((await mod.updateTrimStaffRate(STAFF, 1000)).success).toBe(true)
  })
})

// ─── setTrimStaffActive ──────────────────────────────────────────────────────

describe('setTrimStaffActive', () => {
  it('refuses to deactivate a trimmer who holds a hanger, without writing', async () => {
    const { calls } = installDb((call) => (call.name === 'trim_checkouts' ? { data: [{ id: 'co' }], error: null } : { data: [{ id: STAFF }], error: null }))
    expect(await mod.setTrimStaffActive(STAFF, false)).toMatchObject({ success: false, code: 'STATE' })
    const check = calls.find((c) => c.name === 'trim_checkouts')!
    expect(check.ops).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['trimmer_id', STAFF] },
      { method: 'eq', args: ['status', 'out'] },
    ]))
    expect(updates(calls, 'trim_staff')).toHaveLength(0)
  })

  it('deactivates a free trimmer; reactivation skips the hanger check', async () => {
    const free = installDb((call) => (call.name === 'trim_checkouts' ? { data: [], error: null } : { data: [{ id: STAFF }], error: null }))
    expect((await mod.setTrimStaffActive(STAFF, false)).success).toBe(true)
    expect(updateArg(updates(free.calls, 'trim_staff')[0])).toEqual({ is_active: false })

    const back = installDb(() => ({ data: [{ id: STAFF }], error: null }))
    expect((await mod.setTrimStaffActive(STAFF, true)).success).toBe(true)
    expect(back.calls.some((c) => c.name === 'trim_checkouts')).toBe(false)
  })

  it('fails on a zero-row update and on a non-boolean', async () => {
    installDb(() => ({ data: [], error: null }))
    expect(await mod.setTrimStaffActive(STAFF, true)).toMatchObject({ success: false, code: 'NOT_FOUND' })
    mockCreateServiceClient.mockClear()
    expect(await mod.setTrimStaffActive(STAFF, 'yes' as never)).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('reactivating onto a taken name surfaces the friendly duplicate message', async () => {
    installDb(() => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "uidx_trim_staff_active_name"' },
    }))
    expect(await mod.setTrimStaffActive(STAFF, true)).toMatchObject({
      success: false,
      code: 'INVALID',
      error: 'An active trimmer with that name already exists.',
    })
  })
})
