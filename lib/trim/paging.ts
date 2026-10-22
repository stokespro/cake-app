// Harvest & Trim: read every row of a PostgREST query, a page at a time.
//
// Why this exists: PostgREST (Supabase) enforces a server-side max-rows of 1,000 per request, and it does
// so SILENTLY. `.limit(5000)` and `.range(0, 4999)` both return 1,000 rows with HTTP 200 and no error
// (verified against the live API). A report that summed one request's rows was therefore quietly wrong
// the day a range crossed 1,000 returns. This helper pages with `.range()` until the result set is
// exhausted, so a report's totals always cover the whole filtered range.
//
// How it stays correct:
//   - The first page is requested with an exact count. The loop runs until it has that many rows, and it
//     advances by the number of rows actually received, not by the page size it asked for. If the server
//     ever lowered max-rows below the page size the loop would simply take more requests, not stop early.
//   - After the loop, fewer rows than the count (without having hit the ceiling) is reported as a failure,
//     never as a short result.
//   - The ceiling is a safety stop for a pathological range. Hitting it is reported as `truncated`, and the
//     caller must say so on screen: totals over a truncated set are incomplete.
//
// The caller must give the query a TOTAL order (a unique tiebreaker such as id), or rows that tie on the
// sort key can repeat or vanish across page boundaries.
//
// Pure: no I/O of its own, safe in a 'use server' file's imports and in tests.

/** PostgREST's default max-rows. Pages this size are the biggest a single request can return. */
export const PAGE_SIZE = 1000
/** Hard safety stop: rows beyond this are not fetched and the result is flagged truncated. */
export const ROW_CEILING = 10_000

export interface Page<T> {
  rows: T[]
  /** Exact count of the whole filtered set. Only the first page needs to carry it. */
  total: number | null
  error: unknown
}

export type FetchAllResult<T> =
  | { ok: true; rows: T[]; truncated: boolean }
  | { ok: false; error: unknown }

export async function fetchAllRows<T>(
  /** Fetch rows `from`..`to` inclusive. `from === 0` is the first page: ask for the exact count there. */
  fetchPage: (from: number, to: number) => PromiseLike<Page<T>>,
  options: { pageSize?: number; ceiling?: number } = {}
): Promise<FetchAllResult<T>> {
  const pageSize = options.pageSize ?? PAGE_SIZE
  const ceiling = options.ceiling ?? ROW_CEILING
  const rows: T[] = []
  let total: number | null = null
  let offset = 0

  while (offset < ceiling) {
    const to = Math.min(offset + pageSize, ceiling) - 1
    const asked = to - offset + 1
    const page = await fetchPage(offset, to)
    if (page.error) return { ok: false, error: page.error }
    if (total === null && page.total !== null) total = page.total
    if (page.rows.length === 0) break
    rows.push(...page.rows)
    offset += page.rows.length
    // With a count, keep going until we hold that many. Without one, a short page means the end.
    if (total !== null ? offset >= total : page.rows.length < asked) break
  }

  const truncated = offset >= ceiling && (total === null || total > ceiling)
  if (!truncated && total !== null && rows.length < total) {
    return { ok: false, error: new Error(`Incomplete read: received ${rows.length} of ${total} rows`) }
  }
  return { ok: true, rows, truncated }
}
