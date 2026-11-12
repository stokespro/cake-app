// SPRO-279: dispensary license document actions. Hermetic — session and
// Supabase clients are mocked, same style as actions/customers.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequireRole = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  requireRole: (...args: unknown[]) => mockRequireRole(...args),
}))

const mockCreateServiceClient = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => mockCreateServiceClient(...args),
}))

const {
  attachDispensaryDocument,
  removeDispensaryDocument,
  createDispensaryDocumentUploadUrl,
  updateDispensaryDocumentExpiration,
} = await import('./dispensary-documents')

const D = 'disp-1'

function makeDb(opts: {
  listing?: Array<{ name: string; metadata?: Record<string, unknown> }>
  existing?: { file_path: string } | null
} = {}) {
  const calls = {
    upsert: [] as unknown[][],
    remove: [] as string[][],
    deleted: false,
  }
  const table: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'update']) table[m] = () => table
  table.maybeSingle = () => Promise.resolve({ data: opts.existing ?? null, error: null })
  table.single = () => Promise.resolve({ data: { id: 'row-1' }, error: null })
  table.upsert = (...args: unknown[]) => {
    calls.upsert.push(args)
    return table
  }
  table.delete = () => {
    calls.deleted = true
    return table
  }
  table.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok)

  const bucket = {
    createSignedUploadUrl: vi.fn(async () => ({ data: { token: 't' }, error: null })),
    list: vi.fn(async () => ({ data: opts.listing ?? [], error: null })),
    remove: vi.fn(async (paths: string[]) => {
      calls.remove.push(paths)
      return { data: [], error: null }
    }),
  }
  const client = { from: () => table, storage: { from: () => bucket } }
  return { client, calls, bucket }
}

beforeEach(() => {
  mockRequireRole.mockReset()
  mockCreateServiceClient.mockReset()
  mockRequireRole.mockResolvedValue({ authorized: true, session: { userId: 'u1' } })
})

describe('auth', () => {
  it('short-circuits every write action when unauthorized', async () => {
    mockRequireRole.mockResolvedValue({ authorized: false, reason: 'nope' })
    const results = await Promise.all([
      createDispensaryDocumentUploadUrl(D, 'omma', 'a.pdf'),
      attachDispensaryDocument(D, 'omma', `${D}/omma/x.pdf`, 'x.pdf'),
      removeDispensaryDocument(D, 'omma'),
      updateDispensaryDocumentExpiration(D, 'omma', null),
    ])
    for (const r of results) expect(r).toEqual({ success: false, error: 'nope' })
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })
})

describe('attachDispensaryDocument', () => {
  it('rejects an invalid document type', async () => {
    const r = await attachDispensaryDocument(D, 'xyz' as never, `${D}/xyz/a.pdf`, 'a.pdf')
    expect(r.success).toBe(false)
  })

  it('rejects paths outside the dispensary/type prefix or containing ..', async () => {
    for (const p of [`other/omma/a.pdf`, `${D}/obn/a.pdf`, `${D}/omma/../x.pdf`]) {
      const r = await attachDispensaryDocument(D, 'omma', p, 'a.pdf')
      expect(r).toEqual({ success: false, error: 'Invalid file path' })
    }
    expect(mockCreateServiceClient).not.toHaveBeenCalled()
  })

  it('returns Upload not found when the object is not listed', async () => {
    const { client } = makeDb({ listing: [] })
    mockCreateServiceClient.mockResolvedValue(client)
    const r = await attachDispensaryDocument(D, 'omma', `${D}/omma/1-a.pdf`, 'a.pdf')
    expect(r).toEqual({ success: false, error: 'Upload not found' })
  })

  it('removes the object and errors on a disallowed MIME type', async () => {
    const { client, calls } = makeDb({
      listing: [{ name: '1-a.docx', metadata: { size: 10, mimetype: 'application/msword' } }],
    })
    mockCreateServiceClient.mockResolvedValue(client)
    const r = await attachDispensaryDocument(D, 'omma', `${D}/omma/1-a.docx`, 'a.docx')
    expect(r.success).toBe(false)
    expect(calls.remove).toEqual([[`${D}/omma/1-a.docx`]])
    expect(calls.upsert).toHaveLength(0)
  })

  it('upserts on (dispensary_id, document_type) and removes the old object', async () => {
    const { client, calls } = makeDb({
      listing: [{ name: '2-b.png', metadata: { size: 10, mimetype: 'image/png' } }],
      existing: { file_path: `${D}/omma/1-a.pdf` },
    })
    mockCreateServiceClient.mockResolvedValue(client)
    const r = await attachDispensaryDocument(D, 'omma', `${D}/omma/2-b.png`, 'b.png', '2030-01-31')
    expect(r.success).toBe(true)
    expect(calls.upsert[0][1]).toEqual({ onConflict: 'dispensary_id,document_type' })
    expect(calls.upsert[0][0]).toMatchObject({
      dispensary_id: D,
      document_type: 'omma',
      file_path: `${D}/omma/2-b.png`,
      expiration_date: '2030-01-31',
      uploaded_by: 'u1',
    })
    expect(calls.remove).toEqual([[`${D}/omma/1-a.pdf`]])
  })

  it('rejects a malformed expiration date', async () => {
    const r = await attachDispensaryDocument(D, 'omma', `${D}/omma/1-a.pdf`, 'a.pdf', '01/02/2030')
    expect(r).toEqual({ success: false, error: 'Invalid expiration date' })
  })
})

describe('removeDispensaryDocument', () => {
  it('deletes the row and the storage object', async () => {
    const { client, calls } = makeDb({ existing: { file_path: `${D}/dea/1-a.pdf` } })
    mockCreateServiceClient.mockResolvedValue(client)
    const r = await removeDispensaryDocument(D, 'dea')
    expect(r).toEqual({ success: true })
    expect(calls.deleted).toBe(true)
    expect(calls.remove).toEqual([[`${D}/dea/1-a.pdf`]])
  })

  it('errors when no document exists', async () => {
    const { client } = makeDb({ existing: null })
    mockCreateServiceClient.mockResolvedValue(client)
    const r = await removeDispensaryDocument(D, 'dea')
    expect(r).toEqual({ success: false, error: 'Document not found' })
  })
})
