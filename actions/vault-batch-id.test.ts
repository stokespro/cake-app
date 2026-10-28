// SPRO-235: packages are linked to batches by batch_id. Covers createPackage / updatePackage /
// deleteBatch against a fake service client (no database).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequireRole = vi.fn()
vi.mock('@/lib/auth/session', () => ({ requireRole: (...a: unknown[]) => mockRequireRole(...a) }))

type Row = Record<string, unknown>
interface Fake {
  tables: Record<string, Row[]>
  inserts: Row[]
  updates: Row[]
  deleteError: { code: string; message: string } | null
}
let fake: Fake

function builder(table: string) {
  const filters: Array<[string, unknown]> = []
  let mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
  let payload: Row = {}
  const rows = () => (fake.tables[table] ?? []).filter(r => filters.every(([k, v]) => r[k] === v))
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (k: string, v: unknown) => (filters.push([k, v]), b),
    limit: () => b,
    insert: (p: Row) => ((mode = 'insert'), (payload = p), fake.inserts.push(p), b),
    update: (p: Row) => ((mode = 'update'), (payload = p), fake.updates.push(p), b),
    delete: () => ((mode = 'delete'), b),
    single: async () => ({ data: mode === 'insert' ? payload : rows()[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (res: (v: unknown) => unknown) =>
      res(
        mode === 'delete' && fake.deleteError
          ? { data: null, error: fake.deleteError }
          : { data: rows(), error: null }
      ),
  }
  return b
}
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: async () => ({ from: (t: string) => builder(t) }),
}))

import { createPackage, deleteBatch, updatePackage } from './vault'

beforeEach(() => {
  mockRequireRole.mockReset().mockResolvedValue({ authorized: true })
  fake = {
    tables: {
      batches: [
        { id: 'b1', name: 'BATCH-1', strain_id: 's1' },
        { id: 'b2', name: 'NO-STRAIN', strain_id: null },
      ],
      strains: [{ id: 's1', name: 'Aloha Sugar' }],
      packages: [],
    },
    inserts: [],
    updates: [],
    deleteError: null,
  }
})

describe('createPackage', () => {
  it('inserts batch_id plus batch/strain copies derived from the batch', async () => {
    const r = await createPackage('TAG1', 'b1', 'type1', 10, 'u1')
    expect(r.success).toBe(true)
    expect(fake.inserts[0]).toMatchObject({
      tag_id: 'TAG1', batch_id: 'b1', batch: 'BATCH-1', strain: 'Aloha Sugar', strain_id: 's1',
    })
  })

  it('rejects an unknown batch id and a batch without a strain', async () => {
    expect((await createPackage('T', 'nope', 't', 1, 'u')).success).toBe(false)
    const r = await createPackage('T', 'b2', 't', 1, 'u')
    expect(r.success).toBe(false)
    expect(r.error).toContain('no strain')
    expect(fake.inserts).toHaveLength(0)
  })

  it('fails closed without a role', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'No valid session' })
    const r = await createPackage('T', 'b1', 't', 1, 'u')
    expect(r).toEqual({ success: false, error: 'No valid session' })
  })
})

describe('updatePackage', () => {
  it('sets batch_id and derived copies when batchId changes', async () => {
    fake.tables.packages = [{ tag_id: 'TAG1' }]
    const r = await updatePackage('TAG1', { batchId: 'b1' })
    expect(r.success).toBe(true)
    expect(fake.updates[0]).toMatchObject({
      batch_id: 'b1', batch: 'BATCH-1', strain: 'Aloha Sugar', strain_id: 's1',
    })
  })

  it('rejects an empty batch id', async () => {
    expect((await updatePackage('TAG1', { batchId: ' ' })).success).toBe(false)
  })
})

describe('deleteBatch', () => {
  it('blocks when packages reference the batch_id', async () => {
    fake.tables.packages = [{ tag_id: 'TAG1', batch_id: 'b1' }]
    const r = await deleteBatch('b1')
    expect(r).toEqual({ success: false, error: 'Cannot delete batch that is in use by packages' })
  })

  it('maps FK violation 23503 to the friendly message', async () => {
    fake.deleteError = { code: '23503', message: 'violates foreign key' }
    const r = await deleteBatch('b1')
    expect(r.error).toBe('Cannot delete batch that is in use by packages')
  })

  it('deletes an unused batch', async () => {
    expect(await deleteBatch('b1')).toEqual({ success: true })
  })
})
