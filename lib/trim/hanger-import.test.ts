import { describe, expect, it } from 'vitest'
import { MAX_IMPORT_ROWS, parseHangerImport } from './hanger-import'

describe('Joshua\'s label-tool CSV (hanger_id,label_seq)', () => {
  it('parses the export shape with its header', () => {
    const csv = 'hanger_id,label_seq\nH1B-001,1\nH1B-002,2\nH1B-300,300\n'
    const r = parseHangerImport(csv)
    expect(r.headerSkipped).toBe(true)
    expect(r.rowCount).toBe(3)
    expect(r.accepted).toEqual([
      { code: 'H1B-001', labelSeq: 1 },
      { code: 'H1B-002', labelSeq: 2 },
      { code: 'H1B-300', labelSeq: 300 },
    ])
    expect(r.rejected).toEqual([])
    expect(r.nonStandardPrefixes).toEqual([])
    expect(r.truncated).toBe(false)
  })

  it('works without a header', () => {
    const r = parseHangerImport('H1B-001,1\nH1B-002,2')
    expect(r.headerSkipped).toBe(false)
    expect(r.accepted).toHaveLength(2)
  })

  it('tolerates CRLF, a BOM, quotes and padding', () => {
    const r = parseHangerImport('﻿"hanger_id","label_seq"\r\n"H1B-001", "1"\r\n  h1b-002 ,2\r\n')
    expect(r.headerSkipped).toBe(true)
    expect(r.accepted).toEqual([
      { code: 'H1B-001', labelSeq: 1 },
      { code: 'H1B-002', labelSeq: 2 },
    ])
  })

  it('accepts tab and semicolon separators (spreadsheet paste)', () => {
    const r = parseHangerImport('H1B-001\t1\nH1B-002;2')
    expect(r.accepted.map((a) => a.code)).toEqual(['H1B-001', 'H1B-002'])
  })

  it('ignores extra columns', () => {
    const r = parseHangerImport('H1B-001,1,front rack,notes')
    expect(r.accepted).toEqual([{ code: 'H1B-001', labelSeq: 1 }])
  })

  it('recognises alternative header names', () => {
    for (const header of ['code,label_seq', 'ID', 'Hanger ID,Label Seq', 'hanger_code']) {
      expect(parseHangerImport(`${header}\nH1B-001`).headerSkipped).toBe(true)
    }
  })

  it('a real ID whose prefix looks like a header word is not skipped', () => {
    const r = parseHangerImport('ID-001\nCODE-002')
    expect(r.headerSkipped).toBe(false)
    expect(r.accepted.map((a) => a.code)).toEqual(['ID-001', 'CODE-002'])
  })

  it('only the first non-blank line can be a header', () => {
    const r = parseHangerImport('H1B-001\nhanger_id,label_seq\nH1B-002')
    expect(r.accepted).toHaveLength(2)
    expect(r.rejected).toEqual([expect.objectContaining({ line: 2, reason: 'invalid_format' })])
  })
})

describe('bare one-per-line paste', () => {
  it('trims, uppercases and derives label_seq from the numeric tail', () => {
    const r = parseHangerImport('  h1b-042  \nH1B-007\n\n   \nh1b-300\n')
    expect(r.accepted).toEqual([
      { code: 'H1B-042', labelSeq: 42 },
      { code: 'H1B-007', labelSeq: 7 },
      { code: 'H1B-300', labelSeq: 300 },
    ])
    expect(r.rowCount).toBe(3)
  })

  it('derives label_seq from the tail for 4-6 digit shapes', () => {
    const r = parseHangerImport('H1B-0042\nH2-100000')
    expect(r.accepted).toEqual([
      { code: 'H1B-0042', labelSeq: 42 },
      { code: 'H2-100000', labelSeq: 100000 },
    ])
  })

  it('empty input accepts and rejects nothing', () => {
    for (const text of ['', '   ', '\n\n', 'hanger_id,label_seq\n']) {
      const r = parseHangerImport(text)
      expect(r.accepted).toEqual([])
      expect(r.rejected).toEqual([])
      expect(r.rowCount).toBe(0)
    }
  })

  it('null/undefined input is empty, not a crash', () => {
    expect(parseHangerImport(undefined as unknown as string).accepted).toEqual([])
  })
})

describe('reject paths (each reports line, raw text and a reason)', () => {
  const one = (text: string) => parseHangerImport(text).rejected

  it('invalid format', () => {
    for (const bad of ['42', 'H1B042', 'H1B-42', 'H1B-1234567', 'H1B-ABC', '-042', 'H1B--042', 'H1B 042', 'hello world']) {
      const r = one(bad)
      expect(r, bad).toHaveLength(1)
      expect(r[0]).toMatchObject({ reason: 'invalid_format', line: 1, raw: bad })
      expect(r[0].message.length).toBeGreaterThan(0)
    }
  })

  it('a 24-char Metrc tag gets its own reason', () => {
    expect(one('1A4FF0100000022000001234')[0]).toMatchObject({ reason: 'looks_like_metrc_tag' })
    expect(one('1a4ff0100000022000001234')[0]).toMatchObject({ reason: 'looks_like_metrc_tag' })
  })

  it('empty code with a label_seq', () => {
    expect(one(',42')[0]).toMatchObject({ reason: 'empty_code' })
  })

  it('zero is not a valid hanger number', () => {
    expect(one('H1B-000')[0]).toMatchObject({ reason: 'invalid_label_seq' })
  })

  it('bad label_seq values', () => {
    for (const seq of ['abc', '-3', '0', '1.5', '4x']) {
      expect(one(`H1B-004,${seq}`)[0], seq).toMatchObject({ reason: 'invalid_label_seq' })
    }
  })

  it('label_seq that disagrees with the ID', () => {
    expect(one('H1B-042,43')[0]).toMatchObject({ reason: 'label_seq_mismatch' })
  })

  it('label_seq that matches only after padding is fine', () => {
    expect(parseHangerImport('H1B-042,042').accepted).toEqual([{ code: 'H1B-042', labelSeq: 42 }])
  })

  it('duplicate code: first kept, later rows rejected with their line number', () => {
    const r = parseHangerImport('H1B-001\nH1B-002\nh1b-001\nH1B-001,1')
    expect(r.accepted.map((a) => a.code)).toEqual(['H1B-001', 'H1B-002'])
    expect(r.rejected).toEqual([
      expect.objectContaining({ line: 3, reason: 'duplicate' }),
      expect.objectContaining({ line: 4, reason: 'duplicate' }),
    ])
  })

  it('same number under two prefixes collides on label_seq', () => {
    const r = parseHangerImport('H1B-042\nH2-042')
    expect(r.accepted.map((a) => a.code)).toEqual(['H1B-042'])
    expect(r.rejected).toEqual([expect.objectContaining({ line: 2, reason: 'duplicate_label_seq' })])
    expect(r.rejected[0].message).toContain('H1B-042')
  })

  it('good rows survive bad ones, and line numbers count blanks and the header', () => {
    const r = parseHangerImport('hanger_id,label_seq\n\nH1B-001,1\nnope\nH1B-003,3\n')
    expect(r.accepted.map((a) => a.code)).toEqual(['H1B-001', 'H1B-003'])
    expect(r.rejected).toEqual([expect.objectContaining({ line: 4, raw: 'nope', reason: 'invalid_format' })])
  })

  it('rowCount is accepted plus rejected', () => {
    const r = parseHangerImport('H1B-001\nbad\nH1B-001\nH1B-002\n')
    expect(r.rowCount).toBe(r.accepted.length + r.rejected.length)
    expect(r.rowCount).toBe(4)
  })
})

describe('prefixes', () => {
  it('flags well-formed codes with a prefix the scanner does not know yet', () => {
    const r = parseHangerImport('H1B-001\nH1A-002\nH1A-003\nX9-004')
    expect(r.accepted).toHaveLength(4)
    expect(r.nonStandardPrefixes.sort()).toEqual(['H1A-', 'X9-'])
  })
  it('no flag for the standard fleet', () => {
    expect(parseHangerImport('H1B-001').nonStandardPrefixes).toEqual([])
  })
})

describe('size', () => {
  it('imports a full 300-tag run', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `H1B-${String(i + 1).padStart(3, '0')},${i + 1}`)
    const r = parseHangerImport(['hanger_id,label_seq', ...lines].join('\n'))
    expect(r.accepted).toHaveLength(300)
    expect(r.rejected).toEqual([])
  })

  it('stops reading past the row limit', () => {
    const lines = Array.from({ length: MAX_IMPORT_ROWS + 50 }, (_, i) => `H1B-${String(i + 1).padStart(4, '0')}`)
    const r = parseHangerImport(lines.join('\n'))
    expect(r.truncated).toBe(true)
    expect(r.rowCount).toBe(MAX_IMPORT_ROWS)
    expect(r.accepted).toHaveLength(MAX_IMPORT_ROWS)
  })

  it('exactly at the limit is not truncated', () => {
    const lines = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => `H1B-${String(i + 1).padStart(4, '0')}`)
    expect(parseHangerImport(lines.join('\n')).truncated).toBe(false)
  })
})
