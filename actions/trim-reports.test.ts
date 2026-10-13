// Coverage for actions/trim-reports.ts. Same hermetic style as actions/packaging.test.ts: requireRole
// and createServiceClient are mocked, and a hand-rolled chainable fake records every (table, method, args).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TRIM_VIEW_ROLES } from '@/lib/trim/roles'

const mockRequireRole = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

const mockCreateServiceClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}))

const real = await import('./trim-reports')
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
const BATCH = '33333333-3333-4333-8333-333333333333'
const BATCH2 = '33333333-3333-4333-8333-333333333334'
const CYCLE = '77777777-7777-4777-8777-777777777777'
const STRAIN = '88888888-8888-4888-8888-888888888888'
const TRIMMER = '66666666-6666-4666-8666-666666666666'

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

function reconciledLoad(batchId: string, i: number) {
  return {
    id: `${batchId}-l${i}`,
    batch_id: batchId,
    status: 'reconciled',
    plant_count: 5,
    wet_g: 1000,
    dry_g: 250,
    remaining_g: 0,
    remaining_plant_count: 0,
    trim_checkouts: [
      { status: 'returned', flower_g: 150, trim_g: 80, stems_g: 15, processed_g: 250, plants_finished: 5 },
      { status: 'released', flower_g: null, trim_g: null, stems_g: null, processed_g: null, plants_finished: null },
    ],
  }
}

function batchRow(id: string, name: string, loads: unknown[]) {
  return {
    id,
    name,
    harvest_date: '2026-10-01',
    room_cycle_id: CYCLE,
    strain: { id: STRAIN, name: 'Vz' },
    hanger_loads: loads,
  }
}

// ─── Auth gate ───────────────────────────────────────────────────────────────

const GATES: Record<string, string[]> = {
  getBatchYield: TRIM_VIEW_ROLES,
  getCycleYield: TRIM_VIEW_ROLES,
  getStrainYieldHistory: TRIM_VIEW_ROLES,
  getTrimmerPerformance: TRIM_VIEW_ROLES,
  getBatchLoads: TRIM_VIEW_ROLES,
}
const ALL_ROLES = ['admin', 'management', 'trim_manager', 'grow', 'sales', 'agent', 'vault', 'packaging', 'standard']
const exported = mod as unknown as Record<string, (...args: unknown[]) => Promise<Result>>

describe('auth gate', () => {
  it('the gate table covers exactly the module exports (no Phase 3 pay reports)', () => {
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
})

// ─── Yield ───────────────────────────────────────────────────────────────────

describe('getBatchYield', () => {
  it('computes the figures with the pure yield lib, over one query', async () => {
    const { calls } = installDb((_c, terminal) =>
      terminal === 'maybeSingle'
        ? { data: batchRow(BATCH, '1001-F1-VZ', [reconciledLoad(BATCH, 1), reconciledLoad(BATCH, 2)]), error: null }
        : { data: [], error: null }
    )
    const result = await mod.getBatchYield(BATCH)
    expect(calls).toHaveLength(1)
    expect(result.success).toBe(true)
    const report = result.data!
    expect(report).toMatchObject({ batchName: '1001-F1-VZ', strainName: 'Vz', openLoads: 0, complete: true })
    expect(report.summary.hangers).toBe(2)
    expect(report.summary.flowerG.value).toBe(300)
    expect(report.summary.dryDownPct.value).toBe(25)
    expect(report.summary.flowerPctOfProcessed.value).toBe(60)
    expect(report.summary.wetToFlowerPct.value).toBe(15)
    // the released episode is not counted
    expect(report.summary.flowerG.coverage).toEqual({ included: 2, total: 2, label: '2 of 2 hangers' })
  })

  it('reports coverage honestly for a half-trimmed batch and does not call it complete', async () => {
    const dried = { ...reconciledLoad(BATCH, 2), id: 'l2', status: 'dried', remaining_g: 250, trim_checkouts: [] }
    installDb((_c, terminal) =>
      terminal === 'maybeSingle'
        ? { data: batchRow(BATCH, 'b', [reconciledLoad(BATCH, 1), dried]), error: null }
        : { data: [], error: null }
    )
    const report = (await mod.getBatchYield(BATCH)).data!
    expect(report).toMatchObject({ openLoads: 1, complete: false })
    expect(report.summary.flowerG.coverage.label).toBe('1 of 2 hangers')
  })

  it('NOT_FOUND for an unknown batch; INVALID for a bad id without a query', async () => {
    installDb(() => ({ data: null, error: null }))
    expect(await mod.getBatchYield(BATCH)).toMatchObject({ success: false, code: 'NOT_FOUND' })
    mockCreateServiceClient.mockClear()
    expect(await mod.getBatchYield('x')).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('selects named columns (no select star) and never asks for a rate or amount', async () => {
    const { calls } = installDb((_c, terminal) => (terminal === 'maybeSingle' ? { data: null, error: null } : { data: [], error: null }))
    await mod.getBatchYield(BATCH)
    const select = String(calls[0].ops.find((o) => o.method === 'select')?.args[0])
    expect(select).not.toMatch(/(^|[,(\s])\*($|[,)\s])/)
    expect(select).not.toMatch(/rate|amount|pay/)
  })

  it('a database error is generic and logged', async () => {
    installDb(() => ({ data: null, error: { code: '42P01', message: 'relation "x" does not exist' } }))
    const result = await mod.getBatchYield(BATCH)
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/relation/)
    expect(console.error).toHaveBeenCalledWith('[harvest-trim] getBatchYield error:', expect.anything())
  })
})

describe('getCycleYield', () => {
  it('returns per-batch rows and a roll-up that equals the sum of its batches', async () => {
    const { calls } = installDb(() => ({
      data: [
        batchRow(BATCH, 'a', [reconciledLoad(BATCH, 1), reconciledLoad(BATCH, 2)]),
        batchRow(BATCH2, 'b', [reconciledLoad(BATCH2, 1)]),
        batchRow('33333333-3333-4333-8333-333333333335', 'empty', []),
      ],
      error: null,
    }))
    const result = await mod.getCycleYield(CYCLE)
    expect(calls).toHaveLength(1)
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['room_cycle_id', CYCLE] })
    const report = result.data!
    expect(report.batches.map((b: { batchName: string }) => b.batchName)).toEqual(['a', 'b', 'empty'])
    expect(report.batches[0].summary.flowerG.value).toBe(300)
    expect(report.batches[1].summary.flowerG.value).toBe(150)
    expect(report.batches[2]).toMatchObject({ complete: false, openLoads: 0 })
    expect(report.total.hangers).toBe(3)
    expect(report.total.flowerG.value).toBe(450)
  })
})

describe('getStrainYieldHistory', () => {
  it('asks for the newest batches that have loads, capped by the limit', async () => {
    const { calls } = installDb(() => ({ data: [batchRow(BATCH, 'a', [reconciledLoad(BATCH, 1)])], error: null }))
    const result = await mod.getStrainYieldHistory(STRAIN, 5)
    const select = String(calls[0].ops.find((o) => o.method === 'select')?.args[0])
    expect(select).toContain('hanger_loads!inner(')
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['strain_id', STRAIN] })
    expect(calls[0].ops).toContainEqual({ method: 'limit', args: [5] })
    expect(calls[0].ops).toContainEqual({ method: 'order', args: ['harvest_date', { ascending: false, nullsFirst: false }] })
    expect(result.data).toMatchObject({ strainId: STRAIN, strainName: 'Vz' })
    expect(result.data?.batches).toHaveLength(1)
  })

  it('defaults the limit to 10, and rejects 0, 51 and fractions before the database', async () => {
    const { calls } = installDb()
    await mod.getStrainYieldHistory(STRAIN)
    expect(calls[0].ops).toContainEqual({ method: 'limit', args: [10] })
    mockCreateServiceClient.mockClear()
    for (const limit of [0, 51, 2.5, -1]) {
      expect(await mod.getStrainYieldHistory(STRAIN, limit)).toMatchObject({ success: false, code: 'INVALID' })
    }
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('an unknown strain with no batches is NOT_FOUND; a known one is an empty list', async () => {
    installDb((call, terminal) => (call.name === 'strains' && terminal === 'maybeSingle' ? { data: null, error: null } : { data: [], error: null }))
    expect(await mod.getStrainYieldHistory(STRAIN)).toMatchObject({ success: false, code: 'NOT_FOUND' })
    installDb((call, terminal) =>
      call.name === 'strains' && terminal === 'maybeSingle' ? { data: { id: STRAIN, name: 'Vz' }, error: null } : { data: [], error: null }
    )
    expect(await mod.getStrainYieldHistory(STRAIN)).toMatchObject({ success: true, data: { strainName: 'Vz', batches: [] } })
  })
})

// ─── Trimmer performance ─────────────────────────────────────────────────────

describe('getTrimmerPerformance', () => {
  const ep = (trimmer: string, name: string, over: Record<string, unknown> = {}) => ({
    trimmer_id: trimmer,
    trimmer_name: name,
    load_id: `${trimmer}-${Math.random()}`,
    checked_out_at: '2026-10-20T08:00:00Z',
    returned_at: '2026-10-20T10:00:00Z',
    flower_g: 600,
    trim_g: 300,
    stems_g: 95,
    processed_g: 1000,
    returned_total_g: 995,
    variance_pct: 0.5,
    variance_status: 'ok',
    trim_pay_entries: { amount: 297.5 },
    ...over,
  })
  const input = { from: '2026-10-01', to: '2026-10-31' }

  it('aggregates per trimmer: turnaround, variance, flagged / accepted, flower share', async () => {
    installDb(() => ({
      data: [
        ep(TRIMMER, 'Maria'),
        ep(TRIMMER, 'Maria', { variance_pct: -1.5, variance_status: 'accepted', returned_at: '2026-10-20T12:00:00Z' }),
        ep('t2', 'Sam', { flower_g: 400, trim_g: 500, returned_total_g: 995 }),
      ],
      error: null,
    }))
    const result = await mod.getTrimmerPerformance(input)
    const maria = result.data?.rows.find((r: { trimmerId: string }) => r.trimmerId === TRIMMER)
    expect(maria).toMatchObject({
      episodes: 2,
      hangers: 2,
      flowerG: 1200,
      avgTurnaroundHours: 3,
      avgVariancePct: -0.5,
      avgAbsVariancePct: 1,
      flaggedReturns: 1,
      acceptedReturns: 1,
      payAmount: 595,
    })
    expect(result.data?.truncated).toBe(false)
    expect(result.data?.cohortFlowerSharePct).toBeCloseTo((1200 + 400) / (995 * 3) * 100, 1)
  })

  it('flags a flower-share outlier (bucket shifting) only with enough material', async () => {
    installDb(() => ({
      data: [
        ep('t1', 'Normal', { flower_g: 1500, returned_total_g: 2500 }),
        ep('t2', 'Normal2', { flower_g: 1500, returned_total_g: 2500 }),
        ep('t3', 'Shifter', { flower_g: 2250, returned_total_g: 2500 }),
        ep('t4', 'Tiny', { flower_g: 90, returned_total_g: 100 }),
      ],
      error: null,
    }))
    const rows = (await mod.getTrimmerPerformance(input)).data!.rows as Array<{ trimmerName: string; isFlowerShareOutlier: boolean }>
    const flagged = Object.fromEntries(rows.map((r) => [r.trimmerName, r.isFlowerShareOutlier]))
    expect(flagged).toEqual({ Normal: false, Normal2: false, Shifter: true, Tiny: false })
  })

  it('shows dollars to the trim manager but never to grow, and does not even select them for grow', async () => {
    asRole('trim_manager')
    const withMoney = installDb(() => ({ data: [ep(TRIMMER, 'Maria')], error: null }))
    const manager = await mod.getTrimmerPerformance(input)
    expect(String(withMoney.calls[0].ops.find((o) => o.method === 'select')?.args[0])).toContain('trim_pay_entries')
    expect(manager.data?.rows[0].payAmount).toBe(297.5)

    asRole('grow')
    const noMoney = installDb(() => ({ data: [ep(TRIMMER, 'Maria')], error: null }))
    const grow = await mod.getTrimmerPerformance(input)
    expect(String(noMoney.calls[0].ops.find((o) => o.method === 'select')?.args[0])).not.toContain('trim_pay_entries')
    expect(grow.data?.rows[0].payAmount).toBeNull()
  })

  it('scopes the query to returned episodes in the inclusive date range and one trimmer', async () => {
    const { calls } = installDb()
    await mod.getTrimmerPerformance({ ...input, trimmerId: TRIMMER })
    const ops = calls[0].ops
    expect(ops).toContainEqual({ method: 'eq', args: ['status', 'returned'] })
    expect(ops).toContainEqual({ method: 'gte', args: ['returned_at', '2026-10-01T00:00:00.000Z'] })
    expect(ops).toContainEqual({ method: 'lt', args: ['returned_at', '2026-11-01T00:00:00.000Z'] })
    expect(ops).toContainEqual({ method: 'eq', args: ['trimmer_id', TRIMMER] })
  })

  it('says so when the row cap is hit', async () => {
    installDb(() => ({ data: Array.from({ length: 1000 }, () => ep(TRIMMER, 'Maria')), error: null }))
    expect((await mod.getTrimmerPerformance(input)).data?.truncated).toBe(true)
  })

  it('an empty range is an empty report, not an error', async () => {
    installDb()
    expect(await mod.getTrimmerPerformance(input)).toMatchObject({
      success: true,
      data: { rows: [], cohortFlowerSharePct: null, baselineFlowerSharePct: null, truncated: false },
    })
  })

  it.each([
    ['missing dates', {} as never],
    ['bad from', { from: '10/01/2026', to: '2026-10-31' }],
    ['impossible date', { from: '2026-02-30', to: '2026-03-31' }],
    ['to before from', { from: '2026-10-31', to: '2026-10-01' }],
    ['range over a year', { from: '2025-01-01', to: '2026-10-31' }],
    ['bad trimmer id', { from: '2026-10-01', to: '2026-10-31', trimmerId: 'x' }],
  ])('rejects %s before the database', async (_label, bad) => {
    expect(await mod.getTrimmerPerformance(bad)).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })
})

// ─── getBatchLoads ───────────────────────────────────────────────────────────

describe('getBatchLoads', () => {
  const T_MARIA = 'aaaaaaaa-0000-4000-8000-000000000001'
  const T_SAM = 'aaaaaaaa-0000-4000-8000-000000000002'
  const T_SHIFTER = 'aaaaaaaa-0000-4000-8000-000000000003'
  const T_NEWBIE = 'aaaaaaaa-0000-4000-8000-000000000004'

  function ep(id: string, seq: number, trimmerId: string, name: string, over: Record<string, unknown> = {}) {
    return {
      id,
      seq,
      trimmer_id: trimmerId,
      trimmer_name: name,
      status: 'returned',
      return_kind: 'complete',
      issued_g: 3000,
      checked_out_at: '2026-10-20T08:00:00Z',
      returned_at: '2026-10-20T11:00:00Z',
      variance_g: 0,
      variance_pct: 0,
      variance_status: 'ok',
      ...over,
    }
  }

  function load(id: string, code: string, status: string, episodes: unknown[], over: Record<string, unknown> = {}) {
    return {
      id,
      status,
      plant_count: 5,
      wet_g: 1000,
      dry_g: 250,
      remaining_g: 0,
      remaining_plant_count: 0,
      hanger: { code },
      trim_checkouts: episodes,
      ...over,
    }
  }

  // Maria: 2 episodes on 2 hangers at two different rates; Sam: 1 episode (+ a released one that must not count);
  // Shifter: moves material into flower; Newbie: one flagged episode (no pay line yet). One void load.
  // Deliberately shuffled so the sort is exercised.
  const BATCH_DATA = {
    id: BATCH,
    name: '1029-F5-VZ',
    hanger_loads: [
      load('l10', 'H1-010', 'reconciled', [
        ep('e5', 1, T_SAM, 'Sam', { flower_g: 1500, trim_g: 700, stems_g: 300, rate_per_lb_applied: '225.00', trim_pay_entries: { amount: '744.06' } }),
      ]),
      load('l2', 'H1-002', 'reconciled', [
        ep('e2r', 1, T_SAM, 'Sam', { status: 'released', return_kind: null, flower_g: null, trim_g: null, stems_g: null, rate_per_lb_applied: 225, trim_pay_entries: null }),
        ep('e2', 2, T_MARIA, 'Maria', { flower_g: 1000, trim_g: 700, stems_g: 100, rate_per_lb_applied: 250, trim_pay_entries: { amount: 551.16 } }),
      ]),
      load('l5', 'H1-005', 'void', []),
      load('l1', 'H1-001', 'reconciled', [
        ep('e1', 1, T_MARIA, 'Maria', { flower_g: 1500, trim_g: 800, stems_g: 200, rate_per_lb_applied: 225, trim_pay_entries: { amount: 744.06 } }),
      ]),
      load('l4', 'H1-004', 'returned', [
        ep('e4', 1, T_NEWBIE, 'Newbie', { flower_g: 100, trim_g: 50, stems_g: 10, variance_status: 'flagged', variance_g: 90, variance_pct: 3, rate_per_lb_applied: 225, trim_pay_entries: null }),
      ]),
      load('l3', 'H1-003', 'reconciled', [
        ep('e3', 1, T_SHIFTER, 'Shifter', { flower_g: 2250, trim_g: 150, stems_g: 100, rate_per_lb_applied: 225, trim_pay_entries: { amount: 1116.09 } }),
      ]),
    ],
  }

  const selectArg = (calls: Array<{ ops: Array<{ method: string; args: unknown[] }> }>) =>
    String(calls[0].ops.find((o) => o.method === 'select')?.args[0])

  it('is ONE round trip: a nested embed, scoped to the batch, with no per-load queries', async () => {
    const { calls } = installDb(() => ({ data: BATCH_DATA, error: null }))
    const result = await mod.getBatchLoads(BATCH)
    expect(result.success).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'from', name: 'batches' })
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['id', BATCH] })
    expect(selectArg(calls)).toMatch(/hanger_loads\(.*hanger:hangers\(code\), trim_checkouts\(/)
  })

  it('selects named columns only: no select star anywhere in the embed', async () => {
    const { calls } = installDb(() => ({ data: BATCH_DATA, error: null }))
    await mod.getBatchLoads(BATCH)
    expect(selectArg(calls)).not.toMatch(/(^|[,(]\s*)\*/)
  })

  it('returns loads ordered by hanger code with episodes ordered by seq, void loads included', async () => {
    installDb(() => ({ data: BATCH_DATA, error: null }))
    const { loads } = (await mod.getBatchLoads(BATCH)).data!
    expect(loads.map((l: { hangerCode: string }) => l.hangerCode)).toEqual([
      'H1-001', 'H1-002', 'H1-003', 'H1-004', 'H1-005', 'H1-010',
    ])
    const l2 = loads.find((l: { loadId: string }) => l.loadId === 'l2')
    expect(l2.episodes.map((e: { seq: number }) => e.seq)).toEqual([1, 2])
    expect(loads.find((l: { loadId: string }) => l.loadId === 'l5').status).toBe('void')
    expect(l2).toMatchObject({
      status: 'reconciled', plantCount: 5, wetG: 1000, dryG: 250, remainingG: 0, remainingPlantCount: 0,
    })
  })

  it('maps every requested episode field, including the released one', async () => {
    installDb(() => ({ data: BATCH_DATA, error: null }))
    const l1 = (await mod.getBatchLoads(BATCH)).data!.loads[0]
    expect(l1.episodes[0]).toEqual({
      id: 'e1',
      seq: 1,
      trimmerId: T_MARIA,
      trimmerName: 'Maria',
      status: 'returned',
      returnKind: 'complete',
      issuedG: 3000,
      flowerG: 1500,
      trimG: 800,
      stemsG: 200,
      varianceG: 0,
      variancePct: 0,
      varianceStatus: 'ok',
      checkedOutAt: '2026-10-20T08:00:00Z',
      returnedAt: '2026-10-20T11:00:00Z',
    })
    const released = (await mod.getBatchLoads(BATCH)).data!.loads[1].episodes[0]
    expect(released).toMatchObject({ status: 'released', returnKind: null, flowerG: null })
  })

  it('rolls up per trimmer: episodes, hangers, grams, lbs, rates, amount owed (returned episodes only)', async () => {
    asRole('trim_manager')
    installDb(() => ({ data: BATCH_DATA, error: null }))
    const { trimmers } = (await mod.getBatchLoads(BATCH)).data!
    const by = Object.fromEntries(trimmers.map((t: { trimmerName: string }) => [t.trimmerName, t]))

    expect(by.Maria).toMatchObject({
      trimmerId: T_MARIA,
      episodes: 2,
      hangers: 2,
      flowerG: 2500,
      flowerLb: 5.512, // 2500 / 453.59237
      returnedTotalG: 4300,
      ratesPerLb: [225, 250],
      amountOwed: 1295.22, // 744.06 + 551.16, the sum of the lines, not a re-rounding
      pendingFlaggedEpisodes: 0,
    })
    // the released episode on l2 belongs to Sam but is not a returned episode
    expect(by.Sam).toMatchObject({ episodes: 1, hangers: 1, flowerG: 1500, flowerLb: 3.307, ratesPerLb: [225], amountOwed: 744.06 })
    expect(by.Shifter).toMatchObject({ flowerG: 2250, amountOwed: 1116.09 })
    expect(by.Newbie).toMatchObject({ episodes: 1, flowerG: 100, pendingFlaggedEpisodes: 1, amountOwed: 0 })
    expect(trimmers.map((t: { trimmerName: string }) => t.trimmerName)).toEqual(['Maria', 'Shifter', 'Sam', 'Newbie']) // flower grams, descending
  })

  it('measures flower share against the batch MEDIAN and flags only the outlier with enough material', async () => {
    installDb(() => ({ data: BATCH_DATA, error: null }))
    const report = (await mod.getBatchLoads(BATCH)).data!
    // eligible (>= 2000 g returned): Maria 2500/4300 = 58.14, Sam 1500/2500 = 60, Shifter 2250/2500 = 90 -> median 60
    expect(report.baselineFlowerSharePct).toBe(60)
    const by = Object.fromEntries(report.trimmers.map((t: { trimmerName: string }) => [t.trimmerName, t]))
    expect(by.Maria).toMatchObject({ flowerSharePct: 58.14, flowerShareDeltaPts: -1.86, isFlowerShareOutlier: false })
    expect(by.Sam).toMatchObject({ flowerSharePct: 60, flowerShareDeltaPts: 0, isFlowerShareOutlier: false })
    expect(by.Shifter).toMatchObject({ flowerSharePct: 90, flowerShareDeltaPts: 30, isFlowerShareOutlier: true })
    // 62.5% is 2.5 points off, and it has 160 g so it is not eligible anyway
    expect(by.Newbie).toMatchObject({ flowerSharePct: 62.5, isFlowerShareOutlier: false })
  })

  it('uses the same baseline definition as getTrimmerPerformance (one implementation)', async () => {
    // same three eligible trimmers expressed as performance episodes
    const perfEp = (id: string, name: string, flower: number, total: number) => ({
      trimmer_id: id, trimmer_name: name, load_id: `${id}-l`, checked_out_at: '2026-10-20T08:00:00Z',
      returned_at: '2026-10-20T10:00:00Z', flower_g: flower, trim_g: total - flower, stems_g: 0, processed_g: total,
      returned_total_g: total, variance_pct: 0, variance_status: 'ok', trim_pay_entries: { amount: 1 },
    })
    installDb(() => ({
      data: [perfEp('m', 'Maria', 2500, 4300), perfEp('s', 'Sam', 1500, 2500), perfEp('x', 'Shifter', 2250, 2500)],
      error: null,
    }))
    const perf = (await mod.getTrimmerPerformance({ from: '2026-10-01', to: '2026-10-31' })).data!
    installDb(() => ({ data: BATCH_DATA, error: null }))
    const batch = (await mod.getBatchLoads(BATCH)).data!
    expect(batch.baselineFlowerSharePct).toBe(perf.baselineFlowerSharePct)
    const shifterPerf = perf.rows.find((r: { trimmerName: string }) => r.trimmerName === 'Shifter')
    const shifterBatch = batch.trimmers.find((t: { trimmerName: string }) => t.trimmerName === 'Shifter')
    expect(shifterBatch.isFlowerShareOutlier).toBe(shifterPerf.isFlowerShareOutlier)
    expect(shifterBatch.flowerShareDeltaPts).toBe(shifterPerf.flowerShareDeltaPts)
  })

  it('reports batch totals over non-void loads and returned episodes only', async () => {
    asRole('trim_manager')
    installDb(() => ({ data: BATCH_DATA, error: null }))
    const { totals } = (await mod.getBatchLoads(BATCH)).data!
    expect(totals).toEqual({
      loads: 5,
      voidLoads: 1,
      openLoads: 1, // l4 is 'returned' (flagged), the rest are reconciled
      plants: 25,
      wetG: 5000,
      dryG: 1250,
      remainingG: 0,
      episodes: 5,
      flowerG: 6350,
      flowerLb: 13.999, // 6350 / 453.59237
      trimG: 2400,
      stemsG: 710,
      returnedTotalG: 9460,
      flowerSharePct: 67.12, // 6350 / 9460
      amountOwed: 3155.37, // 744.06 + 551.16 + 744.06 + 1116.09
    })
  })

  it.each(['admin', 'management', 'trim_manager'])('%s sees rates and amounts owed', async (role) => {
    asRole(role)
    const { calls } = installDb(() => ({ data: BATCH_DATA, error: null }))
    const result = await mod.getBatchLoads(BATCH)
    expect(selectArg(calls)).toContain('trim_pay_entries(amount)')
    expect(selectArg(calls)).toContain('rate_per_lb_applied')
    expect(result.data).toMatchObject({ moneyVisible: true })
    expect(result.data?.trimmers[0].amountOwed).toEqual(expect.any(Number))
    expect(result.data?.trimmers[0].ratesPerLb).toEqual(expect.any(Array))
  })

  it('strips every dollar and rate for grow, and does not even select the money columns', async () => {
    asRole('grow')
    const { calls } = installDb(() => ({ data: BATCH_DATA, error: null }))
    const result = await mod.getBatchLoads(BATCH)
    expect(result.success).toBe(true)

    expect(selectArg(calls)).not.toContain('trim_pay_entries')
    expect(selectArg(calls)).not.toContain('rate_per_lb_applied')

    const report = result.data!
    expect(report.moneyVisible).toBe(false)
    expect(report.totals.amountOwed).toBeNull()
    for (const t of report.trimmers) {
      expect(t.amountOwed).toBeNull()
      expect(t.ratesPerLb).toBeNull()
    }
    // even if the database handed back money (the fake above does), none of it reaches the caller
    const json = JSON.stringify(report)
    for (const leaked of ['744.06', '551.16', '1116.09', '3155.37', '1295.22', '"rate_per_lb_applied"', 'trim_pay_entries']) {
      expect(json).not.toContain(leaked)
    }
    // weights and flower share are not money and stay
    expect(report.trimmers.find((t: { trimmerName: string }) => t.trimmerName === 'Maria')).toMatchObject({
      flowerG: 2500, flowerSharePct: 58.14,
    })
  })

  it('an empty batch is an empty report, not an error', async () => {
    installDb(() => ({ data: { id: BATCH, name: 'b', hanger_loads: [] }, error: null }))
    const result = await mod.getBatchLoads(BATCH)
    expect(result).toMatchObject({
      success: true,
      data: {
        loads: [],
        trimmers: [],
        baselineFlowerSharePct: null,
        totals: { loads: 0, episodes: 0, flowerG: 0, flowerSharePct: null },
      },
    })
  })

  it('an unknown batch is NOT_FOUND', async () => {
    installDb(() => ({ data: null, error: null }))
    expect(await mod.getBatchLoads(BATCH)).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('rejects a malformed id before touching the database', async () => {
    expect(await mod.getBatchLoads('nope')).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('a database error is logged and returned generic', async () => {
    installDb(() => ({ data: null, error: { code: '42P01', message: 'relation "x" does not exist' } }))
    const result = await mod.getBatchLoads(BATCH)
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/relation/)
    expect(console.error).toHaveBeenCalledWith('[harvest-trim] getBatchLoads error:', expect.anything())
  })
})
