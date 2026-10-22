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
  getTrimDayReport: TRIM_VIEW_ROLES,
  listTrimBatchOptions: TRIM_VIEW_ROLES,
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
    // America/Chicago day boundaries (CDT, UTC-5): Oct 1 00:00 local to Nov 1 00:00 local
    expect(ops).toContainEqual({ method: 'gte', args: ['returned_at', '2026-10-01T05:00:00.000Z'] })
    expect(ops).toContainEqual({ method: 'lt', args: ['returned_at', '2026-11-01T05:00:00.000Z'] })
    expect(ops).toContainEqual({ method: 'eq', args: ['trimmer_id', TRIMMER] })
  })

  it('draws day boundaries in America/Chicago, not UTC (winter is CST, UTC-6)', async () => {
    const { calls } = installDb()
    await mod.getTrimmerPerformance({ from: '2026-12-15', to: '2026-12-15' })
    expect(calls[0].ops).toContainEqual({ method: 'gte', args: ['returned_at', '2026-12-15T06:00:00.000Z'] })
    expect(calls[0].ops).toContainEqual({ method: 'lt', args: ['returned_at', '2026-12-16T06:00:00.000Z'] })
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


// ─── getTrimDayReport ────────────────────────────────────────────────────────

describe('getTrimDayReport', () => {
  const T_ANTONIO = 'bbbbbbbb-0000-4000-8000-000000000001'
  const T_MARIA = 'bbbbbbbb-0000-4000-8000-000000000002'
  const T_SAM = 'bbbbbbbb-0000-4000-8000-000000000003'
  const B_BB = '33333333-3333-4333-8333-3333333333b1'
  const B_VZ = '33333333-3333-4333-8333-3333333333b2'
  const input = { from: '2026-10-21', to: '2026-10-21' }

  /** A trim_checkouts row as PostgREST returns it with the day report's select. */
  function row(over: Record<string, unknown> = {}, load: Record<string, unknown> = {}) {
    return {
      id: `co-${Math.random()}`,
      seq: 1,
      load_id: `load-${Math.random()}`,
      trimmer_id: T_ANTONIO,
      trimmer_name: 'Antonio',
      checked_out_at: '2026-10-21T13:05:33.783945+00:00',
      returned_at: '2026-10-21T14:52:14.813075+00:00',
      return_kind: 'complete',
      issued_g: 595,
      flower_g: 245,
      trim_g: 99.4,
      stems_g: 245.2,
      processed_g: 595,
      returned_total_g: 589.6,
      variance_g: 5.4,
      variance_pct: 0.908,
      variance_status: 'ok',
      rate_per_lb_applied: 225,
      trim_pay_entries: { amount: 54.01 },
      hanger_loads: {
        batch_id: B_BB,
        hanger: { code: 'H1B-044' },
        batch: { name: '1001-F1-BB', strain: { name: 'Bubble Bath' } },
        ...load,
      },
      ...over,
    }
  }

  /** Antonio's 2026-10-21 (the acceptance scenario), deliberately out of order. */
  function antonioDay() {
    return [
      row({ id: 'c3', load_id: 'l3', checked_out_at: '2026-10-21T16:12:47+00:00', returned_at: '2026-10-21T18:44:23+00:00',
        issued_g: 765, flower_g: 302.7, trim_g: 163.4, stems_g: 280.7, processed_g: 765, returned_total_g: 746.8,
        variance_g: 18.2, variance_pct: 2.379, trim_pay_entries: { amount: 66.73 } }, { hanger: { code: 'H1B-070' } }),
      row({ id: 'c1', load_id: 'l1' }),
      row({ id: 'c4', load_id: 'l4', checked_out_at: '2026-10-21T18:44:42+00:00', returned_at: '2026-10-21T20:18:06+00:00',
        issued_g: 615, flower_g: 268.5, trim_g: 148.3, stems_g: 178.1, processed_g: 615, returned_total_g: 594.9,
        variance_g: 20.1, variance_pct: 3.268, trim_pay_entries: { amount: 59.19 } },
        { batch_id: B_VZ, hanger: { code: 'H1B-067' }, batch: { name: '1001-F1-VZ', strain: { name: 'VerZace' } } }),
      row({ id: 'c2', load_id: 'l2', checked_out_at: '2026-10-21T14:55:17+00:00', returned_at: '2026-10-21T16:11:47+00:00',
        issued_g: 480, flower_g: 194.2, trim_g: 95, stems_g: 179.2, processed_g: 480, returned_total_g: 468.4,
        variance_g: 11.6, variance_pct: 2.417, trim_pay_entries: { amount: 42.81 } }, { hanger: { code: 'H1B-053' } }),
    ]
  }

  const selectArg = (calls: Array<{ ops: Array<{ method: string; args: unknown[] }> }>) =>
    String(calls[0].ops.find((o) => o.method === 'select')?.args[0])

  it('reproduces the Antonio 2026-10-21 report: 4 hangers, totals, per-hanger rows in checkout order', async () => {
    installDb(() => ({ data: antonioDay(), error: null }))
    const report = (await mod.getTrimDayReport({ ...input, trimmerId: T_ANTONIO })).data!

    expect(report.totals).toMatchObject({
      episodes: 4,
      hangers: 4,
      issuedG: 2455,
      flowerG: 1010.4,
      flowerLb: 2.228, // 1010.4 / 453.59237 -> "2.23 lb" on screen
      trimG: 506.1,
      stemsG: 883.2,
      returnedTotalG: 2399.7,
      flowerSharePct: 42.11,
      flowerYieldPct: 41.16,
      varianceG: 55.3, // database sign: issued minus accounted for
      variancePct: 2.253, // 55.3 / 2455
      flaggedReturns: 0,
      payAmount: 222.74,
    })
    expect(report.episodes.map((e: { hangerCode: string }) => e.hangerCode)).toEqual(['H1B-044', 'H1B-053', 'H1B-070', 'H1B-067'])
    expect(report.episodes[0]).toEqual({
      checkoutId: 'c1',
      seq: 1,
      hangerCode: 'H1B-044',
      loadId: 'l1',
      batchId: B_BB,
      batchName: '1001-F1-BB',
      strainName: 'Bubble Bath',
      trimmerId: T_ANTONIO,
      trimmerName: 'Antonio',
      checkedOutAt: '2026-10-21T13:05:33.783945+00:00',
      returnedAt: '2026-10-21T14:52:14.813075+00:00',
      turnaroundHours: 1.78,
      issuedG: 595,
      flowerG: 245,
      trimG: 99.4,
      stemsG: 245.2,
      returnedTotalG: 589.6,
      varianceG: 5.4,
      variancePct: 0.908,
      varianceStatus: 'ok',
      returnKind: 'complete',
      ratePerLb: 225,
      payAmount: 54.01,
    })
    expect(report.episodes[3]).toMatchObject({ hangerCode: 'H1B-067', batchName: '1001-F1-VZ', strainName: 'VerZace', batchId: B_VZ })
  })

  it('scopes the query to returned episodes in the Chicago day, with one round trip', async () => {
    const { calls } = installDb()
    await mod.getTrimDayReport(input)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ kind: 'from', name: 'trim_checkouts' })
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['status', 'returned'] })
    expect(calls[0].ops).toContainEqual({ method: 'gte', args: ['returned_at', '2026-10-21T05:00:00.000Z'] })
    expect(calls[0].ops).toContainEqual({ method: 'lt', args: ['returned_at', '2026-10-22T05:00:00.000Z'] })
    // Paged, not capped: the first page asks for rows 0-999 and an exact count, in a total order.
    expect(calls[0].ops).toContainEqual({ method: 'range', args: [0, 999] })
    expect(calls[0].ops.some((o) => o.method === 'limit')).toBe(false)
    expect(calls[0].ops.filter((o) => o.method === 'order').map((o) => o.args[0])).toEqual(['returned_at', 'id'])
    expect(calls[0].ops.find((o) => o.method === 'select')?.args[1]).toEqual({ count: 'exact' })
    expect(selectArg(calls)).toContain('hanger_loads!inner(batch_id')
    expect(selectArg(calls)).not.toMatch(/(^|[,(]\s*)\*/)
  })

  it('batch filter goes through hanger_loads.batch_id and does not touch the trimmer column', async () => {
    const { calls } = installDb()
    await mod.getTrimDayReport({ ...input, batchId: B_BB })
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['hanger_loads.batch_id', B_BB] })
    expect(calls[0].ops.filter((o) => o.method === 'eq').map((o) => o.args[0])).not.toContain('trimmer_id')
  })

  it('trimmer filter narrows totals, trimmers and episodes but NOT the query: baseline and rank stay crew-wide', async () => {
    const crewRows = [
      ...antonioDay(),
      row({ id: 'm1', load_id: 'lm1', trimmer_id: T_MARIA, trimmer_name: 'Maria', flower_g: 1500, trim_g: 800, stems_g: 200, returned_total_g: 2500, issued_g: 2500, processed_g: 2500, variance_g: 0, variance_pct: 0, trim_pay_entries: { amount: 744.06 } }, { hanger: { code: 'H1B-001' } }),
      row({ id: 's1', load_id: 'ls1', trimmer_id: T_SAM, trimmer_name: 'Sam', flower_g: 2250, trim_g: 150, stems_g: 100, returned_total_g: 2500, issued_g: 2500, processed_g: 2500, variance_g: 0, variance_pct: 0, trim_pay_entries: { amount: 1116.09 } }, { hanger: { code: 'H1B-002' } }),
    ]
    const { calls } = installDb(() => ({ data: crewRows, error: null }))
    const report = (await mod.getTrimDayReport({ ...input, trimmerId: T_ANTONIO })).data!

    expect(calls[0].ops.filter((o) => o.method === 'eq').map((o) => o.args[0])).not.toContain('trimmer_id')
    expect(report.episodes).toHaveLength(4)
    expect(report.episodes.every((e: { trimmerId: string }) => e.trimmerId === T_ANTONIO)).toBe(true)
    expect(report.totals).toMatchObject({ episodes: 4, hangers: 4, flowerG: 1010.4, payAmount: 222.74 })
    expect(report.trimmers.map((t: { trimmerName: string }) => t.trimmerName)).toEqual(['Antonio'])
    // the crew is whole, ranked by flower: Sam 2250, Maria 1500, Antonio 1010.4
    expect(report.crew.map((t: { trimmerName: string; rank: number }) => [t.trimmerName, t.rank])).toEqual([['Sam', 1], ['Maria', 2], ['Antonio', 3]])
    expect(report.trimmers[0].rank).toBe(3)
    // baseline = median of the eligible (>= 2000 g returned) trimmers' shares: Antonio 42.1%, Maria 60%, Sam 90% -> 60
    expect(report.baselineFlowerSharePct).toBe(60)
    expect(report.trimmers[0]).toMatchObject({ flowerShareDeltaPts: -17.89, isFlowerShareOutlier: true })
  })

  it('without a trimmer filter, trimmers and crew are the same ranking', async () => {
    installDb(() => ({ data: antonioDay(), error: null }))
    const report = (await mod.getTrimDayReport(input)).data!
    expect(report.trimmers).toEqual(report.crew)
    expect(report.trimmers[0]).toMatchObject({ rank: 1, trimmerName: 'Antonio', episodes: 4, hangers: 4, flowerG: 1010.4, payAmount: 222.74 })
  })

  it('tied flower grams share a rank', async () => {
    installDb(() => ({
      data: [
        row({ trimmer_id: T_MARIA, trimmer_name: 'Maria', load_id: 'a' }),
        row({ trimmer_id: T_SAM, trimmer_name: 'Sam', load_id: 'b' }),
        row({ trimmer_id: T_ANTONIO, trimmer_name: 'Antonio', load_id: 'c', flower_g: 100 }),
      ],
      error: null,
    }))
    const crew = (await mod.getTrimDayReport(input)).data!.crew
    expect(crew.map((t: { rank: number }) => t.rank)).toEqual([1, 1, 3])
  })

  it('uses the same trimmer rollup and baseline as getTrimmerPerformance (one implementation)', async () => {
    const data = antonioDay()
    installDb(() => ({ data, error: null }))
    const day = (await mod.getTrimDayReport(input)).data!
    const perf = (await mod.getTrimmerPerformance(input)).data!
    expect(day.baselineFlowerSharePct).toBe(perf.baselineFlowerSharePct)
    // the day report's crew row is the performance row plus rank and the issued / yield / variance totals
    expect(day.crew[0]).toMatchObject(perf.rows[0])
    expect(day.crew[0]).toMatchObject({ rank: 1, issuedG: 2455, flowerYieldPct: 41.16, varianceG: 55.3, variancePct: 2.253 })
  })

  it('counts flagged and accepted returns, and a flagged return has no pay line', async () => {
    installDb(() => ({
      data: [
        row({ load_id: 'a', variance_status: 'flagged', trim_pay_entries: null }),
        row({ load_id: 'b', variance_status: 'accepted' }),
        row({ load_id: 'c' }),
      ],
      error: null,
    }))
    const report = (await mod.getTrimDayReport(input)).data!
    expect(report.totals.flaggedReturns).toBe(2)
    expect(report.totals.payAmount).toBe(108.02)
    expect(report.episodes.find((e: { varianceStatus: string; payAmount: number | null }) => e.varianceStatus === 'flagged')?.payAmount).toBeNull()
  })

  it('counts a hanger once however many episodes returned that day', async () => {
    installDb(() => ({
      data: [row({ load_id: 'same', seq: 1, return_kind: 'unfinished' }), row({ load_id: 'same', seq: 2 })],
      error: null,
    }))
    const { totals, episodes } = (await mod.getTrimDayReport(input)).data!
    expect(totals).toMatchObject({ episodes: 2, hangers: 1 })
    expect(episodes.map((e: { seq: number }) => e.seq)).toEqual([1, 2])
    expect(episodes[0].returnKind).toBe('unfinished')
  })

  it.each(['admin', 'management', 'trim_manager'])('%s sees rates and pay', async (role) => {
    asRole(role)
    const { calls } = installDb(() => ({ data: antonioDay(), error: null }))
    const report = (await mod.getTrimDayReport(input)).data!
    expect(selectArg(calls)).toContain('trim_pay_entries(amount)')
    expect(selectArg(calls)).toContain('rate_per_lb_applied')
    expect(report.moneyVisible).toBe(true)
    expect(report.totals.payAmount).toBe(222.74)
    expect(report.crew[0].payAmount).toBe(222.74)
    expect(report.episodes[0]).toMatchObject({ ratePerLb: 225, payAmount: 54.01 })
  })

  it('strips every dollar and rate for grow, and does not even select the money columns', async () => {
    asRole('grow')
    const { calls } = installDb(() => ({ data: antonioDay(), error: null }))
    const result = await mod.getTrimDayReport(input)
    expect(result.success).toBe(true)
    expect(selectArg(calls)).not.toContain('trim_pay_entries')
    expect(selectArg(calls)).not.toContain('rate_per_lb_applied')

    const report = result.data!
    expect(report.moneyVisible).toBe(false)
    expect(report.totals.payAmount).toBeNull()
    for (const t of [...report.trimmers, ...report.crew]) expect(t.payAmount).toBeNull()
    for (const e of report.episodes) {
      expect(e.payAmount).toBeNull()
      expect(e.ratePerLb).toBeNull()
    }
    // the fake hands back money regardless; none of it may reach the caller
    const json = JSON.stringify(report)
    for (const leaked of ['54.01', '42.81', '66.73', '59.19', '222.74', 'trim_pay_entries', 'rate_per_lb']) {
      expect(json).not.toContain(leaked)
    }
    // weights are not money
    expect(report.totals.flowerG).toBe(1010.4)
  })

  it('an empty day is an empty report, not an error', async () => {
    installDb()
    expect(await mod.getTrimDayReport(input)).toMatchObject({
      success: true,
      data: {
        truncated: false,
        baselineFlowerSharePct: null,
        trimmers: [],
        crew: [],
        episodes: [],
        totals: { episodes: 0, hangers: 0, issuedG: 0, flowerG: 0, flowerSharePct: null, flowerYieldPct: null, variancePct: null, varianceG: 0 },
      },
    })
  })

  describe('paging: a range with more than 1,000 returns is read in full', () => {
    /**
     * PostgREST as observed against the live API: honours .range() but never returns more than 1,000 rows
     * per request (no error, HTTP 200), and reports the exact count when the select asked for it.
     */
    function postgrest(all: Array<Record<string, unknown>>, maxRows = 1000) {
      return installDb((call) => {
        const range = call.ops.find((o) => o.method === 'range')
        const [from, to] = range ? (range.args as [number, number]) : [0, all.length - 1]
        const wantsCount = (call.ops.find((o) => o.method === 'select')?.args[1] as { count?: string } | undefined)?.count === 'exact'
        return {
          data: all.slice(from, Math.min(to + 1, from + maxRows)),
          error: null,
          count: wantsCount ? all.length : null,
        }
      })
    }
    /** n returns spread over a few trimmers; every row has flower 100 g, issued 500 g, pay $10.00. */
    function manyReturns(n: number) {
      return Array.from({ length: n }, (_, i) =>
        row({
          id: `c${String(i).padStart(6, '0')}`,
          load_id: `l${i}`,
          trimmer_id: `bbbbbbbb-0000-4000-8000-00000000000${i % 3}`,
          trimmer_name: ['Antonio', 'Maria', 'Sam'][i % 3],
          issued_g: 500,
          flower_g: 100,
          trim_g: 50,
          stems_g: 300,
          processed_g: 500,
          returned_total_g: 450,
          variance_g: 50,
          variance_pct: 10,
          trim_pay_entries: { amount: 10 },
        })
      )
    }

    it('2,500 returns: every one is counted, so the totals are right, and nothing is flagged truncated', async () => {
      const { calls } = postgrest(manyReturns(2500))
      const report = (await mod.getTrimDayReport({ from: '2026-09-22', to: '2026-10-21' })).data!
      expect(report.truncated).toBe(false)
      expect(report.episodes).toHaveLength(2500)
      expect(report.totals).toMatchObject({ episodes: 2500, hangers: 2500, issuedG: 1_250_000, flowerG: 250_000, varianceG: 125_000, payAmount: 25_000 })
      // 3 pages: 0-999, 1000-1999, 2000-2999; the count rides on the first only.
      expect(calls.map((c) => c.ops.find((o) => o.method === 'range')?.args)).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
      expect(calls.map((c) => c.ops.find((o) => o.method === 'select')?.args[1])).toEqual([{ count: 'exact' }, undefined, undefined])
    })

    it('the crew and per-trimmer rollups are also over all 2,500, not the first 1,000', async () => {
      postgrest(manyReturns(2500))
      const report = (await mod.getTrimDayReport({ from: '2026-09-22', to: '2026-10-21' })).data!
      const byName = Object.fromEntries(report.crew.map((t: { trimmerName: string; episodes: number }) => [t.trimmerName, t.episodes]))
      expect(byName).toEqual({ Antonio: 834, Maria: 833, Sam: 833 })
    })

    it('a trimmer filter on a big range still sums that person over the whole range', async () => {
      postgrest(manyReturns(2500))
      const report = (await mod.getTrimDayReport({ from: '2026-09-22', to: '2026-10-21', trimmerId: 'bbbbbbbb-0000-4000-8000-000000000000' })).data!
      expect(report.totals.episodes).toBe(834)
      expect(report.totals.flowerG).toBe(83_400)
    })

    it('exactly 1,000 returns is complete (the old cap treated this as truncated)', async () => {
      postgrest(manyReturns(1000))
      const report = (await mod.getTrimDayReport(input)).data!
      expect(report.truncated).toBe(false)
      expect(report.totals.episodes).toBe(1000)
    })

    it('the same totals come back whatever the per-request cap, as long as the count is honoured', async () => {
      postgrest(manyReturns(1500), 400)
      expect((await mod.getTrimDayReport(input)).data!.totals.episodes).toBe(1500)
    })

    it('over the safety ceiling: the first 10,000 are used and truncated is set', async () => {
      const { calls } = postgrest(manyReturns(10_300))
      const report = (await mod.getTrimDayReport({ from: '2026-01-01', to: '2026-10-21' })).data!
      expect(report.truncated).toBe(true)
      expect(report.totals.episodes).toBe(10_000)
      expect(calls).toHaveLength(10)
    })

    it('exactly 10,000 returns is complete, not truncated', async () => {
      postgrest(manyReturns(10_000))
      const report = (await mod.getTrimDayReport({ from: '2026-01-01', to: '2026-10-21' })).data!
      expect(report.truncated).toBe(false)
      expect(report.totals.episodes).toBe(10_000)
    })

    it('a failure on a later page fails the report; it never returns the first page as if it were everything', async () => {
      const all = manyReturns(2500)
      installDb((call) => {
        const [from, to] = call.ops.find((o) => o.method === 'range')!.args as [number, number]
        if (from > 0) return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
        return { data: all.slice(from, to + 1), error: null, count: all.length }
      })
      const res = await mod.getTrimDayReport({ from: '2026-09-22', to: '2026-10-21' })
      expect(res.success).toBe(false)
      expect(res.error).toBe('Something went wrong. Please try again.')
    })

    it('a row that shifts across a page boundary is not counted twice', async () => {
      const all = manyReturns(1200)
      installDb((call) => {
        const [from, to] = call.ops.find((o) => o.method === 'range')!.args as [number, number]
        // The page boundary slipped by one: the second page repeats the last row of the first.
        const slice = from === 0 ? all.slice(0, 1000) : all.slice(from - 1, to)
        return { data: slice, error: null, count: from === 0 ? all.length : null }
      })
      const report = (await mod.getTrimDayReport(input)).data!
      expect(report.totals.episodes).toBe(new Set(report.episodes.map((e: { checkoutId: string }) => e.checkoutId)).size)
    })
  })

  it('echoes the filters and the range', async () => {
    installDb()
    const report = (await mod.getTrimDayReport({ from: '2026-10-15', to: '2026-10-21', trimmerId: T_ANTONIO, batchId: B_BB })).data!
    expect(report).toMatchObject({ from: '2026-10-15', to: '2026-10-21', trimmerId: T_ANTONIO, batchId: B_BB })
    expect((await mod.getTrimDayReport(input)).data).toMatchObject({ trimmerId: null, batchId: null })
  })

  it.each([
    ['missing input', undefined as never],
    ['missing dates', {} as never],
    ['bad from', { from: '10/21/2026', to: '2026-10-21' }],
    ['impossible date', { from: '2026-02-30', to: '2026-03-01' }],
    ['to before from', { from: '2026-10-22', to: '2026-10-21' }],
    ['range over a year', { from: '2025-01-01', to: '2026-10-21' }],
    ['bad trimmer id', { ...{ from: '2026-10-21', to: '2026-10-21' }, trimmerId: 'x' }],
    ['bad batch id', { ...{ from: '2026-10-21', to: '2026-10-21' }, batchId: 'x' }],
  ])('rejects %s before the database', async (_label, bad) => {
    expect(await mod.getTrimDayReport(bad)).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('accepts exactly a year', async () => {
    installDb()
    expect(await mod.getTrimDayReport({ from: '2025-10-21', to: '2026-10-22' })).toMatchObject({ success: true })
  })

  it('a database error is logged and returned generic', async () => {
    installDb(() => ({ data: null, error: { code: '42P01', message: 'relation "x" does not exist' } }))
    const result = await mod.getTrimDayReport(input)
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/relation/)
    expect(console.error).toHaveBeenCalledWith('[harvest-trim] getTrimDayReport error:', expect.anything())
  })
})

// ─── listTrimBatchOptions ────────────────────────────────────────────────────

describe('listTrimBatchOptions', () => {
  it('lists batches that have loads, newest harvest first, capped, with one load id per batch', async () => {
    const { calls } = installDb(() => ({
      data: [
        { id: BATCH, name: '1001-F1-BB', harvest_date: '2026-10-01', strain: { name: 'Bubble Bath' }, hanger_loads: [{ id: 'x' }] },
        { id: BATCH2, name: '0901-F1-XX', harvest_date: null, strain: null, hanger_loads: [{ id: 'y' }] },
      ],
      error: null,
    }))
    const result = await mod.listTrimBatchOptions()
    expect(result.data).toEqual([
      { id: BATCH, name: '1001-F1-BB', strainName: 'Bubble Bath', harvestDate: '2026-10-01' },
      { id: BATCH2, name: '0901-F1-XX', strainName: null, harvestDate: null },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('batches')
    expect(String(calls[0].ops.find((o) => o.method === 'select')?.args[0])).toContain('hanger_loads!inner(id)')
    expect(calls[0].ops).toContainEqual({ method: 'order', args: ['harvest_date', { ascending: false, nullsFirst: false }] })
    expect(calls[0].ops).toContainEqual({ method: 'limit', args: [1, { referencedTable: 'hanger_loads' }] })
    expect(calls[0].ops).toContainEqual({ method: 'limit', args: [200] })
  })

  it('an empty list is a success', async () => {
    installDb()
    expect(await mod.listTrimBatchOptions()).toMatchObject({ success: true, data: [] })
  })

  it('a database error is logged and returned generic', async () => {
    installDb(() => ({ data: null, error: { code: '42P01', message: 'relation "x" does not exist' } }))
    const result = await mod.listTrimBatchOptions()
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/relation/)
  })
})
