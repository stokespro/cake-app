// Suggested harvest batch names: MMDD-F{room}-{ABBR}, e.g. 0723-F1-CM.
//
// The name is a display convention, not a join key (batches.room_cycle_id is the
// real link) — so everything here is a SUGGESTION the declare-batches dialog
// pre-fills and the user can edit.
//
// Abbreviation (R2.5), tried in order, the first usable one wins:
//   1. the last segment of that strain's MOST RECENT batch name
//      ("0723-F1-CM" -> "CM"; a "-2"/"-3" split suffix is skipped, so
//      "0622-F5-CM-3" is still "CM");
//   2. a skus.code linked to the strain (first token before any punctuation);
//   3. initials of the strain name ("Cherry Mintz" -> "CM").
// `strains` has no abbreviation column and must not be repurposed (it is
// menu-facing), so this derives one from data we already have.
//
// Collisions: if the name is taken, append "-2", "-3", ... Case-insensitive, and
// the allocator also tracks names handed out earlier in the same dialog, so
// declaring the same strain twice yields "...-CM" then "...-CM-2".
//
// Pure: takes the existing names as input, no I/O, no imports from actions/.

export interface StrainBatchRef {
  name: string
  /** ISO timestamp. When absent on every ref, the FIRST ref is treated as newest. */
  createdAt?: string | null
}

export type AbbreviationSource = 'batch_history' | 'sku_code' | 'initials'

export interface StrainAbbreviation {
  abbreviation: string
  source: AbbreviationSource
}

const MAX_ABBR_LENGTH = 6
/** Used only if a strain name has no letters or digits at all; the user will edit it. */
const FALLBACK_ABBR = 'XX'

function isUsableAbbreviation(s: string): boolean {
  return /^[A-Z0-9]+$/.test(s) && s.length <= MAX_ABBR_LENGTH && /[A-Z]/.test(s)
}

/**
 * "0723-F1-CM" -> "CM". Needs the MMDD-F{n}-{ABBR} shape (so free-form names
 * like "Test batch" are skipped); trailing numeric split suffixes are ignored.
 * Returns null when no usable abbreviation is found.
 */
export function abbreviationFromBatchName(name: string): string | null {
  const parts = String(name ?? '').trim().split('-')
  while (parts.length > 3 && /^\d+$/.test(parts[parts.length - 1])) parts.pop()
  if (parts.length < 3 || !/^\d{4}$/.test(parts[0])) return null
  const last = parts[parts.length - 1].toUpperCase()
  return isUsableAbbreviation(last) ? last : null
}

/** "CM-3.5-8" -> "CM". Takes the leading alphanumeric run; null if unusable. */
export function abbreviationFromSkuCode(code: string | null | undefined): string | null {
  const token = String(code ?? '').trim().toUpperCase().split(/[^A-Z0-9]+/)[0] ?? ''
  return isUsableAbbreviation(token) ? token : null
}

/**
 * Initials of the strain name: "Cherry Mintz" -> "CM", "Gelato 41" -> "G41".
 * A one-word name takes its first two letters ("Zkittlez" -> "ZK") so two
 * strains don't collapse onto one letter.
 */
export function abbreviationFromStrainName(strainName: string): string {
  const words = String(strainName ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length === 0) return FALLBACK_ABBR
  let out = ''
  for (const w of words) {
    out += /^\d/.test(w) ? /^\d+/.exec(w)![0] : w[0]
  }
  if (words.length === 1 && /^[A-Za-z]/.test(words[0])) out = words[0].slice(0, 2)
  out = out.toUpperCase().slice(0, MAX_ABBR_LENGTH)
  return /[A-Z0-9]/.test(out) ? out : FALLBACK_ABBR
}

export interface DeriveAbbreviationInput {
  strainName: string
  /** Existing batches of THIS strain (any order if createdAt is set). */
  strainBatches?: readonly StrainBatchRef[]
  /** skus.code values linked to this strain. */
  skuCodes?: readonly (string | null | undefined)[]
}

/** The strain's most recent batch by createdAt (single pass); first wins ties and missing dates. */
function mostRecent(refs: readonly StrainBatchRef[]): StrainBatchRef | null {
  let best: StrainBatchRef | null = null
  let bestTime = -Infinity
  for (const ref of refs) {
    const t = ref.createdAt ? Date.parse(ref.createdAt) : NaN
    const time = Number.isNaN(t) ? -Infinity : t
    if (best === null || time > bestTime) {
      best = ref
      bestTime = time
    }
  }
  return best
}

export function deriveStrainAbbreviation(input: DeriveAbbreviationInput): StrainAbbreviation {
  if (input.strainBatches?.length) {
    const recent = mostRecent(input.strainBatches)
    const fromHistory = recent ? abbreviationFromBatchName(recent.name) : null
    if (fromHistory) return { abbreviation: fromHistory, source: 'batch_history' }
  }
  for (const code of input.skuCodes ?? []) {
    const fromSku = abbreviationFromSkuCode(code)
    if (fromSku) return { abbreviation: fromSku, source: 'sku_code' }
  }
  return { abbreviation: abbreviationFromStrainName(input.strainName), source: 'initials' }
}

export interface BatchNameParts {
  /** YYYY-MM-DD. Taken from the string, never through Date, so no timezone shift. */
  harvestDate: string
  /** grow_rooms.room_number. */
  roomNumber: number
  abbreviation: string
}

/** MMDD-F{room}-{ABBR}. Throws RangeError on a malformed date, room or empty abbreviation. */
export function formatBatchName({ harvestDate, roomNumber, abbreviation }: BatchNameParts): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(harvestDate ?? ''))
  const month = m ? Number(m[2]) : 0
  const day = m ? Number(m[3]) : 0
  if (!m || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`harvestDate must be YYYY-MM-DD, got ${harvestDate}`)
  }
  if (!Number.isInteger(roomNumber) || roomNumber < 1) {
    throw new RangeError(`roomNumber must be a positive integer, got ${roomNumber}`)
  }
  const abbr = String(abbreviation ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!abbr) throw new RangeError('abbreviation is empty')
  return `${m[2]}${m[3]}-F${roomNumber}-${abbr}`
}

export interface BatchNameAllocator {
  /** Returns `base`, or `base-2`, `base-3`, ... — whichever is free — and reserves it. */
  allocate(base: string): string
  isTaken(name: string): boolean
}

/**
 * Hands out unique names against the existing batch names and against
 * everything it has already allocated. O(1) per name plus one step per
 * collision, so declaring a dozen batches against hundreds of existing names
 * is a single Set build.
 */
export function createBatchNameAllocator(existingNames: Iterable<string>): BatchNameAllocator {
  const taken = new Set<string>()
  for (const n of existingNames) taken.add(String(n).trim().toLowerCase())
  return {
    isTaken: (name) => taken.has(name.trim().toLowerCase()),
    allocate(base) {
      let name = base
      let n = 2
      while (taken.has(name.toLowerCase())) name = `${base}-${n++}`
      taken.add(name.toLowerCase())
      return name
    },
  }
}

/** One-shot: format the name and de-collide it against `existingNames`. */
export function suggestBatchName(parts: BatchNameParts, existingNames: Iterable<string>): string {
  return createBatchNameAllocator(existingNames).allocate(formatBatchName(parts))
}
