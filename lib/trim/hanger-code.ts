// Hanger tag codes: canonical form, lenient typed entry, strict scanned entry.
//
// The physical tags (printed by Joshua's standalone label tool, R2.6/R2.13) are
// the source of truth: prefix "H1B-" + a zero-padded 3-digit number, H1B-001 ..
// H1B-999. The format is hard-coded HERE; the DB CHECK stays loose
// (`code ~ '^[A-Z0-9]+-[0-9]{3,6}$'`) so adding a second fleet is a change to
// HANGER_PREFIXES below, not a migration.
//
// Two entry modes, deliberately different:
//   - lenient: a person typing a damaged tag. "42", "h1b42", "H1B-42" and
//     "h1b-042" all mean H1B-042. Whitespace and case are forgiven.
//   - strict:  the keyboard-wedge scanner and the camera. They read exactly what
//     is printed, so anything that isn't exactly `H1B-042` is noise, not a
//     hanger — no trimming, no case folding, no zero-padding.
//
// Both reject the 24-character Metrc package tags sitting on the same bench:
// scanning a flower package by mistake must not be mistaken for a hanger.
//
// Pure: no imports from actions/, no I/O, no DOM.

/** Every fleet prefix currently in service, including the trailing dash. */
export const HANGER_PREFIXES = ['H1B-'] as const

/** Digits after the prefix. 3 caps a fleet at 999 tags. */
export const HANGER_DIGITS = 3
export const MAX_HANGER_SEQ = 10 ** HANGER_DIGITS - 1

export const DEFAULT_HANGER_PREFIX: string = HANGER_PREFIXES[0]

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const PREFIX_ALTERNATION = HANGER_PREFIXES.map(escapeRegex).join('|')

/** Strict canonical form, e.g. H1B-042. Anchored; case-sensitive. */
export const HANGER_CODE_PATTERN = new RegExp(`^(${PREFIX_ALTERNATION})(\\d{${HANGER_DIGITS}})$`)

/** Metrc package tags are 24 alphanumerics (e.g. 1A4FF0100000022000001234). */
const METRC_TAG_PATTERN = /^[0-9A-Za-z]{24}$/

export type HangerCodeError = 'empty' | 'looks_like_metrc_tag' | 'invalid_format' | 'out_of_range'

export type HangerCodeResult =
  | { ok: true; code: string; prefix: string; seq: number }
  | { ok: false; error: HangerCodeError; message: string }

const MESSAGES: Record<HangerCodeError, string> = {
  empty: 'Enter a hanger code.',
  looks_like_metrc_tag: 'That looks like a Metrc package tag, not a hanger tag.',
  invalid_format: 'Not a hanger code. Hanger tags look like H1B-042.',
  out_of_range: `Hanger numbers run 1 to ${MAX_HANGER_SEQ}.`,
}

function fail(error: HangerCodeError): HangerCodeResult {
  return { ok: false, error, message: MESSAGES[error] }
}

/** Canonical code for a sequence number: formatHangerCode(42) -> "H1B-042". Throws RangeError out of 1..999. */
export function formatHangerCode(seq: number, prefix: string = DEFAULT_HANGER_PREFIX): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_HANGER_SEQ) {
    throw new RangeError(`Hanger number must be an integer 1-${MAX_HANGER_SEQ}, got ${seq}`)
  }
  return `${prefix}${String(seq).padStart(HANGER_DIGITS, '0')}`
}

function build(prefix: string, digits: string): HangerCodeResult {
  const seq = Number(digits)
  if (seq < 1 || seq > MAX_HANGER_SEQ) return fail('out_of_range')
  return { ok: true, code: formatHangerCode(seq, prefix), prefix, seq }
}

/**
 * Wedge / camera input: must be exactly a canonical code. No trimming, no case
 * folding — the scan buffer already stripped the terminator and any "~".
 */
export function parseHangerCodeStrict(raw: string): HangerCodeResult {
  const text = String(raw ?? '')
  if (text === '') return fail('empty')
  if (METRC_TAG_PATTERN.test(text)) return fail('looks_like_metrc_tag')
  const m = HANGER_CODE_PATTERN.exec(text)
  if (!m) return fail('invalid_format')
  return build(m[1], m[2])
}

// Lenient forms per prefix, built once: "H1B" then an optional dash then 1-3 digits.
const LENIENT_PATTERNS: Array<{ prefix: string; pattern: RegExp }> = HANGER_PREFIXES.map((prefix) => ({
  prefix,
  pattern: new RegExp(`^${escapeRegex(prefix.replace(/-$/, ''))}-?(\\d{1,${HANGER_DIGITS}})$`),
}))

/**
 * Typed input: trims, uppercases, and accepts a bare number (assumed to be the
 * first fleet's prefix), a missing dash, and missing zero padding.
 */
export function parseHangerCodeLenient(raw: string): HangerCodeResult {
  const text = String(raw ?? '').trim().toUpperCase()
  if (text === '') return fail('empty')
  if (METRC_TAG_PATTERN.test(text)) return fail('looks_like_metrc_tag')

  if (/^\d{1,3}$/.test(text)) return build(DEFAULT_HANGER_PREFIX, text)

  for (const { prefix, pattern } of LENIENT_PATTERNS) {
    const m = pattern.exec(text)
    if (m) return build(prefix, m[1])
  }
  return fail('invalid_format')
}

/** True only for an exact canonical code ("H1B-042"). */
export function isHangerCode(raw: string): boolean {
  return parseHangerCodeStrict(raw).ok
}
