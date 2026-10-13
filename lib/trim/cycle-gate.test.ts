import { describe, expect, it } from 'vitest'
import { MAX_NAMED_HANGERS, evaluateCycleGate, type CycleGateBatch, type CycleGateLoad } from './cycle-gate'
import type { HangerLoadStatus } from '@/types/harvest-trim'

const CLOSED = '2026-10-20T12:00:00Z'

function loads(status: HangerLoadStatus, n: number, startAt = 1): CycleGateLoad[] {
  return Array.from({ length: n }, (_, i) => ({
    status,
    hangerCode: `H1B-${String(startAt + i).padStart(3, '0')}`,
  }))
}
function batch(over: Partial<CycleGateBatch> & { id: string }): CycleGateBatch {
  return { name: `0929-F1-${over.id}`, trimClosedAt: null, loads: [], ...over }
}

describe('cycles that never used the module', () => {
  it('no batches at all: open, gate inactive', () => {
    expect(evaluateCycleGate([])).toEqual({ canEnd: true, gateActive: false, blockers: [], warnings: [] })
  })

  it('legacy batches with no loads: open, gate inactive', () => {
    const r = evaluateCycleGate([batch({ id: 'A' }), batch({ id: 'B' })])
    expect(r.canEnd).toBe(true)
    expect(r.gateActive).toBe(false)
    expect(r.blockers).toEqual([])
  })
})

describe('the gate once any batch has loads', () => {
  it('all reconciled and trim-closed: can end', () => {
    const r = evaluateCycleGate([batch({ id: 'A', loads: loads('reconciled', 5), trimClosedAt: CLOSED })])
    expect(r).toMatchObject({ canEnd: true, gateActive: true, blockers: [] })
  })

  it('reconciled and void mixed, closed: can end', () => {
    const r = evaluateCycleGate([
      batch({ id: 'A', loads: [...loads('reconciled', 4), ...loads('void', 1, 10)], trimClosedAt: CLOSED }),
    ])
    expect(r.canEnd).toBe(true)
  })

  it('reconciled but not closed: blocked with batch_not_closed', () => {
    const r = evaluateCycleGate([batch({ id: 'A', loads: loads('reconciled', 3) })])
    expect(r.canEnd).toBe(false)
    expect(r.blockers).toHaveLength(1)
    expect(r.blockers[0]).toMatchObject({ kind: 'batch_not_closed', batchId: 'A', batchName: '0929-F1-A' })
    expect(r.blockers[0].message).toContain('0929-F1-A')
  })

  it.each(['hung', 'dried', 'checked_out', 'partial', 'returned'] as const)('a %s load blocks', (status) => {
    const r = evaluateCycleGate([
      batch({ id: 'A', loads: [...loads('reconciled', 3), ...loads(status, 1, 50)], trimClosedAt: CLOSED }),
    ])
    expect(r.canEnd).toBe(false)
    expect(r.blockers[0]).toMatchObject({
      kind: 'open_loads',
      count: 1,
      byStatus: { [status]: 1 },
      hangerCodes: ['H1B-050'],
    })
  })

  it('a partial load is named in the message', () => {
    const r = evaluateCycleGate([batch({ id: 'A', loads: loads('partial', 1, 42) })])
    expect(r.blockers[0].message).toContain('H1B-042')
    expect(r.blockers[0].message).toContain('1 partial')
  })

  it('open loads outrank "not closed": one blocker per batch, not two', () => {
    const r = evaluateCycleGate([batch({ id: 'A', loads: [...loads('reconciled', 2), ...loads('returned', 2, 10)] })])
    expect(r.blockers).toHaveLength(1)
    expect(r.blockers[0].kind).toBe('open_loads')
  })

  it('breaks the open loads down by status', () => {
    const r = evaluateCycleGate([
      batch({ id: 'A', loads: [...loads('partial', 2, 1), ...loads('returned', 1, 5), ...loads('hung', 3, 8)] }),
    ])
    const b = r.blockers[0]
    expect(b).toMatchObject({ count: 6, byStatus: { partial: 2, returned: 1, hung: 3 } })
    expect(b.message).toContain('6 hangers are not finished')
  })

  it('caps the named hangers and says how many more', () => {
    const r = evaluateCycleGate([batch({ id: 'A', loads: loads('dried', 25) })])
    const b = r.blockers[0]
    expect(b.kind === 'open_loads' && b.hangerCodes).toHaveLength(MAX_NAMED_HANGERS)
    expect(b.kind === 'open_loads' && b.count).toBe(25)
    expect(b.message).toContain('and 15 more')
  })

  it('names blockers in every offending batch', () => {
    const r = evaluateCycleGate([
      batch({ id: 'A', loads: loads('reconciled', 2), trimClosedAt: CLOSED }),
      batch({ id: 'B', loads: loads('partial', 1, 20) }),
      batch({ id: 'C', loads: loads('reconciled', 2, 30) }),
    ])
    expect(r.blockers.map((b) => [b.batchId, b.kind])).toEqual([
      ['B', 'open_loads'],
      ['C', 'batch_not_closed'],
    ])
  })

  it('loads without a hanger code still block (just unnamed)', () => {
    const r = evaluateCycleGate([batch({ id: 'A', loads: [{ status: 'hung' }] })])
    expect(r.blockers[0]).toMatchObject({ kind: 'open_loads', hangerCodes: [] })
    expect(r.blockers[0].message).not.toContain('()')
  })

  it('one used batch activates the gate for its siblings', () => {
    const r = evaluateCycleGate([batch({ id: 'A', loads: loads('reconciled', 2), trimClosedAt: CLOSED }), batch({ id: 'B' })])
    expect(r.gateActive).toBe(true)
    expect(r.canEnd).toBe(true) // the empty sibling only warns
  })
})

describe('warnings (never block)', () => {
  it('declared-but-empty batch warns', () => {
    const r = evaluateCycleGate([
      batch({ id: 'A', loads: loads('reconciled', 2), trimClosedAt: CLOSED }),
      batch({ id: 'B', name: '0929-F1-GG' }),
    ])
    expect(r.canEnd).toBe(true)
    expect(r.warnings).toEqual([
      { kind: 'declared_empty', batchId: 'B', batchName: '0929-F1-GG', message: expect.stringContaining('0929-F1-GG') },
    ])
  })

  it('warns on declared-empty batches even when the whole cycle is unused', () => {
    const r = evaluateCycleGate([batch({ id: 'A' })])
    expect(r.canEnd).toBe(true)
    expect(r.warnings.map((w) => w.kind)).toEqual(['declared_empty'])
  })

  it('an all-void batch warns instead of deadlocking the cycle', () => {
    const r = evaluateCycleGate([
      batch({ id: 'A', loads: loads('reconciled', 2), trimClosedAt: CLOSED }),
      batch({ id: 'V', loads: loads('void', 3, 40) }),
    ])
    expect(r.canEnd).toBe(true)
    expect(r.warnings.map((w) => w.kind)).toEqual(['all_loads_void'])
  })

  it('warnings accompany blockers', () => {
    const r = evaluateCycleGate([batch({ id: 'A', loads: loads('hung', 1) }), batch({ id: 'B' })])
    expect(r.canEnd).toBe(false)
    expect(r.warnings.map((w) => w.kind)).toEqual(['declared_empty'])
  })
})

describe('scale', () => {
  it('handles hundreds of loads', () => {
    const r = evaluateCycleGate([
      batch({ id: 'A', loads: loads('reconciled', 300), trimClosedAt: CLOSED }),
      batch({ id: 'B', loads: loads('reconciled', 300), trimClosedAt: CLOSED }),
    ])
    expect(r.canEnd).toBe(true)
  })
})
