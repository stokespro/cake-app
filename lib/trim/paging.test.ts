import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, ROW_CEILING, fetchAllRows, type Page } from './paging'

/** A stand-in for PostgREST: `n` rows, never more than `maxRows` per request, count only on request. */
function fakeServer(n: number, maxRows = 1000, { withCount = true }: { withCount?: boolean } = {}) {
  const requests: Array<[number, number]> = []
  const fetchPage = async (from: number, to: number): Promise<Page<number>> => {
    requests.push([from, to])
    const end = Math.min(to, from + maxRows - 1, n - 1)
    const rows: number[] = []
    for (let i = from; i <= end; i++) rows.push(i)
    return { rows, total: withCount && from === 0 ? n : null, error: null }
  }
  return { fetchPage, requests }
}

describe('fetchAllRows', () => {
  it('constants: pages are PostgREST-sized and the ceiling is 10,000', () => {
    expect(PAGE_SIZE).toBe(1000)
    expect(ROW_CEILING).toBe(10_000)
  })

  it('a small result is one request', async () => {
    const s = fakeServer(89)
    const r = await fetchAllRows(s.fetchPage)
    expect(r).toMatchObject({ ok: true, truncated: false })
    expect(r.ok && r.rows).toHaveLength(89)
    expect(s.requests).toEqual([[0, 999]])
  })

  it('an empty result is empty, not an error', async () => {
    const r = await fetchAllRows(fakeServer(0).fetchPage)
    expect(r).toEqual({ ok: true, rows: [], truncated: false })
  })

  it('reads past the 1,000-row server cap: 2,500 rows arrive complete, in order, once', async () => {
    const s = fakeServer(2500)
    const r = await fetchAllRows(s.fetchPage)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.truncated).toBe(false)
    expect(r.rows).toHaveLength(2500)
    expect(r.rows[0]).toBe(0)
    expect(r.rows[2499]).toBe(2499)
    expect(new Set(r.rows).size).toBe(2500)
    expect(s.requests).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })

  it('an exact multiple of the page size needs no extra empty request when the count is known', async () => {
    const s = fakeServer(2000)
    const r = await fetchAllRows(s.fetchPage)
    expect(r.ok && r.rows).toHaveLength(2000)
    expect(s.requests).toHaveLength(2)
  })

  it('still completes if the server returns fewer rows per request than asked (advances by rows received)', async () => {
    const s = fakeServer(1000, 300)
    const r = await fetchAllRows(s.fetchPage)
    expect(r.ok && r.rows).toHaveLength(1000)
    expect(r.ok && r.truncated).toBe(false)
    expect(s.requests.map(([from]) => from)).toEqual([0, 300, 600, 900])
  })

  it('without a count, a short page ends the read', async () => {
    const s = fakeServer(1500, 1000, { withCount: false })
    const r = await fetchAllRows(s.fetchPage)
    expect(r.ok && r.rows).toHaveLength(1500)
    expect(s.requests).toHaveLength(2)
  })

  it('stops at the ceiling and says so: 12,000 rows -> the first 10,000, truncated', async () => {
    const s = fakeServer(12_000)
    const r = await fetchAllRows(s.fetchPage)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.truncated).toBe(true)
    expect(r.rows).toHaveLength(ROW_CEILING)
    expect(s.requests).toHaveLength(10)
    // Never asks for a row beyond the ceiling.
    expect(Math.max(...s.requests.map(([, to]) => to))).toBe(ROW_CEILING - 1)
  })

  it('exactly the ceiling is complete, not truncated', async () => {
    const r = await fetchAllRows(fakeServer(ROW_CEILING).fetchPage)
    expect(r.ok && r.rows).toHaveLength(ROW_CEILING)
    expect(r.ok && r.truncated).toBe(false)
  })

  it('without a count, hitting the ceiling is treated as truncated (cannot prove otherwise)', async () => {
    const r = await fetchAllRows(fakeServer(ROW_CEILING, 1000, { withCount: false }).fetchPage)
    expect(r.ok && r.truncated).toBe(true)
  })

  it('a database error on any page fails the whole read (never a partial result)', async () => {
    const boom = new Error('boom')
    const r = await fetchAllRows(async (from): Promise<Page<number>> =>
      from === 0 ? { rows: Array.from({ length: 1000 }, (_, i) => i), total: 2500, error: null } : { rows: [], total: null, error: boom }
    )
    expect(r).toEqual({ ok: false, error: boom })
  })

  it('fewer rows than the count, short of the ceiling, is a failure and not a quiet short result', async () => {
    const r = await fetchAllRows(async (from): Promise<Page<number>> =>
      from === 0 ? { rows: [1, 2, 3], total: 10, error: null } : { rows: [], total: null, error: null }
    )
    expect(r.ok).toBe(false)
  })
})
