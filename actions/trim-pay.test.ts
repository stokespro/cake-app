// Coverage for actions/trim-pay.ts. Same hermetic style as actions/harvest-trim.test.ts: requireRole /
// requireFinance and createServiceClient are mocked, and a chainable fake records every
// (table, method, args) and every .rpc(name, params) so tests assert the exact database traffic.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TRIM_OPS_ROLES, TRIM_PAY_APPROVE_ROLES } from '@/lib/trim/roles'

const mockRequireRole = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
  // the real requireFinance is requireRole(['admin', 'management'])
  requireFinance: () => mockRequireRole(['admin', 'management']),
}))

const mockCreateServiceClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}))

const real = await import('./trim-pay')
type Loose<M> = { [K in keyof M]: M[K] extends (...a: infer A) => Promise<unknown> ? (...a: A) => Promise<Result> : never }
const mod = real as unknown as Loose<typeof real>

// ─── Fake database ───────────────────────────────────────────────────────────

interface RecordedCall {
  kind: 'from' | 'rpc'
  name: string
  params?: Record<string, unknown>
  ops: Array<{ method: string; args: unknown[] }>
}

type Terminal = 'single' | 'maybeSingle' | 'await'
type Responder = (call: RecordedCall, terminal: Terminal) => unknown

const CHAIN_METHODS = [
  'select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'lt', 'ilike', 'like', 'order', 'limit',
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

const rpcCalls = (calls: RecordedCall[]) => calls.filter((c) => c.kind === 'rpc')
const opsOf = (call: RecordedCall, method: string) => call.ops.filter((o) => o.method === method)

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = '11111111-1111-4111-8111-111111111111'
const BATCH = '33333333-3333-4333-8333-333333333333'
const TRIMMER = '66666666-6666-4666-8666-666666666666'
const TRIMMER_B = '66666666-6666-4666-8666-666666666667'
const PAYOUT = '99999999-9999-4999-8999-999999999999'
const BILL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const VENDOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const HOSTILE = { userId: 'evil', actorId: 'evil', approvedBy: 'evil', actor: 'evil' }
const MONEY = { amount: 424242, ratePerLb: 313131, flowerG: 654321, flower_g: 654321, payPerLb: 313131, total: 424242 }

type Result = { success: boolean; error?: string; code?: string; data?: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

interface Scenario {
  rpc?: Record<string, unknown>
  rpcResult?: { data: unknown; error: unknown }
  tables?: Record<string, { data: unknown; error?: unknown }>
}

function defaultRpc(fn: string): unknown {
  switch (fn) {
    case 'fn_trim_close_batch':
      return {
        batch_id: BATCH, batch_name: '1029-F5-VZ', trim_closed_at: '2026-10-20T15:00:00Z',
        reconciled_loads: 7, void_loads: 1, hangers: 7, ready_entries: 9,
        total_flower_g: 9071.85, total_amount: 4500.5,
        trimmers: [{ trimmer_id: TRIMMER, trimmer_name: 'Maria', entries: 5, flower_g: 4535.92, amount: 2250.25 }],
      }
    case 'fn_trim_approve_payout':
      return {
        payout: { id: PAYOUT, vendor_id: VENDOR, due_date: '2026-11-05', status: 'approved' },
        bill: { id: BILL, name: 'Trim - 1029-F5-VZ - Maria', status: 'unpaid', period_month: '2026-11-01' },
        entry_count: 5, hangers: 4, flower_g: 4535.92, amount: 2250.25,
        rate_min: 225, rate_max: 225, rate_changed: true, previous_rate_min: 200, previous_rate_max: 200,
      }
    case 'fn_trim_reverse_payout':
      return {
        payout: { id: PAYOUT, status: 'reversed', amount: 2250.25 },
        bill: { id: BILL, status: 'void' },
        entries_returned: 5,
      }
    case 'fn_trim_reopen_batch':
      return { batch_id: BATCH, batch_name: '1029-F5-VZ', entries_reopened: 9, previously_closed_at: '2026-10-20T15:00:00Z' }
    default:
      return { ok: true }
  }
}

function responderFor(s: Scenario = {}): Responder {
  return (call) => {
    if (call.kind === 'rpc') {
      if (s.rpcResult) return s.rpcResult
      return { data: s.rpc && call.name in s.rpc ? s.rpc[call.name] : defaultRpc(call.name), error: null }
    }
    if (s.tables && call.name in s.tables) return { error: null, ...s.tables[call.name] }
    return { data: [], error: null }
  }
}

function installDb(s: Scenario = {}) {
  const db = createFakeDb(responderFor(s))
  mockCreateServiceClient.mockResolvedValue(db.client)
  return db
}

function asRole(role: string) {
  mockRequireRole.mockImplementation(async (allowed: string[]) =>
    allowed.includes(role)
      ? { authorized: true, session: { userId: ACTOR, role, name: 'Tester' } }
      : { authorized: false, reason: `Role '${role}' is not authorized for this action` }
  )
}

beforeEach(() => {
  mockRequireRole.mockReset()
  mockCreateServiceClient.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  asRole('admin')
})

// ─── Auth gate, table-driven ─────────────────────────────────────────────────

const FINANCE_ROLES = ['admin', 'management']
const ADMIN_ONLY = ['admin']

const GATES: Record<string, string[]> = {
  getBatchPayoutReview: TRIM_PAY_APPROVE_ROLES,
  closeTrimBatch: TRIM_OPS_ROLES,
  reopenTrimBatch: ADMIN_ONLY,
  approveTrimPayout: TRIM_PAY_APPROVE_ROLES,
  reverseTrimPayout: TRIM_PAY_APPROVE_ROLES,
  getPayRegister: FINANCE_ROLES,
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
      expect(result.success).toBe(false)
      expect(result.code).toBe('FORBIDDEN')
      expect(mockCreateServiceClient).not.toHaveBeenCalled()
    })

    it.each(allowed)('lets %s past the gate', async (role) => {
      asRole(role)
      installDb()
      const result = await exported[name]({}, {}, {})
      expect(result.error ?? '').not.toMatch(/not authorized/)
    })
  })

  it('grow never reaches any export', () => {
    for (const allowed of Object.values(GATES)) expect(allowed).not.toContain('grow')
  })

  it('reopenTrimBatch rejects management and trim_manager: the database does not check the role', async () => {
    for (const role of ['management', 'trim_manager']) {
      asRole(role)
      const { calls } = installDb()
      const result = await mod.reopenTrimBatch({ batchId: BATCH, reason: 'forgotten hanger' })
      expect(result).toMatchObject({ success: false, code: 'FORBIDDEN' })
      expect(calls).toHaveLength(0)
      expect(mockCreateServiceClient).not.toHaveBeenCalled()
    }
  })

  it('the pay register is finance-only: trim_manager approves pay but cannot read the register', async () => {
    asRole('trim_manager')
    const result = await mod.getPayRegister({ from: '2026-10-01', to: '2026-10-31' })
    expect(result).toMatchObject({ success: false, code: 'FORBIDDEN' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('passes a missing-session reason straight through so handleSessionError can see it', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'No valid session' })
    const result = await mod.getBatchPayoutReview(BATCH)
    expect(result).toEqual({ success: false, error: 'No valid session', code: 'FORBIDDEN' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('returns a failure instead of throwing when the database client cannot be built', async () => {
    mockCreateServiceClient.mockRejectedValue(new Error('Missing SUPABASE_SERVICE_ROLE_KEY'))
    for (const run of [
      () => mod.getBatchPayoutReview(BATCH),
      () => mod.getPayRegister({ from: '2026-10-01', to: '2026-10-31' }),
      () => mod.closeTrimBatch({ batchId: BATCH }),
      () => mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' }),
    ]) {
      const result = await run()
      expect(result.success).toBe(false)
      expect(result.error).not.toMatch(/SERVICE_ROLE/)
    }
  })
})

// ─── Actor and money integrity ───────────────────────────────────────────────

describe('actor integrity: the actor is always the session user', () => {
  const calls: Array<[string, string, () => Promise<Result>]> = [
    ['closeTrimBatch', 'fn_trim_close_batch', () =>
      mod.closeTrimBatch({ batchId: BATCH, confirmedHangerCount: 7, ...HOSTILE, ...MONEY } as never)],
    ['reopenTrimBatch', 'fn_trim_reopen_batch', () =>
      mod.reopenTrimBatch({ batchId: BATCH, reason: 'forgotten hanger', ...HOSTILE, ...MONEY } as never)],
    ['approveTrimPayout', 'fn_trim_approve_payout', () =>
      mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05', ...HOSTILE, ...MONEY } as never)],
    ['reverseTrimPayout', 'fn_trim_reverse_payout', () =>
      mod.reverseTrimPayout({ payoutId: PAYOUT, reason: 'wrong trimmer', ...HOSTILE, ...MONEY } as never)],
  ]

  it.each(calls)('%s forwards session.userId and nothing from the client', async (_name, rpc, run) => {
    const { calls: recorded } = installDb()
    const result = await run()
    expect(result.success).toBe(true)

    const rpcs = rpcCalls(recorded)
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0].name).toBe(rpc)
    expect(rpcs[0].params?.p_actor).toBe(ACTOR)
    expect(JSON.stringify(rpcs[0].params)).not.toContain('evil')
  })

  it.each(calls)('%s sends no amount, rate or flower weight to the database', async (_name, _rpc, run) => {
    const { calls: recorded } = installDb()
    await run()
    const keys = Object.keys(rpcCalls(recorded)[0].params ?? {})
    for (const k of keys) expect(k).not.toMatch(/amount|rate|flower|total|price/)
    const json = JSON.stringify(rpcCalls(recorded)[0].params)
    for (const v of ['424242', '313131', '654321']) expect(json).not.toContain(v)
  })

  it('sends exactly the documented parameters', async () => {
    const { calls: recorded } = installDb()
    await mod.closeTrimBatch({ batchId: BATCH, confirmedHangerCount: 7 })
    await mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' })
    await mod.reverseTrimPayout({ payoutId: PAYOUT, reason: '  wrong trimmer  ' })
    await mod.reopenTrimBatch({ batchId: BATCH, reason: ' forgotten hanger ' })
    expect(rpcCalls(recorded).map((c) => c.params)).toEqual([
      { p_batch_id: BATCH, p_actor: ACTOR, p_confirmed_hanger_count: 7 },
      { p_batch_id: BATCH, p_trimmer_id: TRIMMER, p_due_date: '2026-11-05', p_actor: ACTOR },
      { p_payout_id: PAYOUT, p_reason: 'wrong trimmer', p_actor: ACTOR },
      { p_batch_id: BATCH, p_reason: 'forgotten hanger', p_actor: ACTOR },
    ])
  })

  it('no action writes finance_bills / finance_bill_payments or calls createBill', async () => {
    const { calls: recorded } = installDb()
    await mod.closeTrimBatch({ batchId: BATCH })
    await mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' })
    await mod.reverseTrimPayout({ payoutId: PAYOUT, reason: 'wrong trimmer' })
    await mod.reopenTrimBatch({ batchId: BATCH, reason: 'forgotten hanger' })
    await mod.getBatchPayoutReview(BATCH)
    await mod.getPayRegister({ from: '2026-10-01', to: '2026-10-31' })
    for (const c of recorded.filter((x) => x.kind === 'from')) {
      expect(['batches', 'trim_payouts']).toContain(c.name)
      for (const op of ['insert', 'update', 'upsert', 'delete']) expect(opsOf(c, op)).toHaveLength(0)
    }
    const source = readFileSync(path.join(__dirname, 'trim-pay.ts'), 'utf8')
    const code = source.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(code).not.toMatch(/createBill|actions\/finance/)
  })
})

// ─── closeTrimBatch ──────────────────────────────────────────────────────────

describe('closeTrimBatch', () => {
  it('returns the close summary in camelCase', async () => {
    installDb()
    const result = await mod.closeTrimBatch({ batchId: BATCH, confirmedHangerCount: 7 })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      batchId: BATCH,
      batchName: '1029-F5-VZ',
      trimClosedAt: '2026-10-20T15:00:00Z',
      reconciledLoads: 7,
      voidLoads: 1,
      hangers: 7,
      readyEntries: 9,
      totalFlowerG: 9071.85,
      totalAmount: 4500.5,
      trimmers: [{ trimmerId: TRIMMER, trimmerName: 'Maria', entries: 5, flowerG: 4535.92, amount: 2250.25 }],
    })
  })

  it('omits the count when not supplied (the DB then skips the rack check)', async () => {
    const { calls } = installDb()
    await mod.closeTrimBatch({ batchId: BATCH })
    expect(rpcCalls(calls)[0].params).toEqual({ p_batch_id: BATCH, p_actor: ACTOR })
  })

  it('passes the confirmed count through without pre-checking it, 0 included', async () => {
    const { calls } = installDb()
    await mod.closeTrimBatch({ batchId: BATCH, confirmedHangerCount: 0 })
    expect(rpcCalls(calls)[0].params?.p_confirmed_hanger_count).toBe(0)
    // and it never reads the batch to compare
    expect(calls.filter((c) => c.kind === 'from')).toHaveLength(0)
  })

  it.each([2.5, -1, Number.NaN, '7', 10001])('rejects an unusable count %p before any database call', async (n) => {
    const result = await mod.closeTrimBatch({ batchId: BATCH, confirmedHangerCount: n as never })
    expect(result).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a bad batch id before any database call', async () => {
    const result = await mod.closeTrimBatch({ batchId: 'nope' })
    expect(result).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('a blocked close keeps the named hanger list intact', async () => {
    const message =
      'TRIM_E_STATE: 2 load(s) are not finished and block closing batch 1029-F5-VZ: H1B-003 (partial), H1B-004 (hung)'
    installDb({ rpcResult: { data: null, error: { code: 'P0001', message } } })
    const result = await mod.closeTrimBatch({ batchId: BATCH })
    expect(result).toEqual({
      success: false,
      code: 'STATE',
      error: '2 load(s) are not finished and block closing batch 1029-F5-VZ: H1B-003 (partial), H1B-004 (hung)',
    })
  })

  it('a rack-count mismatch surfaces the DB message', async () => {
    const message =
      'TRIM_E_STATE: rack count mismatch - you confirmed 6 hanger(s) but 7 carry a reconciled load in batch X'
    installDb({ rpcResult: { data: null, error: { code: 'P0001', message } } })
    const result = await mod.closeTrimBatch({ batchId: BATCH, confirmedHangerCount: 6 })
    expect(result.code).toBe('STATE')
    expect(result.error).toMatch(/rack count mismatch/)
  })

  it('treats a null or empty rpc result as failure', async () => {
    for (const data of [null, [], undefined]) {
      installDb({ rpcResult: { data, error: null } })
      const result = await mod.closeTrimBatch({ batchId: BATCH })
      expect(result.success).toBe(false)
    }
  })
})

// ─── New error codes ─────────────────────────────────────────────────────────

describe('the four new error codes', () => {
  const cases: Array<[string, string, string]> = [
    ['NO_VENDOR', 'NO_VENDOR', 'Maria has no finance vendor linked - link or create a vendor on the trim staff record, then approve'],
    ['ALREADY_APPROVED', 'ALREADY_APPROVED', 'Maria already has an approved payout for batch X - reverse it first to change it'],
    ['HAS_PAYMENTS', 'HAS_PAYMENTS', 'the bill already has 1 payment(s) totalling $100.00 - it cannot be reversed here; correct it in finance'],
    ['RECONCILE', 'RECONCILE', 'batch X pay entries total 100 g flower but its returned episodes total 90 g - do not close'],
  ]

  it.each(cases)('TRIM_E_%s -> %s with the DB message intact', async (code, mapped, text) => {
    installDb({ rpcResult: { data: null, error: { code: 'P0001', message: `TRIM_E_${code}: ${text}` } } })
    const runs = [
      () => mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' }),
      () => mod.reverseTrimPayout({ payoutId: PAYOUT, reason: 'wrong trimmer' }),
      () => mod.closeTrimBatch({ batchId: BATCH }),
      () => mod.reopenTrimBatch({ batchId: BATCH, reason: 'forgotten hanger' }),
    ]
    for (const run of runs) {
      expect(await run()).toEqual({ success: false, error: text, code: mapped })
    }
  })

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['STATE', 'STATE'],
    ['INVALID', 'INVALID'],
  ])('still maps Phase 1 code %s -> %s', async (code, mapped) => {
    installDb({ rpcResult: { data: null, error: { code: 'P0001', message: `TRIM_E_${code}: nope` } } })
    const result = await mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' })
    expect(result).toEqual({ success: false, error: 'nope', code: mapped })
  })

  it('does not trust the prefix on a non-P0001 error: it is logged and returned generic', async () => {
    installDb({ rpcResult: { data: null, error: { code: '42P01', message: 'TRIM_E_NO_VENDOR: relation "trim_payouts" does not exist' } } })
    const result = await mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' })
    expect(result.success).toBe(false)
    expect(result.code).toBeUndefined()
    expect(result.error).not.toMatch(/relation/)
    expect(console.error).toHaveBeenCalledWith('[harvest-trim] approveTrimPayout error:', expect.anything())
  })

  it('an unexpected database error is logged and returned generic', async () => {
    installDb({ rpcResult: { data: null, error: { code: '42P01', message: 'relation "trim_payouts" does not exist' } } })
    const result = await mod.reverseTrimPayout({ payoutId: PAYOUT, reason: 'wrong trimmer' })
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/relation/)
  })
})

// ─── approveTrimPayout ───────────────────────────────────────────────────────

describe('approveTrimPayout', () => {
  it('returns enough to confirm the bill, including the rate change', async () => {
    installDb()
    const result = await mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' })
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({
      payoutId: PAYOUT,
      billId: BILL,
      billName: 'Trim - 1029-F5-VZ - Maria',
      billStatus: 'unpaid',
      periodMonth: '2026-11-01',
      batchId: BATCH,
      trimmerId: TRIMMER,
      vendorId: VENDOR,
      amount: 2250.25,
      flowerG: 4535.92,
      hangers: 4,
      entryCount: 5,
      dueDate: '2026-11-05',
      rateMin: 225,
      rateMax: 225,
      rateChanged: true,
      previousRateMin: 200,
      previousRateMax: 200,
    })
    expect(result.data?.flowerLb).toBeCloseTo(10, 1)
  })

  it('reports rateChanged false and null previous rates for a first payout', async () => {
    installDb({
      rpc: {
        fn_trim_approve_payout: {
          payout: { id: PAYOUT, vendor_id: VENDOR, due_date: '2026-11-05' },
          bill: { id: BILL, status: 'unpaid' },
          entry_count: 1, hangers: 1, flower_g: 453.59, amount: 100,
          rate_min: 220, rate_max: 220, rate_changed: false, previous_rate_min: null, previous_rate_max: null,
        },
      },
    })
    const result = await mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' })
    expect(result.data).toMatchObject({ rateChanged: false, previousRateMin: null, previousRateMax: null })
  })

  it.each([
    [{ batchId: 'x', trimmerId: TRIMMER, dueDate: '2026-11-05' }],
    [{ batchId: BATCH, trimmerId: 'x', dueDate: '2026-11-05' }],
    [{ batchId: BATCH, trimmerId: TRIMMER, dueDate: '' }],
    [{ batchId: BATCH, trimmerId: TRIMMER, dueDate: '11/05/2026' }],
    [{ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-02-30' }],
    [{ batchId: BATCH, trimmerId: TRIMMER }],
  ])('rejects %j before any database call', async (input) => {
    const result = await mod.approveTrimPayout(input as never)
    expect(result).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('treats an rpc result with no payout or bill as failure', async () => {
    installDb({ rpc: { fn_trim_approve_payout: { entry_count: 1 } } })
    const result = await mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2026-11-05' })
    expect(result.success).toBe(false)
  })

  it('leaves the due-date range rules to the database', async () => {
    installDb({
      rpcResult: { data: null, error: { code: 'P0001', message: 'TRIM_E_INVALID: due date 2030-01-01 is more than a year out' } },
    })
    const result = await mod.approveTrimPayout({ batchId: BATCH, trimmerId: TRIMMER, dueDate: '2030-01-01' })
    expect(result).toEqual({ success: false, code: 'INVALID', error: 'due date 2030-01-01 is more than a year out' })
  })
})

// ─── reverseTrimPayout / reopenTrimBatch ─────────────────────────────────────

describe('reverseTrimPayout', () => {
  it('returns the voided bill and the entries returned', async () => {
    installDb()
    const result = await mod.reverseTrimPayout({ payoutId: PAYOUT, reason: 'wrong trimmer' })
    expect(result.data).toEqual({ payoutId: PAYOUT, billId: BILL, billStatus: 'void', amount: 2250.25, entriesReturned: 5 })
  })

  it.each(['', 'ab', '  a ', '   ', undefined, 42])('a %p reason makes zero database calls', async (reason) => {
    const { calls } = installDb()
    const result = await mod.reverseTrimPayout({ payoutId: PAYOUT, reason: reason as never })
    expect(result).toMatchObject({ success: false, code: 'INVALID' })
    expect(calls).toHaveLength(0)
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a reason over 500 characters', async () => {
    const result = await mod.reverseTrimPayout({ payoutId: PAYOUT, reason: 'x'.repeat(501) })
    expect(result.success).toBe(false)
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a bad payout id before any database call', async () => {
    const result = await mod.reverseTrimPayout({ payoutId: 'nope', reason: 'wrong trimmer' })
    expect(result.success).toBe(false)
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })
})

describe('reopenTrimBatch', () => {
  it('returns the reopen summary', async () => {
    installDb()
    const result = await mod.reopenTrimBatch({ batchId: BATCH, reason: 'forgotten hanger' })
    expect(result.data).toEqual({
      batchId: BATCH, batchName: '1029-F5-VZ', entriesReopened: 9, previouslyClosedAt: '2026-10-20T15:00:00Z',
    })
  })

  it('requires a reason before any database call', async () => {
    const result = await mod.reopenTrimBatch({ batchId: BATCH, reason: 'no' })
    expect(result).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('surfaces the approved-payout refusal', async () => {
    installDb({
      rpcResult: { data: null, error: { code: 'P0001', message: 'TRIM_E_STATE: batch X has 2 approved payout(s) - reverse them before reopening' } },
    })
    const result = await mod.reopenTrimBatch({ batchId: BATCH, reason: 'forgotten hanger' })
    expect(result).toMatchObject({ success: false, code: 'STATE' })
    expect(result.error).toMatch(/reverse them before reopening/)
  })
})

// ─── getBatchPayoutReview ────────────────────────────────────────────────────

function reviewBatch(over: Record<string, unknown> = {}) {
  const staff = (vendorActive = true) => ({ id: TRIMMER, vendor_id: VENDOR, vendor: { id: VENDOR, name: 'Maria Lopez', is_active: vendorActive } })
  const entry = (amount: number, status = 'ready') => ({ id: 'e', amount, flower_g: 453.59, status })
  return {
    id: BATCH,
    name: '1029-F5-VZ',
    trim_closed_at: '2026-10-20T15:00:00Z',
    strain: { id: 's', name: 'Violet Zkittlez' },
    closed_by: { name: 'Joey' },
    hanger_loads: [
      {
        id: 'L1', status: 'reconciled', hanger: { code: 'H1B-002' },
        trim_checkouts: [
          { id: 'c1', trimmer_id: TRIMMER, trimmer_name: 'Maria', status: 'returned', variance_status: 'ok', rate_per_lb_applied: 200, flower_g: 453.59, trimmer: staff(), trim_pay_entries: entry(200) },
          { id: 'c2', trimmer_id: TRIMMER, trimmer_name: 'Maria', status: 'returned', variance_status: 'accepted', rate_per_lb_applied: 225, flower_g: 453.59, trimmer: staff(), trim_pay_entries: [entry(225)] },
          { id: 'c3', trimmer_id: TRIMMER, trimmer_name: 'Maria', status: 'released', variance_status: null, rate_per_lb_applied: 225, flower_g: null, trimmer: staff(), trim_pay_entries: null },
        ],
      },
      {
        id: 'L2', status: 'void', hanger: { code: 'H1B-010' },
        trim_checkouts: [
          { id: 'c4', trimmer_id: TRIMMER_B, trimmer_name: 'Ben', status: 'returned', variance_status: 'ok', rate_per_lb_applied: 220, flower_g: 453.59, trimmer: { id: TRIMMER_B, vendor_id: null, vendor: null }, trim_pay_entries: entry(220) },
        ],
      },
      {
        id: 'L3', status: 'returned', hanger: { code: 'H1B-003' },
        trim_checkouts: [
          { id: 'c5', trimmer_id: TRIMMER_B, trimmer_name: 'Ben', status: 'returned', variance_status: 'flagged', rate_per_lb_applied: 220, flower_g: 300, trimmer: { id: TRIMMER_B, vendor_id: null, vendor: null }, trim_pay_entries: null },
        ],
      },
      { id: 'L4', status: 'hung', hanger: { code: 'H1B-004' }, trim_checkouts: [] },
    ],
    trim_payouts: [
      { id: PAYOUT, trimmer_id: TRIMMER, bill_id: BILL, status: 'approved', amount: 425, flower_g: 907.18, due_date: '2026-11-05', approved_at: '2026-10-21T10:00:00Z', finance_bills: { id: BILL, status: 'partial', amount: 425, amount_paid: 100 } },
      { id: 'old', trimmer_id: TRIMMER_B, bill_id: 'b2', status: 'reversed', amount: 1, flower_g: 1, due_date: '2026-11-05', approved_at: '2026-10-20T10:00:00Z', finance_bills: { id: 'b2', status: 'void', amount: 1, amount_paid: 0 } },
    ],
    ...over,
  }
}

describe('getBatchPayoutReview', () => {
  it('builds the per-trimmer review from ONE query', async () => {
    const { calls } = installDb({ tables: { batches: { data: reviewBatch() } } })
    const result = await mod.getBatchPayoutReview(BATCH)
    expect(result.success).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('batches')
    expect(opsOf(calls[0], 'eq')[0].args).toEqual(['id', BATCH])
    const select = String(opsOf(calls[0], 'select')[0].args[0])
    for (const embed of ['hanger_loads', 'trim_checkouts', 'trim_pay_entries', 'trim_payouts', 'finance_bills', 'finance_vendors']) {
      expect(select).toContain(embed)
    }
  })

  it('rolls up each trimmer: hangers, episodes, flower, rates, amount owed, payout and bill', async () => {
    installDb({ tables: { batches: { data: reviewBatch() } } })
    const d = (await mod.getBatchPayoutReview(BATCH)).data!
    expect(d.batchName).toBe('1029-F5-VZ')
    expect(d.strainName).toBe('Violet Zkittlez')

    const maria = d.trimmers.find((t: { trimmerName: string }) => t.trimmerName === 'Maria')
    expect(maria).toMatchObject({
      trimmerId: TRIMMER,
      hangers: 1,
      hangerCodes: ['H1B-002'],
      episodes: 2, // the released episode is not counted
      flowerG: 907.18,
      ratesPerLb: [200, 225],
      amountOwed: 425,
      readyEntries: 2,
      flaggedEpisodes: 0,
      vendorName: 'Maria Lopez',
      vendorActive: true,
      payout: {
        payoutId: PAYOUT,
        billId: BILL,
        status: 'approved',
        amount: 425,
        dueDate: '2026-11-05',
        billStatus: 'partial',
        billAmount: 425,
        amountPaid: 100,
      },
      canApprove: false, // already approved
    })
    expect(maria.flowerLb).toBeCloseTo(2, 1)
  })

  it('counts a voided partial load, flags unresolved returns, and withholds approval without a vendor', async () => {
    installDb({ tables: { batches: { data: reviewBatch() } } })
    const d = (await mod.getBatchPayoutReview(BATCH)).data!
    const ben = d.trimmers.find((t: { trimmerName: string }) => t.trimmerName === 'Ben')
    expect(ben).toMatchObject({
      hangers: 2,
      episodes: 2,
      amountOwed: 220, // the flagged return has no pay line
      flaggedEpisodes: 1,
      vendorId: null,
      vendorActive: null,
      payout: null, // the reversed payout does not hold the work
      canApprove: false,
    })
    expect(d.totals).toMatchObject({
      trimmers: 2,
      amountOwed: 645,
      approvedTrimmers: 1,
      approvedAmount: 425,
      flaggedEpisodes: 1,
    })
  })

  it('reports the close state and the unfinished loads that block it', async () => {
    installDb({ tables: { batches: { data: reviewBatch({ trim_closed_at: null, closed_by: null }) } } })
    const d = (await mod.getBatchPayoutReview(BATCH)).data!
    expect(d.close).toEqual({
      closed: false,
      closedAt: null,
      closedByName: null,
      reconciledLoads: 1,
      voidLoads: 1,
      unfinishedLoads: [
        { hangerCode: 'H1B-003', status: 'flagged' },
        { hangerCode: 'H1B-004', status: 'hung' },
      ],
    })
  })

  it('reports a closed batch', async () => {
    installDb({ tables: { batches: { data: reviewBatch() } } })
    const d = (await mod.getBatchPayoutReview(BATCH)).data!
    expect(d.close).toMatchObject({ closed: true, closedAt: '2026-10-20T15:00:00Z', closedByName: 'Joey' })
  })

  it('canApprove is true only for a closed batch, ready entries, no payout and an active vendor', async () => {
    const free = reviewBatch({ trim_payouts: [] })
    installDb({ tables: { batches: { data: free } } })
    const closed = (await mod.getBatchPayoutReview(BATCH)).data!
    expect(closed.trimmers.find((t: { trimmerId: string }) => t.trimmerId === TRIMMER).canApprove).toBe(true)

    installDb({ tables: { batches: { data: { ...free, trim_closed_at: null } } } })
    const open = (await mod.getBatchPayoutReview(BATCH)).data!
    expect(open.trimmers.find((t: { trimmerId: string }) => t.trimmerId === TRIMMER).canApprove).toBe(false)
  })

  it('returns NOT_FOUND for an unknown batch and rejects a bad id with no database call', async () => {
    installDb({ tables: { batches: { data: null } } })
    expect(await mod.getBatchPayoutReview(BATCH)).toMatchObject({ success: false, code: 'NOT_FOUND' })
    mockCreateServiceClient.mockReset()
    expect(await mod.getBatchPayoutReview('nope')).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('returns a failure rather than throwing on a database error', async () => {
    installDb({ tables: { batches: { data: null, error: { code: '42703', message: 'column does not exist' } } } })
    const result = await mod.getBatchPayoutReview(BATCH)
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/column/)
  })
})

// ─── getPayRegister ──────────────────────────────────────────────────────────

function payoutRow(over: Record<string, unknown> = {}) {
  return {
    id: PAYOUT, batch_id: BATCH, trimmer_id: TRIMMER, vendor_id: VENDOR, bill_id: BILL,
    flower_g: 4535.92, amount: 2250.25, due_date: '2026-11-05', status: 'approved',
    approved_at: '2026-10-21T10:00:00Z', reversed_at: null, reverse_reason: null,
    trimmer: { full_name: 'Maria Lopez' }, vendor: { name: 'Maria Lopez' }, batch: { name: '1029-F5-VZ' },
    approver: { name: 'Joey' },
    finance_bills: { id: BILL, status: 'partial', amount: 2250.25, amount_paid: 1000, paid_date: null },
    ...over,
  }
}

describe('getPayRegister', () => {
  const range = { from: '2026-10-01', to: '2026-11-30' }

  it('joins each payout to its bill and reads payment state from the bill', async () => {
    const { calls } = installDb({ tables: { trim_payouts: { data: [payoutRow()] } } })
    const result = await mod.getPayRegister(range)
    expect(result.success).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('trim_payouts')
    expect(opsOf(calls[0], 'gte')[0].args).toEqual(['due_date', '2026-10-01'])
    expect(opsOf(calls[0], 'lte')[0].args).toEqual(['due_date', '2026-11-30'])
    expect(String(opsOf(calls[0], 'select')[0].args[0])).toContain('finance_bills(')

    expect(result.data?.rows[0]).toMatchObject({
      payoutId: PAYOUT,
      billId: BILL,
      batchName: '1029-F5-VZ',
      trimmerName: 'Maria Lopez',
      vendorName: 'Maria Lopez',
      amount: 2250.25,
      dueDate: '2026-11-05',
      payoutStatus: 'approved',
      billStatus: 'partial',
      amountPaid: 1000,
      balance: 1250.25,
      approvedByName: 'Joey',
      approvedAt: '2026-10-21T10:00:00Z',
    })
    expect(result.data?.rows[0].flowerLb).toBeCloseTo(10, 1)
    expect(result.data?.totals).toEqual({ payouts: 1, approvedAmount: 2250.25, amountPaid: 1000, outstanding: 1250.25 })
    expect(result.data?.truncated).toBe(false)
  })

  it('leaves reversed payouts out of the money totals', async () => {
    installDb({
      tables: {
        trim_payouts: {
          data: [payoutRow(), payoutRow({ id: 'r', status: 'reversed', reversed_at: '2026-10-22T10:00:00Z', reverse_reason: 'wrong trimmer', finance_bills: { id: 'b', status: 'void', amount: 2250.25, amount_paid: 0, paid_date: null } })],
        },
      },
    })
    const d = (await mod.getPayRegister(range)).data!
    expect(d.rows).toHaveLength(2)
    expect(d.rows[1]).toMatchObject({ payoutStatus: 'reversed', billStatus: 'void', balance: 0, reverseReason: 'wrong trimmer' })
    expect(d.totals.approvedAmount).toBe(2250.25)
  })

  it('filters by payout status on the payout, and by payment state through an inner join on the bill', async () => {
    const a = installDb()
    await mod.getPayRegister({ ...range, status: 'reversed' })
    expect(opsOf(a.calls[0], 'eq')[0].args).toEqual(['status', 'reversed'])
    expect(String(opsOf(a.calls[0], 'select')[0].args[0])).toContain('finance_bills(')

    const b = installDb()
    await mod.getPayRegister({ ...range, status: 'unpaid' })
    expect(String(opsOf(b.calls[0], 'select')[0].args[0])).toContain('finance_bills!inner(')
    expect(opsOf(b.calls[0], 'eq').map((o) => o.args)).toEqual([
      ['status', 'approved'],
      ['finance_bills.status', 'unpaid'],
    ])
  })

  it('flags truncation past the row cap', async () => {
    installDb({ tables: { trim_payouts: { data: Array.from({ length: 1001 }, () => payoutRow()) } } })
    const d = (await mod.getPayRegister(range)).data!
    expect(d.rows).toHaveLength(1000)
    expect(d.truncated).toBe(true)
  })

  it.each([
    [{ from: '2026-10-01', to: '2026-09-01' }],
    [{ from: '2026-01-01', to: '2027-06-01' }],
    [{ from: 'x', to: '2026-10-01' }],
    [{ from: '2026-10-01', to: '2026-10-31', status: 'bogus' }],
  ])('rejects %j with no database call', async (input) => {
    const result = await mod.getPayRegister(input as never)
    expect(result).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('returns a failure rather than throwing on a database error', async () => {
    installDb({ tables: { trim_payouts: { data: null, error: { code: '42P01', message: 'relation missing' } } } })
    const result = await mod.getPayRegister(range)
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/relation/)
  })
})

// ─── Static guard ────────────────────────────────────────────────────────────

describe('static guard: trim-pay.ts', () => {
  const source = readFileSync(path.join(__dirname, 'trim-pay.ts'), 'utf8')

  it("starts with 'use server' and has only async function / type exports", () => {
    expect(source.split('\n')[0]).toBe("'use server'")
    expect(source).not.toMatch(/^\s*export\s+(type|interface)?\s*\{/m)
    expect(source).not.toMatch(/^\s*export\s+(const|let|var|class|default|function\b)/m)
  })

  it('every exported action calls requireRole( or requireFinance( before anything else', () => {
    const re = /^export async function (\w+)/gm
    let m: RegExpExecArray | null
    const names: string[] = []
    while ((m = re.exec(source))) {
      const end = source.indexOf('\n}\n', m.index)
      const body = source.slice(m.index, end === -1 ? undefined : end + 3)
      expect(body, `${m[1]} must call requireRole() or requireFinance()`).toMatch(/requireRole\(|requireFinance\(/)
      // the gate comes before any database access
      const gate = body.search(/requireRole\(|requireFinance\(/)
      const db = body.search(/createServiceClient\(|callRpc\(/)
      if (db !== -1) expect(gate, `${m[1]} reaches the database before its gate`).toBeLessThan(db)
      names.push(m[1])
    }
    expect(names.sort()).toEqual(Object.keys(GATES).sort())
  })

  it('never accepts a person id from the client', () => {
    const code = source
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    for (const banned of ['completedBy', 'checkedOutBy', 'userId:', 'actorId']) {
      expect(code, `mentions ${banned}`).not.toContain(banned)
    }
    expect(code).not.toMatch(/\bapprovedBy\b/)
  })
})
