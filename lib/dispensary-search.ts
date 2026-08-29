/**
 * Matching for the dispensary map's search box.
 *
 * Split out of the page component so it can be tested directly: the punctuation
 * handling on OMMA licences is the kind of thing that silently regresses, and
 * "does DAAA-4YAE-YRGF still work" should be answerable by a test rather than
 * by opening a browser.
 *
 * Structured as a prebuilt index rather than a predicate run over raw rows.
 * Normalising 1,785 dispensaries' three fields on every keystroke means ~5,300
 * lowercase calls and regex replacements per character typed, and it recomputes
 * identical results each time. Normalising once when the points load, then
 * scanning prebuilt strings, keeps typing responsive.
 */

/** Which field a hit came from, so the UI can show why a row matched. */
export type SearchMatchField = 'name' | 'license_name' | 'omma_license'

export interface SearchableDispensary {
  name: string
  license_name: string | null
  omma_license: string | null
}

export interface SearchEntry<T> {
  point: T
  /** Lowercased trading name. */
  name: string
  /** Lowercased licensed entity name. */
  licenseName: string
  /** Licence with punctuation removed, lowercased. */
  licence: string
}

/**
 * Reduce a licence to comparable form: lowercase, alphanumerics only.
 *
 * Applied to both the stored value and the query, so `DAAA-4YAE-YRGF`,
 * `daaa4yaeyrgf` and `daaa 4yae yrgf` all collapse to the same string. Nobody
 * types the hyphens consistently, and a licence pasted from OMMA's site keeps
 * them.
 */
export function normalizeLicence(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/** Normalise every point's searchable fields once, when the data loads. */
export function buildSearchIndex<T extends SearchableDispensary>(
  points: T[]
): SearchEntry<T>[] {
  return points.map((point) => ({
    point,
    name: point.name?.toLowerCase() ?? '',
    licenseName: point.license_name?.toLowerCase() ?? '',
    licence: normalizeLicence(point.omma_license),
  }))
}

export interface PreparedQuery {
  /** Trimmed, lowercased — for the two name fields. */
  text: string
  /** Alphanumerics only — for the licence. Empty when the query has no. */
  bare: string
}

/**
 * Normalise the query once per keystroke instead of once per candidate.
 *
 * Returns null for a blank query so callers can skip the scan entirely rather
 * than matching everything against an empty string.
 */
export function prepareQuery(raw: string): PreparedQuery | null {
  const text = raw.trim().toLowerCase()
  if (!text) return null
  return { text, bare: text.replace(/[^a-z0-9]/g, '') }
}

/**
 * Which field of this entry matches, or null.
 *
 * Order is deliberate: the trading name is what the user sees on the pin, so a
 * hit there needs no explanation in the results row. Licence matches are
 * reported so the row can show the field that matched.
 *
 * Substring rather than prefix throughout — staff search the distinctive middle
 * of a name ("releaf", "420") far more often than they type one from the start.
 */
export function matchEntry<T>(
  entry: SearchEntry<T>,
  query: PreparedQuery
): SearchMatchField | null {
  if (entry.name.includes(query.text)) return 'name'
  if (entry.licenseName.includes(query.text)) return 'license_name'
  // Guard on `bare`: a punctuation-only query normalises to an empty string,
  // and every licence contains that, which would match all 1,785 rows.
  if (query.bare && entry.licence.includes(query.bare)) return 'omma_license'
  return null
}

export interface SearchHit<T> {
  point: T
  matchedOn: SearchMatchField
}

export interface SearchOutcome<T> {
  /** Capped at `limit`. */
  hits: SearchHit<T>[]
  /** Every match, including those beyond the cap, so the UI can say what it dropped. */
  total: number
}

/**
 * Scan the index for a query.
 *
 * Collects a capped number of hits but keeps counting past the cap: a
 * two-letter query matches over a thousand of these and rendering them all
 * makes each keystroke stutter, but silently showing 40 with no indication that
 * more exist reads as "that's all there is".
 */
export function searchDispensaries<T>(
  index: SearchEntry<T>[],
  rawQuery: string,
  limit: number
): SearchOutcome<T> {
  const query = prepareQuery(rawQuery)
  if (!query) return { hits: [], total: 0 }

  const hits: SearchHit<T>[] = []
  let total = 0
  for (const entry of index) {
    const matchedOn = matchEntry(entry, query)
    if (!matchedOn) continue
    total++
    if (hits.length < limit) hits.push({ point: entry.point, matchedOn })
  }
  return { hits, total }
}
