// Parse a pasted list or uploaded CSV of hanger tag IDs (R2.13). Writes nothing:
// the importHangers action calls this, shows the preview and per-row rejects,
// and only then does the idempotent ON CONFLICT (code) DO NOTHING insert.
//
// Accepted input:
//   - Joshua's label-tool export: a `hanger_id,label_seq` CSV (header optional);
//   - a bare paste, one ID per line.
// Commas, semicolons and tabs all separate columns, so a paste from a
// spreadsheet works. Extra columns are ignored. A UTF-8 BOM and CRLF line
// endings are tolerated.
//
// Per row: trim, uppercase, validate against the DB's LOOSE shape
// `^[A-Z0-9]+-[0-9]{3,6}$` (NOT the strict H1B- scan format — a second fleet is
// a constant change, so the importer must accept it), derive label_seq from the
// numeric tail when the column is absent, and reject (with a reason) anything
// that can't be inserted. A row's label_seq, when given, must equal its numeric
// tail. Duplicates inside the input are rejected rather than silently merged,
// because hangers.code AND hangers.label_seq are both UNIQUE: one collision
// would fail the whole insert.
//
// Pure: no imports from actions/, no I/O.

import { HANGER_PREFIXES } from './hanger-code'

/** Same shape as the hangers.code CHECK. */
export const IMPORT_CODE_PATTERN = /^[A-Z0-9]+-[0-9]{3,6}$/

/** Far more than any fleet (999 per prefix). Rows past this are not read. */
export const MAX_IMPORT_ROWS = 2000

export type HangerImportRejectReason =
  | 'empty_code'
  | 'looks_like_metrc_tag'
  | 'invalid_format'
  | 'invalid_label_seq'
  | 'label_seq_mismatch'
  | 'duplicate'
  | 'duplicate_label_seq'

export interface HangerImportRow {
  code: string
  labelSeq: number
}

export interface HangerImportReject {
  /** 1-based line number in the pasted/uploaded text. */
  line: number
  raw: string
  reason: HangerImportRejectReason
  message: string
}

export interface HangerImportResult {
  accepted: HangerImportRow[]
  rejected: HangerImportReject[]
  /** Distinct prefixes on accepted rows that the scanner does not recognise yet (not in HANGER_PREFIXES). */
  nonStandardPrefixes: string[]
  /** Non-blank data rows examined (header excluded). accepted + rejected === rowCount. */
  rowCount: number
  headerSkipped: boolean
  /** True if the input had more than MAX_IMPORT_ROWS rows and the rest were not read. */
  truncated: boolean
}

const HEADER_NAMES = new Set(['hangerid', 'hangercode', 'hanger', 'code', 'id', 'tag', 'tagid'])

const METRC_TAG_PATTERN = /^[0-9A-Z]{24}$/

function cleanCell(cell: string): string {
  return cell.trim().replace(/^"(.*)"$/, '$1').trim()
}

// Letters, spaces and underscores only: "CODE-123" is a real row under a fleet
// prefix of CODE-, not a header.
function isHeader(cells: string[]): boolean {
  const first = cells[0].toLowerCase()
  return /^[a-z _]+$/.test(first) && HEADER_NAMES.has(first.replace(/[^a-z]/g, ''))
}

function reject(line: number, raw: string, reason: HangerImportRejectReason, message: string): HangerImportReject {
  return { line, raw, reason, message }
}

export function parseHangerImport(input: string): HangerImportResult {
  const text = String(input ?? '').replace(/^﻿/, '')
  const lines = text.split(/\r\n|\r|\n/)

  const accepted: HangerImportRow[] = []
  const rejected: HangerImportReject[] = []
  const seenCodes = new Set<string>()
  const seqOwner = new Map<number, string>()
  const prefixes = new Set<string>()
  let rowCount = 0
  let headerSkipped = false
  let sawFirst = false
  let truncated = false

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    if (rawLine.trim() === '') continue
    const line = i + 1
    const cells = rawLine.split(/[,;\t]/).map(cleanCell)

    // Only the first non-blank line can be a header.
    if (!sawFirst) {
      sawFirst = true
      if (isHeader(cells)) {
        headerSkipped = true
        continue
      }
    }

    if (rowCount >= MAX_IMPORT_ROWS) {
      truncated = true
      break
    }
    rowCount++

    const raw = rawLine.trim()
    const code = cells[0].toUpperCase()

    if (code === '') {
      rejected.push(reject(line, raw, 'empty_code', 'No hanger ID on this row.'))
      continue
    }
    if (METRC_TAG_PATTERN.test(code)) {
      rejected.push(reject(line, raw, 'looks_like_metrc_tag', `${code} looks like a Metrc package tag, not a hanger tag.`))
      continue
    }
    if (!IMPORT_CODE_PATTERN.test(code)) {
      rejected.push(reject(line, raw, 'invalid_format', `${code} is not a hanger ID. Expected something like H1B-042.`))
      continue
    }

    const dash = code.lastIndexOf('-')
    const tailSeq = Number(code.slice(dash + 1))
    if (tailSeq < 1) {
      rejected.push(reject(line, raw, 'invalid_label_seq', `${code}: the number must be 1 or more.`))
      continue
    }

    let labelSeq = tailSeq
    const seqCell = cells[1] ?? ''
    if (seqCell !== '') {
      if (!/^\d+$/.test(seqCell) || Number(seqCell) < 1) {
        rejected.push(reject(line, raw, 'invalid_label_seq', `${code}: label_seq "${seqCell}" is not a whole number of 1 or more.`))
        continue
      }
      labelSeq = Number(seqCell)
      if (labelSeq !== tailSeq) {
        rejected.push(
          reject(line, raw, 'label_seq_mismatch', `${code}: label_seq ${labelSeq} does not match the number in the ID (${tailSeq}).`)
        )
        continue
      }
    }

    if (seenCodes.has(code)) {
      rejected.push(reject(line, raw, 'duplicate', `${code} appears more than once; the first row is kept.`))
      continue
    }
    const owner = seqOwner.get(labelSeq)
    if (owner !== undefined) {
      rejected.push(
        reject(line, raw, 'duplicate_label_seq', `${code}: number ${labelSeq} is already used by ${owner} in this list.`)
      )
      continue
    }

    seenCodes.add(code)
    seqOwner.set(labelSeq, code)
    prefixes.add(code.slice(0, dash + 1))
    accepted.push({ code, labelSeq })
  }

  const known = HANGER_PREFIXES as readonly string[]
  return {
    accepted,
    rejected,
    nonStandardPrefixes: [...prefixes].filter((p) => !known.includes(p)),
    rowCount,
    headerSkipped,
    truncated,
  }
}
