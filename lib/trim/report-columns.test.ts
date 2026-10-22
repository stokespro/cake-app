import { describe, expect, it } from 'vitest'
import {
  REPORT_COLUMNS,
  REPORT_COLUMNS_STORE_KEY,
  defaultHiddenColumns,
  parseStoredColumns,
  readStoredColumns,
  resolveVisibleColumns,
  selectableColumns,
  serializeColumns,
  toggleColumn,
  writeStoredColumns,
} from './report-columns'

/** A Storage stand-in. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

describe('defaults', () => {
  it('shows Hanger, Batch, Trimmer, Out -> in, Issued, Flower, Variance, Status, Pay; hides Trim and Stems', () => {
    expect(resolveVisibleColumns(defaultHiddenColumns(), true)).toEqual([
      'hanger', 'batch', 'trimmer', 'outIn', 'issued', 'flower', 'variance', 'status', 'pay',
    ])
    expect(defaultHiddenColumns()).toEqual(['trim', 'stems'])
  })

  it('Hanger is the only column that cannot be hidden', () => {
    expect(REPORT_COLUMNS.filter((c) => !c.hideable).map((c) => c.key)).toEqual(['hanger'])
  })

  it('turning Trim and Stems on keeps them in table order, between Flower and Variance', () => {
    const visible = resolveVisibleColumns([], true)
    expect(visible.slice(5, 9)).toEqual(['flower', 'trim', 'stems', 'variance'])
  })
})

describe('toggleColumn', () => {
  it('turns a hidden column on and a shown column off', () => {
    expect(toggleColumn(['trim', 'stems'], 'trim')).toEqual(['stems'])
    expect(toggleColumn(['trim', 'stems'], 'flower')).toEqual(['flower', 'trim', 'stems']) // canonical table order
  })

  it('cannot hide Hanger', () => {
    expect(toggleColumn(['trim'], 'hanger')).toEqual(['trim'])
    expect(resolveVisibleColumns(['hanger' as never], true)).toContain('hanger')
  })
})

describe('parseStoredColumns: bad stored values never throw and fall back to the default', () => {
  const dflt = defaultHiddenColumns()
  it.each([
    ['null', null],
    ['empty string', ''],
    ['not JSON', '{not json'],
    ['a bare string', '"trim"'],
    ['a number', '42'],
    ['null literal', 'null'],
    ['an array', '["trim"]'],
    ['hidden is not an array', '{"hidden":"trim"}'],
    ['hidden missing', '{"v":1}'],
  ])('%s', (_label, raw) => {
    expect(parseStoredColumns(raw)).toEqual(dflt)
  })

  it('drops unknown keys, non-strings and Hanger from an otherwise good value', () => {
    expect(parseStoredColumns('{"hidden":["batch","nonsense",7,null,"hanger","status"]}')).toEqual(['batch', 'status'])
  })

  it('an explicit empty list means "show everything", not "use the default"', () => {
    expect(parseStoredColumns('{"hidden":[]}')).toEqual([])
  })

  it('round-trips what it writes', () => {
    expect(parseStoredColumns(serializeColumns(['stems', 'batch']))).toEqual(['batch', 'stems'])
  })
})

describe('persistence', () => {
  it('stores a changed choice under the module-style key and reads it back', () => {
    const s = memoryStorage()
    writeStoredColumns(['stems'], s)
    expect(REPORT_COLUMNS_STORE_KEY).toBe('harvest-trim-report-columns')
    expect(s.data.has(REPORT_COLUMNS_STORE_KEY)).toBe(true)
    expect(readStoredColumns(s)).toEqual(['stems'])
  })

  it('writing the default forgets the key (reset to default leaves nothing behind)', () => {
    const s = memoryStorage({ [REPORT_COLUMNS_STORE_KEY]: serializeColumns([]) })
    writeStoredColumns(defaultHiddenColumns(), s)
    expect(s.data.has(REPORT_COLUMNS_STORE_KEY)).toBe(false)
    expect(readStoredColumns(s)).toEqual(defaultHiddenColumns())
  })

  it('a malformed stored value reads as the default instead of throwing', () => {
    expect(readStoredColumns(memoryStorage({ [REPORT_COLUMNS_STORE_KEY]: '}{' }))).toEqual(defaultHiddenColumns())
  })

  it('storage that throws (private mode, denied) reads as the default and does not break writing', () => {
    const angry = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(readStoredColumns(angry)).toEqual(defaultHiddenColumns())
    expect(() => writeStoredColumns(['batch'], angry)).not.toThrow()
  })

  it('no storage at all (server render) is the default', () => {
    expect(readStoredColumns(null)).toEqual(defaultHiddenColumns())
    expect(() => writeStoredColumns(['batch'], null)).not.toThrow()
  })
})

describe('pay gating: a viewer without pay access never gets a Pay column, whatever is stored', () => {
  it('Pay is not visible and not in the selector for grow (moneyVisible = false)', () => {
    const visible = resolveVisibleColumns(defaultHiddenColumns(), false)
    expect(visible).not.toContain('pay')
    expect(selectableColumns(false).map((c) => c.key)).not.toContain('pay')
    expect(selectableColumns(false).map((c) => c.key)).toEqual([
      'hanger', 'batch', 'trimmer', 'outIn', 'issued', 'flower', 'trim', 'stems', 'variance', 'status',
    ])
  })

  it('an admin session left "show everything, Pay on" in storage does not surface Pay for grow on the same device', () => {
    const shared = memoryStorage({ [REPORT_COLUMNS_STORE_KEY]: serializeColumns([]) })
    const stored = readStoredColumns(shared)
    expect(resolveVisibleColumns(stored, true)).toContain('pay') // the admin sees it
    expect(resolveVisibleColumns(stored, false)).not.toContain('pay') // grow does not
    expect(selectableColumns(false).some((c) => c.key === 'pay')).toBe(false)
  })

  it('a stored choice naming Pay explicitly changes nothing for grow either way', () => {
    for (const raw of ['{"hidden":["pay"]}', '{"hidden":[]}', '{"hidden":["trim","stems"]}']) {
      expect(resolveVisibleColumns(parseStoredColumns(raw), false)).not.toContain('pay')
    }
  })

  it('an admin can offer, hide and show Pay', () => {
    expect(selectableColumns(true).map((c) => c.key)).toContain('pay')
    expect(resolveVisibleColumns(['pay'], true)).not.toContain('pay')
  })
})
