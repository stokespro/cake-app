// Coverage for actions/hangers.ts. Same hermetic style as actions/packaging.test.ts: requireRole and
// createServiceClient are mocked, and a hand-rolled chainable fake records every (table, method, args)
// and every .rpc(name, params).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TRIM_OPS_ROLES, TRIM_VIEW_ROLES } from '@/lib/trim/roles'

const mockRequireRole = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

const mockCreateServiceClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}))

const real = await import('./hangers')
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
const HANGER = '22222222-2222-4222-8222-222222222222'

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

const batchEmbed = {
  id: 'b1',
  name: '1001-F1-VZ',
  harvest_date: '2026-10-01',
  strain: { id: 's1', name: 'Vz' },
  cycle: { id: 'c1', cycle_number: 1, status: 'active', current_stage: 'dry', room: { room_name: 'F1', room_number: 1 } },
}

function episode(over: Record<string, unknown> = {}) {
  return {
    id: 'co1',
    seq: 1,
    trimmer_id: 't1',
    trimmer_name: 'Maria',
    status: 'out',
    issued_g: '1000.00',
    issued_plant_count: 5,
    checked_out_at: '2026-10-20T10:00:00Z',
    ...over,
  }
}

function load(status: string, over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    status,
    source: 'harvest',
    plant_count: 5,
    wet_g: 4000,
    dry_g: 1000,
    remaining_g: 1000,
    remaining_plant_count: 5,
    created_at: '2026-10-19T10:00:00Z',
    updated_at: '2026-10-19T10:00:00Z',
    batch: batchEmbed,
    trim_checkouts: [],
    ...over,
  }
}

function hangerRow(status = 'active', loads: unknown[] = []) {
  return { id: HANGER, code: 'H1B-042', label_seq: 42, status, notes: null, hanger_loads: loads }
}

const scanResponder = (row: unknown): Responder => (_call, terminal) =>
  terminal === 'maybeSingle' ? { data: row, error: null } : { data: [], error: null }

// ─── Auth gate ───────────────────────────────────────────────────────────────

const GATES: Record<string, string[]> = {
  resolveScan: TRIM_VIEW_ROLES,
  lookupHanger: TRIM_VIEW_ROLES,
  listHangers: TRIM_VIEW_ROLES,
  createHangers: TRIM_OPS_ROLES,
  importHangers: TRIM_OPS_ROLES,
  setHangerStatus: TRIM_OPS_ROLES,
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
})

// ─── resolveScan: the hot path ───────────────────────────────────────────────

describe('resolveScan', () => {
  it('answers a scan in ONE round trip, with the load, batch and episodes embedded', async () => {
    const { calls } = installDb(scanResponder(hangerRow('active', [load('checked_out', { trim_checkouts: [episode()] })])))
    const result = await mod.resolveScan('H1B-042', 'wedge')

    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('hangers')
    const select = String(calls[0].ops.find((o) => o.method === 'select')?.args[0])
    expect(select).toContain('hanger_loads(')
    expect(select).toContain('trim_checkouts(')
    expect(select).toContain('strains(')
    expect(select).toContain('grow_rooms(')
    expect(select).not.toMatch(/(^|[,(\s])\*($|[,)\s])/)
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['code', 'H1B-042'] })
    // only the newest load is fetched
    expect(calls[0].ops).toContainEqual({
      method: 'order',
      args: ['created_at', { ascending: false, referencedTable: 'hanger_loads' }],
    })
    expect(calls[0].ops).toContainEqual({ method: 'limit', args: [1, { referencedTable: 'hanger_loads' }] })

    expect(result).toMatchObject({
      success: true,
      data: {
        hanger: { code: 'H1B-042', status: 'active' },
        nextStep: 'checkin',
        canStartLoad: false,
        openLoad: { id: 'l1', status: 'checked_out', plantCount: 5 },
        lastClosedLoad: null,
        checkout: { trimmerName: 'Maria', issuedG: 1000 },
        batch: { name: '1001-F1-VZ', strainName: 'Vz', roomName: 'F1', cycleNumber: 1 },
      },
    })
  })

  it('never exposes a rate or dollar field', async () => {
    installDb(scanResponder(hangerRow('active', [load('checked_out', { trim_checkouts: [episode({ rate_per_lb_applied: 225 })] })])))
    const result = await mod.resolveScan('H1B-042', 'wedge')
    expect(JSON.stringify(result)).not.toMatch(/rate|pay|amount|225/i)
  })

  it.each([
    ['hung', 'record_dry', false],
    ['dried', 'checkout', false],
    ['checked_out', 'checkin', false],
    ['partial', 'reissue', false],
    ['returned', 'resolve_variance', false],
    ['reconciled', 'closed_out', true],
    ['void', 'closed_out', true],
  ])('a %s load routes to %s (canStartLoad %s)', async (status, nextStep, canStart) => {
    installDb(scanResponder(hangerRow('active', [load(status)])))
    const result = await mod.resolveScan('H1B-042', 'wedge')
    expect(result.data).toMatchObject({ nextStep, canStartLoad: canStart })
    expect(Boolean(result.data?.openLoad)).toBe(!canStart)
    expect(Boolean(result.data?.lastClosedLoad)).toBe(canStart)
  })

  it('a never-used hanger is new_load; a retired one is inactive but still returns its history', async () => {
    installDb(scanResponder(hangerRow('active', [])))
    expect((await mod.resolveScan('H1B-042', 'wedge')).data).toMatchObject({ nextStep: 'new_load', canStartLoad: true })

    installDb(scanResponder(hangerRow('retired', [load('reconciled')])))
    const retired = await mod.resolveScan('H1B-042', 'wedge')
    expect(retired.data).toMatchObject({ nextStep: 'inactive', canStartLoad: false, lastClosedLoad: { id: 'l1' } })
  })

  it('wedge and camera reads are strict; typed entry is lenient', async () => {
    for (const source of ['wedge', 'camera'] as const) {
      const strict = await mod.resolveScan('h1b-42', source)
      expect(strict).toMatchObject({ success: false, code: 'INVALID' })
    }
    expect(mockCreateServiceClient).not.toHaveBeenCalled()

    const { calls } = installDb(scanResponder(hangerRow()))
    for (const typed of ['42', 'h1b42', ' H1B-42 ', 'h1b-042']) {
      const ok = await mod.resolveScan(typed, 'typed')
      expect(ok.success, typed).toBe(true)
    }
    expect(calls.every((c) => c.ops.some((o) => o.method === 'eq' && o.args[1] === 'H1B-042'))).toBe(true)
  })

  it('rejects a Metrc package tag, junk, a non-string and an unknown source without a database call', async () => {
    const tag = '1A4FF0100000022000001234'
    expect(await mod.resolveScan(tag, 'wedge')).toMatchObject({ success: false, code: 'INVALID' })
    expect(await mod.resolveScan(tag, 'typed')).toMatchObject({ success: false, code: 'INVALID' })
    expect(await mod.resolveScan('hello', 'typed')).toMatchObject({ success: false, code: 'INVALID' })
    expect(await mod.resolveScan(42 as never, 'typed')).toMatchObject({ success: false, code: 'INVALID' })
    expect(await mod.resolveScan('H1B-042', 'telepathy' as never)).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('an unregistered code is NOT_FOUND', async () => {
    installDb(scanResponder(null))
    expect(await mod.resolveScan('H1B-999', 'wedge')).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('a database error becomes a generic failure and is logged', async () => {
    installDb(() => ({ data: null, error: { code: '42703', message: 'column nope does not exist' } }))
    const result = await mod.resolveScan('H1B-042', 'wedge')
    expect(result.success).toBe(false)
    expect(result.error).not.toMatch(/column/)
    expect(console.error).toHaveBeenCalledWith('[harvest-trim] resolveScan error:', expect.anything())
  })
})

describe('lookupHanger (R2.9b)', () => {
  const events = [
    { id: 2, occurred_at: 't2', actor_user_id: ACTOR, event_type: 'checked_in', load_id: 'l1', checkout_id: 'co1', batch_id: 'b1', payload: { flower_g: 600, pay_amount: 61.2, rate_per_lb_applied: 225 }, actor: { name: 'Joey' } },
  ]

  it('returns every load, newest first, with episodes and the audit trail', async () => {
    const older = load('reconciled', { id: 'l0', created_at: '2026-09-01T00:00:00Z', trim_checkouts: [episode({ id: 'old', seq: 1 })] })
    const open = load('dried', { id: 'l1' })
    installDb(scanResponder({ ...hangerRow('active', [older, open]), trim_events: events }))
    const result = await mod.lookupHanger('42')
    expect(result.data?.loads.map((l: { id: string }) => l.id)).toEqual(['l1', 'l0'])
    expect(result.data).toMatchObject({ openLoadId: 'l1', nextStep: 'checkout', canStartLoad: false })
    expect(result.data?.events[0]).toMatchObject({ actorName: 'Joey', eventType: 'checked_in' })
  })

  it('works for a hanger that was never used', async () => {
    installDb(scanResponder({ ...hangerRow('active', []), trim_events: [] }))
    expect((await mod.lookupHanger('H1B-042')).data).toMatchObject({ loads: [], events: [], nextStep: 'new_load' })
  })

  it('strips money from the audit trail for grow, keeps it for the trim manager', async () => {
    asRole('grow')
    installDb(scanResponder({ ...hangerRow(), trim_events: events }))
    expect((await mod.lookupHanger('42')).data?.events[0].payload).toEqual({ flower_g: 600 })

    asRole('trim_manager')
    installDb(scanResponder({ ...hangerRow(), trim_events: events }))
    expect((await mod.lookupHanger('42')).data?.events[0].payload).toMatchObject({ pay_amount: 61.2 })
  })

  it('is one query', async () => {
    const { calls } = installDb(scanResponder({ ...hangerRow(), trim_events: [] }))
    await mod.lookupHanger('42')
    expect(calls).toHaveLength(1)
  })
})

// ─── listHangers ─────────────────────────────────────────────────────────────

describe('listHangers', () => {
  it('returns each hanger with its newest load in one query', async () => {
    const { calls } = installDb(() => ({
      data: [
        { id: 'a', code: 'H1B-001', label_seq: 1, status: 'active', notes: null, hanger_loads: [{ id: 'l', status: 'dried', batch_id: 'b', created_at: 't', batch: { name: '1001-F1-VZ' } }] },
        { id: 'b', code: 'H1B-002', label_seq: 2, status: 'lost', notes: null, hanger_loads: [] },
      ],
      error: null,
    }))
    const result = await mod.listHangers({ status: 'active', search: ' h1b-0;drop ' })
    expect(calls).toHaveLength(1)
    expect(calls[0].ops).toContainEqual({ method: 'eq', args: ['status', 'active'] })
    expect(calls[0].ops).toContainEqual({ method: 'ilike', args: ['code', '%H1B-0DROP%'] })
    expect(result.data).toEqual([
      expect.objectContaining({ code: 'H1B-001', hasOpenLoad: true, latestLoad: expect.objectContaining({ batchName: '1001-F1-VZ' }) }),
      expect.objectContaining({ code: 'H1B-002', hasOpenLoad: false, latestLoad: null }),
    ])
  })

  it('rejects an unknown status filter', async () => {
    expect(await mod.listHangers({ status: 'weird' as never })).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })
})

// ─── createHangers ───────────────────────────────────────────────────────────

describe('createHangers', () => {
  const responder = (top: number | null): Responder => (call) => {
    if (call.kind === 'rpc') return { data: { inserted: 3, skipped: 0, codes: ['H1B-301', 'H1B-302', 'H1B-303'] }, error: null }
    return { data: top === null ? [] : [{ label_seq: top }], error: null }
  }

  it('continues after the highest registered number, with the session user as actor', async () => {
    const { calls } = installDb(responder(300))
    const result = await mod.createHangers(3)
    const rpc = calls.find((c) => c.kind === 'rpc')!
    expect(rpc).toMatchObject({
      name: 'fn_create_hangers',
      params: { p_prefix: 'H1B-', p_start: 301, p_count: 3, p_digits: 3, p_actor: ACTOR },
    })
    expect(result).toEqual({
      success: true,
      data: { start: 301, inserted: 3, skipped: 0, codes: ['H1B-301', 'H1B-302', 'H1B-303'] },
    })
  })

  it('starts at 1 for an empty registry', async () => {
    const { calls } = installDb(responder(null))
    await mod.createHangers(3)
    expect(calls.find((c) => c.kind === 'rpc')?.params?.p_start).toBe(1)
  })

  it.each([0, -1, 1.5, 1000, Number.NaN, '5' as never])('rejects a count of %s before the database', async (count) => {
    expect(await mod.createHangers(count)).toMatchObject({ success: false, code: 'INVALID' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('refuses to run past H1B-999 instead of letting lpad truncate', async () => {
    const { calls } = installDb(responder(990))
    expect(await mod.createHangers(20)).toMatchObject({ success: false, code: 'INVALID' })
    expect(calls.some((c) => c.kind === 'rpc')).toBe(false)
  })

  it('maps a TRIM_E error and treats an empty RPC result as a failure', async () => {
    installDb((call) =>
      call.kind === 'rpc'
        ? { data: null, error: { code: 'P0001', message: 'TRIM_E_INVALID: digits must be between 3 and 6' } }
        : { data: [], error: null }
    )
    expect(await mod.createHangers(3)).toEqual({ success: false, error: 'digits must be between 3 and 6', code: 'INVALID' })

    installDb((call) => (call.kind === 'rpc' ? { data: null, error: null } : { data: [], error: null }))
    expect((await mod.createHangers(3)).success).toBe(false)
  })
})

// ─── importHangers (R2.13) ───────────────────────────────────────────────────

describe('importHangers', () => {
  const existing = (rows: Array<{ code: string; label_seq: number }>, written?: Array<{ code: string }>): Responder =>
    (call) => {
      if (call.name === 'hangers' && call.ops.some((o) => o.method === 'upsert')) {
        return { data: written ?? call.ops.find((o) => o.method === 'upsert')!.args[0], error: null }
      }
      if (call.name === 'hangers') return { data: rows, error: null }
      return { data: [], error: null }
    }
  const upserts = (calls: RecordedCall[]) => calls.filter((c) => c.ops.some((o) => o.method === 'upsert'))

  it('previews without writing: new, already registered and rejected are reported separately', async () => {
    const { calls } = installDb(existing([{ code: 'H1B-001', label_seq: 1 }]))
    const result = await mod.importHangers({ text: 'hanger_id,label_seq\nH1B-001,1\nH1B-002,2\nnope\n' })
    expect(upserts(calls)).toHaveLength(0)
    expect(result.data).toMatchObject({
      mode: 'preview',
      newCodes: ['H1B-002'],
      skippedCodes: ['H1B-001'],
      skipped: 1,
      inserted: null,
      insertedCodes: null,
      headerSkipped: true,
      rowCount: 3,
    })
    expect(result.data?.rejected).toEqual([expect.objectContaining({ reason: 'invalid_format', raw: 'nope' })])
  })

  it('confirm inserts the clean rows in ONE bulk statement, ignoring conflicts, as the session user', async () => {
    const { calls } = installDb(existing([]))
    const text = Array.from({ length: 300 }, (_, i) => `H1B-${String(i + 1).padStart(3, '0')}`).join('\n')
    const result = await mod.importHangers({ text, confirm: true, created_by: 'evil' } as never)

    expect(upserts(calls)).toHaveLength(1)
    const upsert = upserts(calls)[0]
    const op = upsert.ops.find((o) => o.method === 'upsert')!
    const rows = op.args[0] as Array<{ code: string; label_seq: number; created_by: string }>
    expect(rows).toHaveLength(300)
    expect(op.args[1]).toEqual({ onConflict: 'code', ignoreDuplicates: true })
    expect(rows.every((r) => r.created_by === ACTOR)).toBe(true)
    // label_seq is the numeric tail of the code (the hangers_seq_matches_code CHECK)
    expect(rows.every((r) => r.label_seq === Number(r.code.slice(-3)))).toBe(true)
    expect(result.data).toMatchObject({ mode: 'imported', inserted: 300, skipped: 0 })
    expect(result.data?.rejected).toEqual([])
  })

  it('re-importing the same list is a quiet no-op: skipped, not rejected, and no write', async () => {
    const rows = [{ code: 'H1B-001', label_seq: 1 }, { code: 'H1B-002', label_seq: 2 }]
    const { calls } = installDb(existing(rows))
    const result = await mod.importHangers({ text: 'H1B-001\nH1B-002', confirm: true })
    expect(upserts(calls)).toHaveLength(0)
    expect(result).toMatchObject({ success: true, data: { inserted: 0, skipped: 2, rejected: [] } })
  })

  it('rejects a mixed-width collision per row (H1B-0042 vs registered H1B-042) and inserts the rest', async () => {
    const { calls } = installDb(existing([{ code: 'H1B-042', label_seq: 42 }]))
    const result = await mod.importHangers({ text: 'H1B-0042\nH1B-043', confirm: true })

    const rows = upserts(calls)[0].ops.find((o) => o.method === 'upsert')!.args[0] as Array<{ code: string }>
    expect(rows.map((r) => r.code)).toEqual(['H1B-043'])
    expect(result.data?.rejected).toEqual([
      expect.objectContaining({
        reason: 'width_collision',
        line: 1,
        message: expect.stringContaining('different digit width'),
      }),
    ])
    expect(result.data).toMatchObject({ skippedCodes: [], insertedCodes: ['H1B-043'], inserted: 1, skipped: 0 })
  })

  it('reports a collision in the preview too, before anything is written', async () => {
    const { calls } = installDb(existing([{ code: 'H1B-042', label_seq: 42 }]))
    const result = await mod.importHangers({ text: 'H1B-0042' })
    expect(upserts(calls)).toHaveLength(0)
    expect(result.data).toMatchObject({ mode: 'preview', newCodes: [] })
    expect(result.data?.rejected[0].reason).toBe('width_collision')
  })

  it('never trusts a supplied label_seq: a mismatch is rejected, not inserted', async () => {
    const { calls } = installDb(existing([]))
    const result = await mod.importHangers({ text: 'H1B-042,43\nH1B-044,44', confirm: true })
    const rows = upserts(calls)[0].ops.find((o) => o.method === 'upsert')!.args[0] as Array<{ code: string; label_seq: number }>
    expect(rows).toEqual([{ code: 'H1B-044', label_seq: 44, created_by: ACTOR }])
    expect(result.data?.rejected).toEqual([expect.objectContaining({ reason: 'label_seq_mismatch' })])
  })

  it('a concurrent width collision at insert time fails the call as STATE (preview again), not a crash', async () => {
    installDb((call) => {
      if (call.ops.some((o) => o.method === 'upsert')) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uidx_hangers_prefix_seq"' } }
      }
      return { data: [], error: null }
    })
    expect(await mod.importHangers({ text: 'H1B-050', confirm: true })).toMatchObject({ success: false, code: 'STATE' })
  })

  it('reports rows lost to a concurrent import as skipped, honestly', async () => {
    installDb(existing([], [{ code: 'H1B-001' }]))
    const result = await mod.importHangers({ text: 'H1B-001\nH1B-002', confirm: true })
    expect(result.data).toMatchObject({ inserted: 1, skipped: 1 })
  })

  it('rejects empty, non-string and oversized input before the database', async () => {
    for (const text of ['', '   ', 5 as never, 'H1B-001\n'.repeat(30000)]) {
      expect(await mod.importHangers({ text })).toMatchObject({ success: false, code: 'INVALID' })
    }
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('flags a non-standard prefix without refusing it', async () => {
    installDb(existing([]))
    const result = await mod.importHangers({ text: 'H2-001' })
    expect(result.data).toMatchObject({ newCodes: ['H2-001'], nonStandardPrefixes: ['H2-'] })
  })
})

// ─── setHangerStatus ─────────────────────────────────────────────────────────

describe('setHangerStatus', () => {
  const respond = (open: unknown[], updated: unknown[], current = 'active'): Responder => (call, terminal) => {
    if (call.name === 'hangers' && terminal === 'maybeSingle') return { data: { id: HANGER, code: 'H1B-042', status: current }, error: null }
    if (call.name === 'hanger_loads') return { data: open, error: null }
    if (call.name === 'hangers') return { data: updated, error: null }
    return { data: [], error: null }
  }

  it('retires a free hanger with a row-count-asserted compare-and-swap, and audits it', async () => {
    const { calls } = installDb(respond([], [{ id: HANGER }]))
    expect(await mod.setHangerStatus(HANGER, 'retired', ' bent ')).toEqual({ success: true, data: null })
    const update = calls.find((c) => c.name === 'hangers' && c.ops.some((o) => o.method === 'update'))!
    expect(update.ops).toEqual(
      expect.arrayContaining([
        { method: 'update', args: [{ status: 'retired' }] },
        { method: 'eq', args: ['id', HANGER] },
        { method: 'eq', args: ['status', 'active'] },
        { method: 'select', args: ['id'] },
      ])
    )
    const event = calls.find((c) => c.name === 'trim_events')!
    expect(event.ops.find((o) => o.method === 'insert')?.args[0]).toMatchObject({
      actor_user_id: ACTOR,
      event_type: 'hanger_status_changed',
      hanger_id: HANGER,
      payload: { from: 'active', to: 'retired', reason: 'bent' },
    })
  })

  it('refuses to retire or lose a hanger with an open load, but reactivation is allowed', async () => {
    for (const status of ['retired', 'lost'] as const) {
      const { calls } = installDb(respond([{ id: 'l1' }], [{ id: HANGER }]))
      expect(await mod.setHangerStatus(HANGER, status)).toMatchObject({ success: false, code: 'STATE' })
      expect(calls.some((c) => c.ops.some((o) => o.method === 'update'))).toBe(false)
    }
    installDb(respond([{ id: 'l1' }], [{ id: HANGER }], 'lost'))
    expect((await mod.setHangerStatus(HANGER, 'active')).success).toBe(true)
  })

  it('fails when the UPDATE matches no rows', async () => {
    installDb(respond([], []))
    expect(await mod.setHangerStatus(HANGER, 'lost')).toMatchObject({ success: false, code: 'STATE' })
  })

  it('is a no-op when the status is unchanged, and NOT_FOUND for an unknown hanger', async () => {
    const { calls } = installDb(respond([], [], 'retired'))
    expect(await mod.setHangerStatus(HANGER, 'retired')).toEqual({ success: true, data: null })
    expect(calls.some((c) => c.ops.some((o) => o.method === 'update'))).toBe(false)

    installDb(() => ({ data: null, error: null }))
    expect(await mod.setHangerStatus(HANGER, 'lost')).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('validates before the database', async () => {
    for (const run of [
      () => mod.setHangerStatus('nope', 'lost'),
      () => mod.setHangerStatus(HANGER, 'broken' as never),
      () => mod.setHangerStatus(HANGER, 'lost', 'x'.repeat(501)),
    ]) {
      expect(await run()).toMatchObject({ success: false, code: 'INVALID' })
    }
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })
})
