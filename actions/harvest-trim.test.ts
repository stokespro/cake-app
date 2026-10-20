// Coverage for actions/harvest-trim.ts (and, in the static guard at the bottom, all four Harvest & Trim
// action files). Same hermetic style as actions/packaging.test.ts: requireRole and createServiceClient
// are mocked, and a hand-rolled chainable fake records every (table, method, args) and every
// .rpc(name, params) so tests can assert the exact database traffic.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HARVEST_WEIGH_ROLES,
  TRIM_ADMIN_ROLES,
  TRIM_OPS_ROLES,
  TRIM_VIEW_ROLES,
} from '@/lib/trim/roles'
import { computePayAmount } from '@/lib/trim/pay'
import { evaluateVariance } from '@/lib/trim/variance'

const mockRequireRole = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

const mockCreateServiceClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}))

const real = await import('./harvest-trim')
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

const rpcCalls = (calls: RecordedCall[]) => calls.filter((c) => c.kind === 'rpc')
const fromCalls = (calls: RecordedCall[], table: string) => calls.filter((c) => c.kind === 'from' && c.name === table)
const hasOp = (call: RecordedCall, method: string) => call.ops.some((o) => o.method === method)

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = '11111111-1111-4111-8111-111111111111'
const HANGER = '22222222-2222-4222-8222-222222222222'
const BATCH = '33333333-3333-4333-8333-333333333333'
const LOAD = '44444444-4444-4444-8444-444444444444'
const CHECKOUT = '55555555-5555-4555-8555-555555555555'
const TRIMMER = '66666666-6666-4666-8666-666666666666'
const CYCLE = '77777777-7777-4777-8777-777777777777'
const STRAIN = '88888888-8888-4888-8888-888888888888'
const RATE = 225

const HOSTILE = { userId: 'evil', actorId: 'evil', completedBy: 'evil', checkedOutBy: 'evil', actor: 'evil' }

type Result = { success: boolean; error?: string; code?: string; data?: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

interface Scenario {
  checkout?: Record<string, unknown> | null
  settings?: Record<string, unknown> | null
  rpc?: Record<string, unknown>
  rpcResult?: { data: unknown; error: unknown }
  tables?: Record<string, unknown>
}

function checkoutRow(over: Record<string, unknown> = {}) {
  return {
    id: CHECKOUT,
    status: 'out',
    issued_g: 1000,
    issued_plant_count: 5,
    rate_per_lb_applied: RATE,
    variance_status: null,
    flower_g: null,
    ...over,
  }
}

function defaultRpc(fn: string, loadStatus = 'reconciled'): unknown {
  const load = { id: LOAD, status: loadStatus }
  switch (fn) {
    case 'fn_trim_create_load':
      return { id: LOAD, status: 'hung' }
    case 'fn_trim_correct_wet':
    case 'fn_trim_record_dry':
    case 'fn_trim_void':
      return { id: LOAD, status: 'dried' }
    case 'fn_trim_declare_batches':
      return {
        created: [{ id: BATCH, name: '1029-F5-VZ', strain_id: STRAIN, harvest_date: '2026-10-29' }],
        skipped: [],
      }
    case 'fn_trim_checkout':
      return {
        load: { id: LOAD, status: 'checked_out' },
        checkout: { id: CHECKOUT, seq: 1, trimmer_name: 'Maria', issued_g: 1000, issued_plant_count: 5 },
      }
    case 'fn_trim_resolve_variance':
      return { load, checkout: { id: CHECKOUT }, pay_entry: { id: 'p' } }
    default:
      return { load, checkout: { id: CHECKOUT }, pay_entry: null }
  }
}

function responderFor(s: Scenario = {}): Responder {
  return (call, terminal) => {
    if (call.kind === 'rpc') {
      if (s.rpcResult) return s.rpcResult
      return { data: s.rpc && call.name in s.rpc ? s.rpc[call.name] : defaultRpc(call.name), error: null }
    }
    if (s.tables && call.name in s.tables) return { data: s.tables[call.name], error: null }
    if (call.name === 'trim_checkouts' && terminal === 'maybeSingle') {
      return { data: s.checkout === undefined ? checkoutRow() : s.checkout, error: null }
    }
    if (call.name === 'trim_settings' && terminal === 'maybeSingle' && !hasOp(call, 'update')) {
      const d = s.settings === undefined ? { variance_pct_threshold: 5, variance_floor_g: 25 } : s.settings
      return { data: d, error: null }
    }
    if (terminal === 'maybeSingle' || terminal === 'single') return { data: null, error: null }
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

const GATES: Record<string, string[]> = {
  listHarvestCycles: TRIM_VIEW_ROLES,
  getCycleBatches: TRIM_VIEW_ROLES,
  listUnlinkedBatches: TRIM_OPS_ROLES,
  listTrimStrains: HARVEST_WEIGH_ROLES,
  declareHarvestBatches: HARVEST_WEIGH_ROLES,
  editDeclaredBatch: HARVEST_WEIGH_ROLES,
  removeDeclaredBatch: HARVEST_WEIGH_ROLES,
  linkBatchToCycle: TRIM_OPS_ROLES,
  recordHarvestWeight: HARVEST_WEIGH_ROLES,
  createLateEntryLoad: TRIM_OPS_ROLES,
  correctWetWeight: HARVEST_WEIGH_ROLES,
  recordDryWeight: TRIM_OPS_ROLES,
  correctDryWeight: TRIM_OPS_ROLES,
  checkOutLoad: TRIM_OPS_ROLES,
  releaseCheckout: TRIM_OPS_ROLES,
  checkInLoad: TRIM_OPS_ROLES,
  correctReturn: TRIM_OPS_ROLES,
  resolveVariance: TRIM_OPS_ROLES,
  reopenLoad: TRIM_ADMIN_ROLES,
  voidLoad: TRIM_OPS_ROLES,
  getTrimBoard: TRIM_VIEW_ROLES,
  getLoadHistory: TRIM_VIEW_ROLES,
  getTrimSettings: TRIM_VIEW_ROLES,
  updateTrimSettings: TRIM_ADMIN_ROLES,
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

  it('passes a missing-session reason straight through so handleSessionError can see it', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'No valid session' })
    const result = await exported.getTrimBoard({})
    expect(result).toEqual({ success: false, error: 'No valid session', code: 'FORBIDDEN' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('returns a failure instead of throwing when the database client cannot be built', async () => {
    mockCreateServiceClient.mockRejectedValue(new Error('Missing SUPABASE_SERVICE_ROLE_KEY'))
    const result = await mod.getTrimBoard()
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).not.toMatch(/SERVICE_ROLE/)
  })
})

// ─── Actor integrity ─────────────────────────────────────────────────────────

describe('actor integrity: the actor is always the session user', () => {
  const calls: Array<[string, string, () => Promise<Result>]> = [
    ['declareHarvestBatches', 'fn_trim_declare_batches', () =>
      mod.declareHarvestBatches({
        cycleId: CYCLE,
        batches: [{ strainId: STRAIN, name: '1029-F5-VZ', ...HOSTILE }],
        ...HOSTILE,
      } as never)],
    ['recordHarvestWeight', 'fn_trim_create_load', () =>
      mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 4, wetG: 2400, ...HOSTILE } as never)],
    ['createLateEntryLoad', 'fn_trim_create_load', () =>
      mod.createLateEntryLoad({ hangerId: HANGER, batchId: BATCH, dryG: 900, ...HOSTILE } as never)],
    ['correctWetWeight', 'fn_trim_correct_wet', () => mod.correctWetWeight({ loadId: LOAD, wetG: 2500, ...HOSTILE } as never)],
    ['recordDryWeight', 'fn_trim_record_dry', () => mod.recordDryWeight({ loadId: LOAD, dryG: 900, ...HOSTILE } as never)],
    ['correctDryWeight', 'fn_trim_record_dry', () => mod.correctDryWeight({ loadId: LOAD, dryG: 900, ...HOSTILE } as never)],
    ['checkOutLoad', 'fn_trim_checkout', () =>
      mod.checkOutLoad({ loadId: LOAD, trimmerId: TRIMMER, dryG: 900, ...HOSTILE } as never)],
    ['releaseCheckout', 'fn_trim_release', () => mod.releaseCheckout({ checkoutId: CHECKOUT, reason: 'wrong person', ...HOSTILE } as never)],
    ['checkInLoad', 'fn_trim_checkin', () =>
      mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95, ...HOSTILE } as never)],
    ['correctReturn', 'fn_trim_correct_return', () =>
      mod.correctReturn({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95, ...HOSTILE } as never)],
    ['resolveVariance', 'fn_trim_resolve_variance', () => mod.resolveVariance({ checkoutId: CHECKOUT, reason: 'moisture loss', ...HOSTILE } as never)],
    ['reopenLoad', 'fn_trim_reopen', () => mod.reopenLoad({ loadId: LOAD, reason: 'mis-weigh', ...HOSTILE } as never)],
    ['voidLoad', 'fn_trim_void', () => mod.voidLoad({ loadId: LOAD, reason: 'duplicate tag', ...HOSTILE } as never)],
  ]

  it.each(calls)('%s forwards session.userId and nothing from the client', async (name, rpc, run) => {
    const { calls: recorded } = installDb({
      checkout: checkoutRow({ status: name === 'correctReturn' ? 'returned' : name === 'resolveVariance' ? 'returned' : 'out', variance_status: 'flagged', flower_g: 500 }),
    })
    const result = await run()
    expect(result.success).toBe(true)

    const rpcs = rpcCalls(recorded)
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0].name).toBe(rpc)
    expect(rpcs[0].params?.p_actor).toBe(ACTOR)
    expect(JSON.stringify(rpcs[0].params)).not.toContain('evil')
  })

  it('declareHarvestBatches forwards only strain_id, name and harvest_date per batch', async () => {
    const { calls: recorded } = installDb()
    await mod.declareHarvestBatches({
      cycleId: CYCLE,
      batches: [{ strainId: STRAIN, name: ' 1029-F5-VZ ', harvestDate: '2026-10-29', ...HOSTILE } as never],
    })
    expect(rpcCalls(recorded)[0].params).toEqual({
      p_cycle_id: CYCLE,
      p_batches: [{ strain_id: STRAIN, name: '1029-F5-VZ', harvest_date: '2026-10-29' }],
      p_actor: ACTOR,
    })
  })
})

// ─── Rate and threshold integrity ────────────────────────────────────────────

describe('rate, threshold and issued-weight integrity', () => {
  it('checkOutLoad never forwards a client-supplied rate', async () => {
    const { calls } = installDb()
    await mod.checkOutLoad({
      loadId: LOAD,
      trimmerId: TRIMMER,
      ratePerLb: 999,
      rate_per_lb_applied: 999,
      payPerLb: 999,
    } as never)
    const [rpc] = rpcCalls(calls)
    expect(Object.keys(rpc.params ?? {}).sort()).toEqual(['p_actor', 'p_dry_g', 'p_load_id', 'p_trimmer_id'])
    expect(JSON.stringify(rpc.params)).not.toContain('999')
  })

  it('checkInLoad ignores client rate, thresholds and issued weight and reads them server-side', async () => {
    const { calls } = installDb()
    await mod.checkInLoad({
      checkoutId: CHECKOUT,
      flowerG: 600,
      trimG: 300,
      stemsG: 95,
      issuedG: 1,
      ratePerLb: 1,
      pctThreshold: 100,
      floorG: 100000,
      payAmount: 12345,
    } as never)
    const [rpc] = rpcCalls(calls)
    expect(rpc.params).toMatchObject({
      p_flag_pct: 5,
      p_flag_floor_g: 25,
      p_pay_amount: computePayAmount(600, RATE),
      p_variance_status: 'ok',
    })
    expect(JSON.stringify(rpc.params)).not.toContain('12345')
  })
})

// ─── RPC shapes ──────────────────────────────────────────────────────────────

describe('RPC shapes', () => {
  it('recordHarvestWeight -> fn_trim_create_load as a harvest weigh-in with no dry weight', async () => {
    const { calls } = installDb()
    const result = await mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 4, wetG: 2400.5 })
    expect(rpcCalls(calls)[0]).toMatchObject({
      name: 'fn_trim_create_load',
      params: {
        p_hanger_id: HANGER,
        p_batch_id: BATCH,
        p_plant_count: 4,
        p_wet_g: 2400.5,
        p_dry_g: null,
        p_source: 'harvest',
        p_actor: ACTOR,
      },
    })
    expect(result).toMatchObject({ success: true, data: { loadId: LOAD, wetG: 2400.5 } })
  })

  it('recordHarvestWeight reports running batch totals, and still succeeds if that read fails', async () => {
    installDb({ tables: { hanger_loads: [{ plant_count: 4, wet_g: 2400 }, { plant_count: 3, wet_g: 1800.25 }] } })
    const withTotals = await mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 4, wetG: 2400 })
    expect(withTotals.success && withTotals.data?.batchTotals).toEqual({ hangers: 2, plants: 7, wetG: 4200.25 })

    const { client } = createFakeDb((call) =>
      call.kind === 'rpc'
        ? { data: defaultRpc(call.name), error: null }
        : { data: null, error: { code: '500', message: 'boom' } }
    )
    mockCreateServiceClient.mockResolvedValue(client)
    const degraded = await mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 4, wetG: 2400 })
    expect(degraded.success && degraded.data?.batchTotals).toBeNull()
  })

  it('createLateEntryLoad -> trim_station source, dry required, wet and plants optional', async () => {
    const { calls } = installDb()
    await mod.createLateEntryLoad({ hangerId: HANGER, batchId: BATCH, dryG: 900 })
    expect(rpcCalls(calls)[0].params).toEqual({
      p_hanger_id: HANGER,
      p_batch_id: BATCH,
      p_plant_count: null,
      p_wet_g: null,
      p_dry_g: 900,
      p_source: 'trim_station',
      p_actor: ACTOR,
    })
  })

  it('correctWetWeight -> fn_trim_correct_wet; needs at least one of wet / plants', async () => {
    const { calls } = installDb()
    await mod.correctWetWeight({ loadId: LOAD, plantCount: 6 })
    expect(rpcCalls(calls)[0]).toMatchObject({
      name: 'fn_trim_correct_wet',
      params: { p_load_id: LOAD, p_wet_g: null, p_plant_count: 6, p_actor: ACTOR },
    })
    const none = await mod.correctWetWeight({ loadId: LOAD })
    expect(none.success).toBe(false)
  })

  it('recordDryWeight and correctDryWeight both use fn_trim_record_dry', async () => {
    const { calls } = installDb()
    await mod.recordDryWeight({ loadId: LOAD, dryG: 812.34 })
    await mod.correctDryWeight({ loadId: LOAD, dryG: 800 })
    expect(rpcCalls(calls).map((c) => [c.name, c.params])).toEqual([
      ['fn_trim_record_dry', { p_load_id: LOAD, p_dry_g: 812.34, p_actor: ACTOR }],
      ['fn_trim_record_dry', { p_load_id: LOAD, p_dry_g: 800, p_actor: ACTOR }],
    ])
  })

  it('checkOutLoad -> fn_trim_checkout, dry weight passed through only when given', async () => {
    const { calls } = installDb()
    const first = await mod.checkOutLoad({ loadId: LOAD, trimmerId: TRIMMER, dryG: 950 })
    const second = await mod.checkOutLoad({ loadId: LOAD, trimmerId: TRIMMER })
    expect(rpcCalls(calls).map((c) => c.params)).toEqual([
      { p_load_id: LOAD, p_trimmer_id: TRIMMER, p_dry_g: 950, p_actor: ACTOR },
      { p_load_id: LOAD, p_trimmer_id: TRIMMER, p_dry_g: null, p_actor: ACTOR },
    ])
    expect(first).toMatchObject({
      success: true,
      data: { checkoutId: CHECKOUT, seq: 1, trimmerName: 'Maria', issuedG: 1000, loadStatus: 'checked_out' },
    })
    expect(second.success).toBe(true)
  })

  it('checkOutLoad rejects a malformed trimmerId before the database', async () => {
    const result = await mod.checkOutLoad({ loadId: LOAD, trimmerId: 'not-a-uuid' })
    expect(result).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('releaseCheckout, reopenLoad and voidLoad -> their functions with a trimmed reason', async () => {
    const { calls } = installDb()
    await mod.releaseCheckout({ checkoutId: CHECKOUT, reason: '  wrong trimmer ' })
    await mod.reopenLoad({ loadId: LOAD, reason: ' mis-weigh ' })
    await mod.voidLoad({ loadId: LOAD, reason: ' duplicate tag ' })
    expect(rpcCalls(calls).map((c) => [c.name, c.params])).toEqual([
      ['fn_trim_release', { p_checkout_id: CHECKOUT, p_reason: 'wrong trimmer', p_actor: ACTOR }],
      ['fn_trim_reopen', { p_load_id: LOAD, p_reason: 'mis-weigh', p_actor: ACTOR }],
      ['fn_trim_void', { p_load_id: LOAD, p_reason: 'duplicate tag', p_actor: ACTOR }],
    ])
  })
})

describe('checkInLoad', () => {
  it('forwards evaluateVariance status and computePayAmount for a finished, in-threshold return', async () => {
    const { calls } = installDb()
    const result = await mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95 })

    const expected = evaluateVariance(
      { issuedG: 1000, flowerG: 600, trimG: 300, stemsG: 95 },
      { pctThreshold: 5, floorG: 25 }
    )
    expect(expected).toMatchObject({ valid: true, status: 'ok' })
    expect(rpcCalls(calls)[0]).toEqual({
      kind: 'rpc',
      name: 'fn_trim_checkin',
      ops: [],
      params: {
        p_checkout_id: CHECKOUT,
        p_return_kind: 'complete',
        p_flower_g: 600,
        p_trim_g: 300,
        p_stems_g: 95,
        p_variance_status: 'ok',
        p_flag_pct: 5,
        p_flag_floor_g: 25,
        p_pay_amount: computePayAmount(600, RATE),
        p_actor: ACTOR,
        p_remaining_g: 0,
        p_remaining_plants: 0,
      },
    })
    expect(result).toMatchObject({
      success: true,
      data: {
        outcome: 'reconciled',
        loadStatus: 'reconciled',
        varianceStatus: 'ok',
        varianceG: 5,
        totalG: 995,
        payAmount: computePayAmount(600, RATE),
      },
    })
  })

  it('flags an out-of-threshold return and reports no pay owed', async () => {
    const { calls } = installDb({ rpc: { fn_trim_checkin: { load: { id: LOAD, status: 'returned' }, checkout: { id: CHECKOUT }, pay_entry: null } } })
    const result = await mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 500, trimG: 300, stemsG: 100 })
    expect(rpcCalls(calls)[0].params).toMatchObject({ p_variance_status: 'flagged' })
    expect(result).toMatchObject({
      success: true,
      data: { outcome: 'flagged', loadStatus: 'returned', varianceStatus: 'flagged', varianceG: 100, payAmount: null },
    })
  })

  it('an over-return (gain) flags the same way', async () => {
    const { calls } = installDb({ rpc: { fn_trim_checkin: { load: { id: LOAD, status: 'returned' }, checkout: { id: CHECKOUT }, pay_entry: null } } })
    const result = await mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 700, trimG: 300, stemsG: 100 })
    expect(rpcCalls(calls)[0].params).toMatchObject({ p_variance_status: 'flagged' })
    expect(result).toMatchObject({ success: true, data: { direction: 'gain', varianceG: -100 } })
  })

  it('an unfinished return carries the remaining weight and plants (four-bucket variance)', async () => {
    const { calls } = installDb({ rpc: { fn_trim_checkin: { load: { id: LOAD, status: 'partial' }, checkout: { id: CHECKOUT }, pay_entry: {} } } })
    const result = await mod.checkInLoad({
      checkoutId: CHECKOUT,
      returnKind: 'unfinished',
      flowerG: 300,
      trimG: 200,
      stemsG: 95,
      remainingG: 400,
      remainingPlants: 2,
    })
    expect(rpcCalls(calls)[0].params).toMatchObject({
      p_return_kind: 'unfinished',
      p_remaining_g: 400,
      p_remaining_plants: 2,
      p_variance_status: 'ok',
    })
    expect(result).toMatchObject({
      success: true,
      data: { outcome: 'partial', processedG: 600, remainingPlants: 2, plantsFinished: 3, varianceG: 5 },
    })
  })

  it('accepts zero for a bucket (a trimmer may return no stems)', async () => {
    const { calls } = installDb()
    await mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 700, trimG: 300, stemsG: 0 })
    expect(rpcCalls(calls)[0].params).toMatchObject({ p_stems_g: 0 })
  })

  it('correctReturn uses fn_trim_correct_return and needs a returned episode', async () => {
    const { calls } = installDb({ checkout: checkoutRow({ status: 'returned' }) })
    const result = await mod.correctReturn({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95 })
    expect(result.success).toBe(true)
    expect(rpcCalls(calls)[0].name).toBe('fn_trim_correct_return')

    const wrong = installDb({ checkout: checkoutRow({ status: 'out' }) })
    const refused = await mod.correctReturn({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95 })
    expect(refused).toMatchObject({ success: false, code: 'STATE' })
    expect(rpcCalls(wrong.calls)).toHaveLength(0)
  })

  it('refuses a checkout that is not out, and a missing one, without calling the RPC', async () => {
    const returned = installDb({ checkout: checkoutRow({ status: 'returned' }) })
    expect(await mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95 })).toMatchObject({
      success: false,
      code: 'STATE',
    })
    expect(rpcCalls(returned.calls)).toHaveLength(0)

    const missing = installDb({ checkout: null })
    expect(await mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95 })).toMatchObject({
      success: false,
      code: 'NOT_FOUND',
    })
    expect(rpcCalls(missing.calls)).toHaveLength(0)
  })

  it('rejects inconsistent remaining arguments before any RPC', async () => {
    const base = { checkoutId: CHECKOUT, flowerG: 300, trimG: 200, stemsG: 95 }
    const cases = [
      { ...base, returnKind: 'unfinished' as const },
      { ...base, returnKind: 'unfinished' as const, remainingG: 400 },
      { ...base, returnKind: 'unfinished' as const, remainingG: 400, remainingPlants: 0 },
      { ...base, returnKind: 'unfinished' as const, remainingG: 1000, remainingPlants: 2 },
      { ...base, returnKind: 'unfinished' as const, remainingG: 400, remainingPlants: 6 },
      { ...base, remainingG: 50 },
      { ...base, remainingPlants: 1 },
      { ...base, returnKind: 'bogus' as never },
    ]
    for (const input of cases) {
      const { calls } = installDb()
      const result = await mod.checkInLoad(input)
      expect(result, JSON.stringify(input)).toMatchObject({ success: false, code: 'INVALID' })
      expect(rpcCalls(calls)).toHaveLength(0)
    }
  })

  it('fails closed if the DB returns an unexpected load status or shape', async () => {
    installDb({ rpc: { fn_trim_checkin: { load: { id: LOAD, status: 'hung' }, checkout: { id: CHECKOUT } } } })
    expect((await mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95 })).success).toBe(false)
    installDb({ rpc: { fn_trim_checkin: {} } })
    expect((await mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95 })).success).toBe(false)
  })
})

describe('resolveVariance', () => {
  const flagged = checkoutRow({ status: 'returned', variance_status: 'flagged', flower_g: 500 })

  it('computes the pay itself from the stored flower and rate', async () => {
    const { calls } = installDb({ checkout: flagged })
    const result = await mod.resolveVariance({ checkoutId: CHECKOUT, reason: 'moisture loss', payAmount: 99999 } as never)
    expect(rpcCalls(calls)[0]).toMatchObject({
      name: 'fn_trim_resolve_variance',
      params: {
        p_checkout_id: CHECKOUT,
        p_reason: 'moisture loss',
        p_pay_amount: computePayAmount(500, RATE),
        p_actor: ACTOR,
      },
    })
    expect(result).toEqual({ success: true, data: { loadStatus: 'reconciled' } })
  })

  it('refuses a return that is not flagged', async () => {
    const { calls } = installDb({ checkout: checkoutRow({ status: 'returned', variance_status: 'ok', flower_g: 500 }) })
    expect(await mod.resolveVariance({ checkoutId: CHECKOUT, reason: 'moisture loss' })).toMatchObject({
      success: false,
      code: 'STATE',
    })
    expect(rpcCalls(calls)).toHaveLength(0)
  })
})

// ─── Error mapping ───────────────────────────────────────────────────────────

describe('error mapping', () => {
  const MAPPED: Array<[string, string]> = [
    ['NOT_FOUND', 'NOT_FOUND'],
    ['STATE', 'STATE'],
    ['INVALID', 'INVALID'],
    ['FORBIDDEN', 'FORBIDDEN'],
    ['DUPLICATE_OPEN', 'DUPLICATE_OPEN'],
    ['ALREADY_OUT', 'ALREADY_OUT'],
    ['BATCH_REQUIRED', 'BATCH_REQUIRED'],
    ['DUPLICATE_NAME', 'DUPLICATE_NAME'],
  ]

  it.each(MAPPED)('TRIM_E_%s -> code %s with the human part of the message', async (dbCode, actionCode) => {
    installDb({ rpcResult: { data: null, error: { code: 'P0001', message: `TRIM_E_${dbCode}: the human message` } } })
    const result = await mod.voidLoad({ loadId: LOAD, reason: 'duplicate tag' })
    expect(result).toEqual({ success: false, error: 'the human message', code: actionCode })
  })

  it('maps the one-out unique index to ALREADY_OUT', async () => {
    installDb({
      rpcResult: {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uidx_trim_checkouts_one_out_per_load"',
        },
      },
    })
    expect(await mod.checkOutLoad({ loadId: LOAD, trimmerId: TRIMMER })).toMatchObject({
      success: false,
      code: 'ALREADY_OUT',
    })
  })

  it('maps the one-open-load unique index to DUPLICATE_OPEN', async () => {
    installDb({
      rpcResult: {
        data: null,
        error: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "uidx_hanger_loads_one_open_per_hanger"',
        },
      },
    })
    expect(await mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 3, wetG: 1000 })).toMatchObject({
      success: false,
      code: 'DUPLICATE_OPEN',
    })
  })

  it('editDeclaredBatch reports a taken name as DUPLICATE_NAME, from the pre-check and from the unique index', async () => {
    const { calls } = installDb({ tables: { batches: [{ id: 'someone-else' }] } })
    expect(await mod.editDeclaredBatch({ batchId: BATCH, name: '1029-F5-VZ' })).toEqual({
      success: false,
      error: 'A batch with that name already exists.',
      code: 'DUPLICATE_NAME',
    })
    expect(fromCalls(calls, 'batches').some((c) => hasOp(c, 'update'))).toBe(false)

    // the racy case: the pre-check saw nothing, the unique index catches the write
    const raced = createFakeDb((call) =>
      call.name === 'batches' && hasOp(call, 'update')
        ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "batches_name_key"' } }
        : { data: [], error: null }
    )
    mockCreateServiceClient.mockResolvedValue(raced.client)
    expect(await mod.editDeclaredBatch({ batchId: BATCH, name: '1029-F5-VZ' })).toMatchObject({
      success: false,
      code: 'DUPLICATE_NAME',
    })
  })

  it('hides an unrecognised database error behind a generic message and logs the real one', async () => {
    installDb({ rpcResult: { data: null, error: { code: '23514', message: 'new row violates check constraint "co_ok_within_threshold"' } } })
    const result = await mod.voidLoad({ loadId: LOAD, reason: 'duplicate tag' })
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/co_ok_within_threshold/)
    expect(result.code).toBeUndefined()
    expect(console.error).toHaveBeenCalledWith('[harvest-trim] voidLoad error:', expect.anything())
  })

  it('maps errors from direct reads too', async () => {
    installDb({ tables: {} })
    const { client } = createFakeDb(() => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }))
    mockCreateServiceClient.mockResolvedValue(client)
    const result = await mod.getTrimBoard()
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/relation/)
  })
})

// ─── Validation before the database ──────────────────────────────────────────

describe('validation happens before any database call', () => {
  const cases: Array<[string, () => Promise<Result>]> = [
    ['resolveVariance: reason too short', () => mod.resolveVariance({ checkoutId: CHECKOUT, reason: 'ab' })],
    ['resolveVariance: whitespace reason', () => mod.resolveVariance({ checkoutId: CHECKOUT, reason: '   ' })],
    ['releaseCheckout: reason too short', () => mod.releaseCheckout({ checkoutId: CHECKOUT, reason: 'x' })],
    ['voidLoad: reason too short', () => mod.voidLoad({ loadId: LOAD, reason: '' })],
    ['reopenLoad: reason too short', () => mod.reopenLoad({ loadId: LOAD, reason: 'no' })],
    ['checkInLoad: negative flower', () => mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: -1, trimG: 1, stemsG: 1 })],
    ['checkInLoad: negative stems', () => mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 1, trimG: 1, stemsG: -0.5 })],
    ['checkInLoad: NaN', () => mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: Number.NaN, trimG: 1, stemsG: 1 })],
    ['checkInLoad: string weight', () => mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: '600' as never, trimG: 1, stemsG: 1 })],
    ['checkInLoad: over the cap', () => mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 300000, trimG: 1, stemsG: 1 })],
    ['checkInLoad: bad id', () => mod.checkInLoad({ checkoutId: 'x', flowerG: 1, trimG: 1, stemsG: 1 })],
    ['correctReturn: negative trim', () => mod.correctReturn({ checkoutId: CHECKOUT, flowerG: 1, trimG: -1, stemsG: 1 })],
    ['recordHarvestWeight: negative wet', () => mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 3, wetG: -5 })],
    ['recordHarvestWeight: zero wet', () => mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 3, wetG: 0 })],
    ['recordHarvestWeight: Infinity', () => mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 3, wetG: Infinity })],
    ['recordHarvestWeight: zero plants', () => mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 0, wetG: 10 })],
    ['recordHarvestWeight: fractional plants', () => mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 1.5, wetG: 10 })],
    ['recordHarvestWeight: 501 plants', () => mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 501, wetG: 10 })],
    ['createLateEntryLoad: negative dry', () => mod.createLateEntryLoad({ hangerId: HANGER, batchId: BATCH, dryG: -1 })],
    ['createLateEntryLoad: negative wet', () => mod.createLateEntryLoad({ hangerId: HANGER, batchId: BATCH, dryG: 5, wetG: -1 })],
    ['recordDryWeight: negative', () => mod.recordDryWeight({ loadId: LOAD, dryG: -3 })],
    ['correctDryWeight: zero', () => mod.correctDryWeight({ loadId: LOAD, dryG: 0 })],
    ['correctWetWeight: negative', () => mod.correctWetWeight({ loadId: LOAD, wetG: -2 })],
    ['checkOutLoad: negative dry', () => mod.checkOutLoad({ loadId: LOAD, trimmerId: TRIMMER, dryG: -1 })],
    ['declareHarvestBatches: none', () => mod.declareHarvestBatches({ cycleId: CYCLE, batches: [] })],
    ['declareHarvestBatches: 51', () =>
      mod.declareHarvestBatches({
        cycleId: CYCLE,
        batches: Array.from({ length: 51 }, (_, i) => ({ strainId: STRAIN, name: `b${i}` })),
      })],
    ['declareHarvestBatches: blank name', () => mod.declareHarvestBatches({ cycleId: CYCLE, batches: [{ strainId: STRAIN, name: '  ' }] })],
    ['declareHarvestBatches: name too long', () =>
      mod.declareHarvestBatches({ cycleId: CYCLE, batches: [{ strainId: STRAIN, name: 'x'.repeat(65) }] })],
    ['declareHarvestBatches: duplicate names', () =>
      mod.declareHarvestBatches({
        cycleId: CYCLE,
        batches: [{ strainId: STRAIN, name: 'A-1' }, { strainId: STRAIN, name: 'a-1' }],
      })],
    ['declareHarvestBatches: bad date', () =>
      mod.declareHarvestBatches({ cycleId: CYCLE, batches: [{ strainId: STRAIN, name: 'A-1', harvestDate: '2026-02-30' }] })],
    ['declareHarvestBatches: bad strain', () => mod.declareHarvestBatches({ cycleId: CYCLE, batches: [{ strainId: 'x', name: 'A-1' }] })],
    ['editDeclaredBatch: nothing to change', () => mod.editDeclaredBatch({ batchId: BATCH })],
    ['editDeclaredBatch: blank name', () => mod.editDeclaredBatch({ batchId: BATCH, name: ' ' })],
    ['linkBatchToCycle: bad date', () => mod.linkBatchToCycle(BATCH, CYCLE, 'tomorrow')],
    ['updateTrimSettings: negative pct', () => mod.updateTrimSettings({ variancePctThreshold: -1 })],
    ['updateTrimSettings: pct over 100', () => mod.updateTrimSettings({ variancePctThreshold: 101 })],
    ['updateTrimSettings: negative floor', () => mod.updateTrimSettings({ varianceFloorG: -1 })],
    ['updateTrimSettings: empty', () => mod.updateTrimSettings({})],
    ['getTrimBoard: bad cycle', () => mod.getTrimBoard({ cycleId: 'nope' })],
    ['getLoadHistory: bad id', () => mod.getLoadHistory('nope')],
  ]

  it.each(cases)('%s', async (_name, run) => {
    const result = await run()
    expect(result.success).toBe(false)
    expect(result.code).toBe('INVALID')
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })
})

// ─── Zero-row writes and empty RPC results ───────────────────────────────────

describe('zero-row direct writes and empty RPC results fail (SPRO-131)', () => {
  const declaredBatch = { id: BATCH, name: '1029-F5-VZ', room_cycle_id: CYCLE, harvest_date: null }

  it('editDeclaredBatch fails when the UPDATE matches no rows', async () => {
    const { calls } = installDb({ tables: { batches: [] } })
    const result = await mod.editDeclaredBatch({ batchId: BATCH, name: '1029-F5-VZ-2' })
    expect(result.success).toBe(false)
    const update = fromCalls(calls, 'batches').find((c) => hasOp(c, 'update'))!
    expect(hasOp(update, 'select')).toBe(true)
    expect(update.ops.find((o) => o.method === 'select')?.args).toEqual(['id'])
    expect(fromCalls(calls, 'trim_events')).toHaveLength(0)
  })

  it('editDeclaredBatch scopes the write to declared (inactive, linked) batches', async () => {
    const { calls } = installDb({ tables: { batches: [{ id: BATCH }] } })
    const result = await mod.editDeclaredBatch({ batchId: BATCH, harvestDate: '2026-10-30' })
    expect(result.success).toBe(true)
    const update = fromCalls(calls, 'batches').find((c) => hasOp(c, 'update'))!
    expect(update.ops).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['id', BATCH] },
        { method: 'eq', args: ['is_active', false] },
        { method: 'not', args: ['room_cycle_id', 'is', null] },
      ])
    )
  })

  it('editDeclaredBatch refuses once the batch has loads, without writing', async () => {
    const { calls } = installDb({ tables: { hanger_loads: [{ id: LOAD }] } })
    const result = await mod.editDeclaredBatch({ batchId: BATCH, name: 'new-name' })
    expect(result).toMatchObject({ success: false, code: 'STATE' })
    expect(fromCalls(calls, 'batches').some((c) => hasOp(c, 'update'))).toBe(false)
  })

  it('removeDeclaredBatch fails when the DELETE matches no rows, and refuses a batch with loads', async () => {
    installDb()
    // maybeSingle on batches returns null -> not found
    expect(await mod.removeDeclaredBatch(BATCH)).toMatchObject({ success: false, code: 'NOT_FOUND' })

    const { client, calls } = createFakeDb((call, terminal) => {
      if (call.name === 'batches' && terminal === 'maybeSingle') return { data: { id: BATCH, name: 'n' }, error: null }
      return { data: [], error: null }
    })
    mockCreateServiceClient.mockResolvedValue(client)
    const zero = await mod.removeDeclaredBatch(BATCH)
    expect(zero).toMatchObject({ success: false, code: 'STATE' })
    expect(fromCalls(calls, 'batches').some((c) => hasOp(c, 'delete') && hasOp(c, 'select'))).toBe(true)

    const blocked = createFakeDb((call, terminal) => {
      if (call.name === 'batches' && terminal === 'maybeSingle') return { data: { id: BATCH, name: 'n' }, error: null }
      if (call.name === 'hanger_loads') return { data: [{ id: LOAD }], error: null }
      return { data: [], error: null }
    })
    mockCreateServiceClient.mockResolvedValue(blocked.client)
    expect(await mod.removeDeclaredBatch(BATCH)).toMatchObject({ success: false, code: 'STATE' })
    expect(fromCalls(blocked.calls, 'batches').some((c) => hasOp(c, 'delete'))).toBe(false)
  })

  it('linkBatchToCycle fails on zero rows, uses compare-and-swap, and will not move a batch that has loads', async () => {
    const respond = (loads: unknown[], updated: unknown[]): Responder => (call, terminal) => {
      if (call.name === 'batches' && terminal === 'maybeSingle') return { data: declaredBatch, error: null }
      if (call.name === 'room_cycles' && terminal === 'maybeSingle') return { data: { id: CYCLE, harvest_date: '2026-10-29' }, error: null }
      if (call.name === 'hanger_loads') return { data: loads, error: null }
      if (call.name === 'batches' && hasOp(call, 'update')) return { data: updated, error: null }
      return { data: [], error: null }
    }

    const zero = createFakeDb(respond([], []))
    mockCreateServiceClient.mockResolvedValue(zero.client)
    expect((await mod.linkBatchToCycle(BATCH, CYCLE)).success).toBe(false)

    const good = createFakeDb(respond([], [{ id: BATCH }]))
    mockCreateServiceClient.mockResolvedValue(good.client)
    expect((await mod.linkBatchToCycle(BATCH, CYCLE)).success).toBe(true)
    const update = fromCalls(good.calls, 'batches').find((c) => hasOp(c, 'update'))!
    expect(update.ops).toEqual(
      expect.arrayContaining([
        { method: 'update', args: [{ room_cycle_id: CYCLE, harvest_date: '2026-10-29' }] },
        { method: 'eq', args: ['room_cycle_id', CYCLE] },
      ])
    )

    const other = '99999999-9999-4999-8999-999999999999'
    const moved = createFakeDb(respond([{ id: LOAD }], [{ id: BATCH }]))
    mockCreateServiceClient.mockResolvedValue(moved.client)
    expect(await mod.linkBatchToCycle(BATCH, other)).toMatchObject({ success: false, code: 'STATE' })
    expect(fromCalls(moved.calls, 'batches').some((c) => hasOp(c, 'update'))).toBe(false)
  })

  it('updateTrimSettings fails when the UPDATE matches no rows', async () => {
    installDb({ tables: { trim_settings: [] } })
    expect((await mod.updateTrimSettings({ variancePctThreshold: 6 })).success).toBe(false)
  })

  it('updateTrimSettings writes the actor and returns the new settings', async () => {
    const row = { variance_pct_threshold: 6, variance_floor_g: 25, updated_by: ACTOR, updated_at: 't' }
    const { calls } = installDb({ tables: { trim_settings: [row] } })
    const result = await mod.updateTrimSettings({ variancePctThreshold: 6, updated_by: 'evil' } as never)
    expect(result).toMatchObject({ success: true, data: { variance_pct_threshold: 6 } })
    const update = fromCalls(calls, 'trim_settings').find((c) => hasOp(c, 'update'))!
    expect(update.ops.find((o) => o.method === 'update')?.args[0]).toEqual({
      variance_pct_threshold: 6,
      updated_by: ACTOR,
    })
  })

  it.each([
    ['null', { data: null, error: null }],
    ['undefined', { data: undefined, error: null }],
    ['empty array', { data: [], error: null }],
  ])('an RPC returning %s is a failure, never a success', async (_label, rpcResult) => {
    installDb({ rpcResult })
    for (const run of [
      () => mod.voidLoad({ loadId: LOAD, reason: 'duplicate tag' }),
      () => mod.checkOutLoad({ loadId: LOAD, trimmerId: TRIMMER }),
      () => mod.checkInLoad({ checkoutId: CHECKOUT, flowerG: 600, trimG: 300, stemsG: 95 }),
      () => mod.recordHarvestWeight({ hangerId: HANGER, batchId: BATCH, plantCount: 3, wetG: 100 }),
      () => mod.declareHarvestBatches({ cycleId: CYCLE, batches: [{ strainId: STRAIN, name: 'A-1' }] }),
    ]) {
      expect((await run()).success).toBe(false)
    }
  })
})

// ─── Reads ───────────────────────────────────────────────────────────────────

describe('getTrimBoard', () => {
  function loadRow(i: number, status: string, extra: Record<string, unknown> = {}) {
    return {
      id: `load-${i}`,
      status,
      plant_count: 4,
      wet_g: 2000,
      dry_g: 500,
      remaining_g: 500,
      remaining_plant_count: 4,
      updated_at: '2026-10-20T10:00:00Z',
      hanger: { code: `H1B-${String(i).padStart(3, '0')}` },
      batch: { id: BATCH, name: '1001-F1-VZ', harvest_date: '2026-10-01', room_cycle_id: CYCLE, strain: { id: STRAIN, name: 'Vz' } },
      trim_checkouts: [],
      ...extra,
    }
  }

  it('issues the same few queries for 5 hangers or 250: nothing fans out per hanger', async () => {
    const run = async (n: number) => {
      const rows = Array.from({ length: n }, (_, i) => loadRow(i + 1, 'dried'))
      const { calls } = installDb({ tables: { hanger_loads: rows } })
      const result = await mod.getTrimBoard({ cycleId: CYCLE })
      expect(result.success).toBe(true)
      return calls.map((c) => `${c.kind}:${c.name}`)
    }
    const small = await run(5)
    const large = await run(250)
    expect(large).toEqual(small)
    expect(large.length).toBeLessThanOrEqual(3)
  })

  it('buckets loads and builds the flagged queue, the out list and per-trimmer counts', async () => {
    const out = loadRow(1, 'checked_out', {
      trim_checkouts: [
        { id: 'co-1', seq: 1, status: 'out', trimmer_id: TRIMMER, trimmer_name: 'Maria', issued_g: 500, issued_plant_count: 4, checked_out_at: 't1' },
      ],
    })
    const flagged = loadRow(2, 'returned', {
      trim_checkouts: [
        { id: 'co-2a', seq: 1, status: 'returned', trimmer_id: TRIMMER, trimmer_name: 'Old', issued_g: 500, flower_g: 1 },
        { id: 'co-2b', seq: 2, status: 'returned', trimmer_id: TRIMMER, trimmer_name: 'Maria', issued_g: 500, flower_g: 200, variance_g: 80, variance_pct: 16, return_kind: 'complete', returned_at: 't2' },
      ],
    })
    const partial = loadRow(3, 'partial')
    installDb({
      tables: {
        hanger_loads: [out, flagged, partial, loadRow(4, 'reconciled'), loadRow(5, 'void')],
        trim_staff: [{ id: TRIMMER, full_name: 'Maria Lopez', display_name: 'Maria' }, { id: 'other', full_name: 'Sam', display_name: null }],
        batches: [{ id: BATCH, name: '1001-F1-VZ', harvest_date: '2026-10-01', room_cycle_id: CYCLE, strain: { id: STRAIN, name: 'Vz' } }],
      },
    })
    const result = await mod.getTrimBoard({ cycleId: CYCLE })
    expect(result.success).toBe(true)
    const board = result.data!
    expect(board.scope).toBe('cycle')
    expect(board.batches).toHaveLength(1)
    expect(board.batches[0].counts).toEqual({ checked_out: 1, returned: 1, partial: 1, reconciled: 1, void: 1 })
    expect(board.batches[0].loads).toBe(4)
    expect(board.out).toEqual([expect.objectContaining({ hangerCode: 'H1B-001', trimmerName: 'Maria', issuedG: 500 })])
    expect(board.flagged).toEqual([expect.objectContaining({ checkoutId: 'co-2b', trimmerName: 'Maria', varianceG: 80 })])
    expect(board.partial).toHaveLength(1)
    expect(board.trimmers).toEqual([
      { id: TRIMMER, name: 'Maria', hangersOut: 1, gramsOut: 500 },
      { id: 'other', name: 'Sam', hangersOut: 0, gramsOut: 0 },
    ])
  })

  it('without a cycle it scopes to open work only', async () => {
    const { calls } = installDb()
    const result = await mod.getTrimBoard()
    expect(result.success && result.data?.scope).toBe('open_work')
    const loads = fromCalls(calls, 'hanger_loads')[0]
    expect(loads.ops).toContainEqual({ method: 'not', args: ['status', 'in', '(reconciled,void)'] })
    expect(fromCalls(calls, 'batches')).toHaveLength(0)
  })

  it('selects named columns on the hot path (no select star)', async () => {
    const { calls } = installDb()
    await mod.getTrimBoard({ cycleId: CYCLE })
    for (const c of calls) {
      for (const op of c.ops.filter((o) => o.method === 'select')) {
        expect(String(op.args[0])).not.toMatch(/^\*$|(^|,)\s*\*\s*(,|$)/)
      }
    }
  })
})

describe('getLoadHistory', () => {
  it('strips dollar fields from event payloads for roles without pay access', async () => {
    const events = [
      { id: 1, occurred_at: 't', actor_user_id: ACTOR, event_type: 'checked_in', hanger_id: null, load_id: LOAD, checkout_id: null, batch_id: null, payload: { flower_g: 600, pay_amount: 61.2, rate_per_lb_applied: 225, nested: { amount: 1, keep: 2 } } },
    ]
    asRole('grow')
    installDb({ tables: { trim_events: events } })
    const grow = await mod.getLoadHistory(LOAD)
    expect(grow.data?.events[0].payload).toEqual({ flower_g: 600, nested: { keep: 2 } })

    asRole('trim_manager')
    installDb({ tables: { trim_events: events } })
    const manager = await mod.getLoadHistory(LOAD)
    expect(manager.data?.events[0].payload).toMatchObject({ pay_amount: 61.2, rate_per_lb_applied: 225 })
  })
})

describe('listHarvestCycles / getCycleBatches / listUnlinkedBatches', () => {
  it('lists only active cycles in flower, harvest, dry and trim', async () => {
    const { calls } = installDb({
      tables: {
        room_cycles: [
          { id: CYCLE, cycle_number: 5, current_stage: 'flower', harvest_date: '2026-10-29', dry_start: null, trim_start: null, room: { id: 'r', room_name: 'F5', room_number: 5 }, batches: [{ count: 0 }] },
        ],
      },
    })
    const result = await mod.listHarvestCycles()
    expect(result.data).toEqual([expect.objectContaining({ id: CYCLE, roomName: 'F5', batchCount: 0, stage: 'flower' })])
    const ops = calls[0].ops
    expect(ops).toContainEqual({ method: 'eq', args: ['status', 'active'] })
    expect(ops).toContainEqual({ method: 'in', args: ['current_stage', ['flower', 'harvest', 'dry', 'trim']] })
  })

  describe('includeCompleted', () => {
    const cycleRow = (id: string, over: Record<string, unknown>) => ({
      id,
      cycle_number: 6,
      current_stage: 'trim',
      status: 'active',
      harvest_date: '2026-09-17',
      dry_start: null,
      trim_start: null,
      actual_end_date: null,
      room: { id: 'r', room_name: 'F6', room_number: 6 },
      batches: [{ count: 1 }],
      ...over,
    })
    const ACTIVE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
    const ACTIVE_B = 'aaaaaaaa-0000-4000-8000-000000000002'
    const DONE_OLD = 'cccccccc-0000-4000-8000-000000000001'
    const DONE_NEW = 'cccccccc-0000-4000-8000-000000000002'

    /** Answers each room_cycles query by the status it asked for, as the database would. */
    function installCycles(rows: { active: unknown[]; completed: unknown[] }) {
      const db = createFakeDb((call) => {
        const status = call.ops.find((o) => o.method === 'eq' && o.args[0] === 'status')?.args[1]
        return { data: status === 'completed' ? rows.completed : rows.active, error: null }
      })
      mockCreateServiceClient.mockResolvedValue(db.client)
      return db
    }

    it('the default call never asks for completed cycles', async () => {
      const { calls } = installCycles({ active: [cycleRow(ACTIVE_A, {})], completed: [cycleRow(DONE_NEW, { status: 'completed' })] })
      const result = await mod.listHarvestCycles()
      expect(calls).toHaveLength(1)
      expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['status', 'active'] })
      expect(result.data?.map((c: { id: string }) => c.id)).toEqual([ACTIVE_A])
      expect(result.data?.[0]).toMatchObject({ isCompleted: false, actualEndDate: null })
    })

    it('an empty options object behaves like no argument', async () => {
      const { calls } = installCycles({ active: [], completed: [] })
      await mod.listHarvestCycles({})
      expect(calls).toHaveLength(1)
    })

    it('also queries completed cycles in harvest, dry and trim, bounded to the last 120 days', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-14T12:00:00Z'))
      try {
        const { calls } = installCycles({ active: [], completed: [] })
        await mod.listHarvestCycles({ includeCompleted: true })
        const done = calls.find((c) => c.ops.some((o) => o.method === 'eq' && o.args[1] === 'completed'))
        expect(done).toBeDefined()
        expect(done!.ops).toContainEqual({ method: 'in', args: ['current_stage', ['harvest', 'dry', 'trim']] })
        // 2026-10-14 minus 120 days
        expect(done!.ops).toContainEqual({ method: 'gte', args: ['harvest_date', '2026-06-16'] })
        // the active query is untouched
        const live = calls.find((c) => c.ops.some((o) => o.method === 'eq' && o.args[1] === 'active'))
        expect(live!.ops).toContainEqual({ method: 'in', args: ['current_stage', ['flower', 'harvest', 'dry', 'trim']] })
      } finally {
        vi.useRealTimers()
      }
    })

    it('flags completed cycles, carries their end date, and orders active first then newest harvest first', async () => {
      installCycles({
        active: [
          cycleRow(ACTIVE_A, { harvest_date: '2026-10-29', current_stage: 'flower', room: { id: 'r2', room_name: 'F2', room_number: 2 } }),
          cycleRow(ACTIVE_B, { harvest_date: '2026-11-05' }),
        ],
        completed: [
          cycleRow(DONE_NEW, { status: 'completed', harvest_date: '2026-09-17', actual_end_date: '2026-10-09' }),
          cycleRow(DONE_OLD, { status: 'completed', harvest_date: '2026-08-01', actual_end_date: '2026-08-20' }),
        ],
      })
      const result = await mod.listHarvestCycles({ includeCompleted: true })
      expect(result.data?.map((c: { id: string }) => c.id)).toEqual([ACTIVE_A, ACTIVE_B, DONE_NEW, DONE_OLD])
      expect(result.data?.map((c: { isCompleted: boolean }) => c.isCompleted)).toEqual([false, false, true, true])
      expect(result.data?.[0].actualEndDate).toBeNull()
      expect(result.data?.[2]).toMatchObject({ roomName: 'F6', stage: 'trim', actualEndDate: '2026-10-09' })
    })

    it('a completed cycle with no recorded end date still reads as completed', async () => {
      installCycles({ active: [], completed: [cycleRow(DONE_NEW, { status: 'completed' })] })
      const result = await mod.listHarvestCycles({ includeCompleted: true })
      expect(result.data?.[0]).toMatchObject({ isCompleted: true, actualEndDate: null })
    })

    it('surfaces a failure from either query', async () => {
      const db = createFakeDb((call) => {
        const completed = call.ops.some((o) => o.method === 'eq' && o.args[1] === 'completed')
        return completed ? { data: null, error: { message: 'boom' } } : { data: [], error: null }
      })
      mockCreateServiceClient.mockResolvedValue(db.client)
      const result = await mod.listHarvestCycles({ includeCompleted: true })
      expect(result.success).toBe(false)
    })
  })

  it('counts a batch\'s loads by status (non-void)', async () => {
    installDb({
      tables: {
        batches: [{ id: BATCH, name: 'b', harvest_date: null, is_active: false, strain: { id: STRAIN, name: 'Vz' }, hanger_loads: [{ status: 'dried' }, { status: 'dried' }, { status: 'void' }] }],
      },
    })
    const result = await mod.getCycleBatches(CYCLE)
    expect(result.data?.[0]).toMatchObject({ loadCount: 2, counts: { dried: 2, void: 1 } })
  })

  it('listUnlinkedBatches filters on a null cycle and sanitises the search term', async () => {
    const { calls } = installDb()
    await mod.listUnlinkedBatches('  100%_,(x)  ')
    expect(calls[0].ops).toContainEqual({ method: 'is', args: ['room_cycle_id', null] })
    expect(calls[0].ops).toContainEqual({ method: 'ilike', args: ['name', '%100x%'] })
  })
})

describe('listTrimStrains', () => {
  const S1 = '99999999-0000-4000-8000-000000000001'
  const S2 = '99999999-0000-4000-8000-000000000002'
  const S3 = '99999999-0000-4000-8000-000000000003'
  const OTHER_CYCLE = '77777777-7777-4777-8777-777777777778'

  const strains = [
    { id: S1, name: 'Cherry Mintz' },
    { id: S2, name: 'Gelato 41' },
    { id: S3, name: 'Zkittlez' },
  ]
  // newest first, as the query orders them
  const batches = [
    { strain_id: S1, name: '1029-F5-CM-2', created_at: '2026-10-01T00:00:00Z', room_cycle_id: CYCLE },
    { strain_id: S2, name: '0915-F3-GL', created_at: '2026-09-15T00:00:00Z', room_cycle_id: OTHER_CYCLE },
    { strain_id: S1, name: '0723-F1-CM', created_at: '2026-07-23T00:00:00Z', room_cycle_id: OTHER_CYCLE },
  ]

  it('returns every strain by name with its latest batch and whether the cycle already has one', async () => {
    const { calls } = installDb({ tables: { strains, batches } })
    const result = await mod.listTrimStrains(CYCLE)
    expect(result).toEqual({
      success: true,
      data: [
        { id: S1, name: 'Cherry Mintz', latestBatchName: '1029-F5-CM-2', latestBatchCreatedAt: '2026-10-01T00:00:00Z', hasBatchInCycle: true },
        { id: S2, name: 'Gelato 41', latestBatchName: '0915-F3-GL', latestBatchCreatedAt: '2026-09-15T00:00:00Z', hasBatchInCycle: false },
        { id: S3, name: 'Zkittlez', latestBatchName: null, latestBatchCreatedAt: null, hasBatchInCycle: false },
      ],
    })
    // exactly two queries, no per-strain lookups
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.name).sort()).toEqual(['batches', 'strains'])
  })

  it('applies NO availability filter (strains.availability is menu-facing)', async () => {
    const { calls } = installDb({ tables: { strains, batches } })
    await mod.listTrimStrains(CYCLE)
    const strainCall = calls.find((c) => c.name === 'strains')!
    expect(strainCall.ops.map((o) => o.method).sort()).toEqual(['order', 'select'])
    expect(strainCall.ops).toContainEqual({ method: 'order', args: ['name', { ascending: true }] })
    const selected = String(strainCall.ops.find((o) => o.method === 'select')?.args[0])
    expect(selected).toBe('id, name')
    expect(JSON.stringify(calls)).not.toMatch(/availab/i)
  })

  it('scans batches newest first with a bounded limit and named columns', async () => {
    const { calls } = installDb({ tables: { strains, batches } })
    await mod.listTrimStrains()
    const batchCall = calls.find((c) => c.name === 'batches')!
    expect(batchCall.ops).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] })
    expect(batchCall.ops.find((o) => o.method === 'limit')?.args[0]).toBeGreaterThan(0)
    expect(String(batchCall.ops.find((o) => o.method === 'select')?.args[0])).toBe('strain_id, name, created_at, room_cycle_id')
  })

  it('without a cycle nothing is marked as already declared', async () => {
    installDb({ tables: { strains, batches } })
    const result = await mod.listTrimStrains()
    expect(result.data!.every((s: { hasBatchInCycle: boolean }) => !s.hasBatchInCycle)).toBe(true)
    expect(result.data![0].latestBatchName).toBe('1029-F5-CM-2')
  })

  it('an empty strains table is an empty list', async () => {
    installDb({ tables: { strains: [], batches: [] } })
    expect(await mod.listTrimStrains(CYCLE)).toEqual({ success: true, data: [] })
  })

  it('rejects a malformed cycle id before touching the database', async () => {
    expect(await mod.listTrimStrains('nope')).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('a database error is logged and returned generic', async () => {
    const bad = createFakeDb((call) =>
      call.name === 'strains'
        ? { data: null, error: { code: '42P01', message: 'relation "strains" does not exist' } }
        : { data: [], error: null }
    )
    mockCreateServiceClient.mockResolvedValue(bad.client)
    const result = await mod.listTrimStrains(CYCLE)
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/relation/)
    expect(console.error).toHaveBeenCalledWith('[harvest-trim] listTrimStrains error:', expect.anything())
  })
})

// ─── Static guard across all four action files ───────────────────────────────

describe('static guard: every exported action in every Harvest & Trim file checks the session', () => {
  const FILES = ['hangers.ts', 'harvest-trim.ts', 'trim-staff.ts', 'trim-reports.ts']

  function exportedFunctionBodies(source: string): Array<{ name: string; body: string }> {
    const out: Array<{ name: string; body: string }> = []
    const re = /^export async function (\w+)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(source))) {
      // A top-level function ends at the first line that is exactly "}".
      const end = source.indexOf('\n}\n', m.index)
      out.push({ name: m[1], body: source.slice(m.index, end === -1 ? undefined : end + 3) })
    }
    return out
  }

  it.each(FILES)('%s', (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8')

    expect(source.split('\n')[0]).toBe("'use server'")
    // check-server-exports.mjs forbids re-exports in 'use server' files.
    expect(source).not.toMatch(/^\s*export\s+(type|interface)?\s*\{/m)
    expect(source).not.toMatch(/^\s*export\s+(const|let|var|class|default|function\b)/m)

    const fns = exportedFunctionBodies(source)
    expect(fns.length).toBeGreaterThan(0)
    for (const fn of fns) {
      expect(fn.body, `${file}: ${fn.name} must call requireRole() or requireFinance()`).toMatch(
        /requireRole\(|requireFinance\(/
      )
    }
  })

  it.each(FILES)('%s never accepts a person id from the client except trimmerId', (file) => {
    const source = readFileSync(path.join(__dirname, file), 'utf8')
    for (const banned of ['completedBy', 'checkedOutBy', 'actorId:', 'userId:']) {
      // Mentions inside comments are fine; parameters and input types are not.
      const code = source
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      if (banned === 'actorId:') {
        // the logEvent helper takes the session user as `actorId`; it is never an exported parameter
        expect(code).not.toMatch(/export async function[^{]*actorId/)
      } else {
        expect(code, `${file} mentions ${banned}`).not.toContain(banned)
      }
    }
  })
})
