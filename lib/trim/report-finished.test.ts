import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FINISHED_ONLY,
  FINISHED_ONLY_STORE_KEY,
  parseStoredFinishedOnly,
  readStoredFinishedOnly,
  writeStoredFinishedOnly,
} from './report-finished'

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

describe('default', () => {
  it('is ON: the page is about completed work and pay', () => {
    expect(DEFAULT_FINISHED_ONLY).toBe(true)
  })
})

describe('parseStoredFinishedOnly: a bad stored value never throws and falls back to the default', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['bad JSON', '{nope'],
    ['a bare word', 'yes'],
    ['a number', '1'],
    ['a string', '"false"'],
    ['an object', '{"finishedOnly":false}'],
    ['an array', '[false]'],
    ['null literal', 'null'],
    ['whitespace', '   '],
  ])('%s', (_name, raw) => {
    expect(() => parseStoredFinishedOnly(raw)).not.toThrow()
    expect(parseStoredFinishedOnly(raw)).toBe(DEFAULT_FINISHED_ONLY)
  })

  it('reads a stored boolean', () => {
    expect(parseStoredFinishedOnly('false')).toBe(false)
    expect(parseStoredFinishedOnly('true')).toBe(true)
  })
})

describe('storage', () => {
  it('round-trips OFF, and forgets the choice when it is back at the default', () => {
    const store = memoryStorage()
    writeStoredFinishedOnly(false, store)
    expect(store.data.get(FINISHED_ONLY_STORE_KEY)).toBe('false')
    expect(readStoredFinishedOnly(store)).toBe(false)
    writeStoredFinishedOnly(true, store)
    expect(store.data.has(FINISHED_ONLY_STORE_KEY)).toBe(false)
    expect(readStoredFinishedOnly(store)).toBe(true)
  })

  it('a garbage stored value reads as the default', () => {
    expect(readStoredFinishedOnly(memoryStorage({ [FINISHED_ONLY_STORE_KEY]: '<<garbage>>' }))).toBe(true)
  })

  it('no storage (SSR, or storage denied): the default, and writing is a no-op that does not throw', () => {
    expect(readStoredFinishedOnly(null)).toBe(DEFAULT_FINISHED_ONLY)
    expect(() => writeStoredFinishedOnly(false, null)).not.toThrow()
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(readStoredFinishedOnly(throwing)).toBe(DEFAULT_FINISHED_ONLY)
    expect(() => writeStoredFinishedOnly(false, throwing)).not.toThrow()
  })

  it('has its own key: it never collides with the column preference', async () => {
    const { REPORT_COLUMNS_STORE_KEY } = await import('./report-columns')
    expect(FINISHED_ONLY_STORE_KEY).not.toBe(REPORT_COLUMNS_STORE_KEY)
  })

  it('holds no pay data, so a shared device leaks nothing: only a boolean is ever stored', () => {
    const store = memoryStorage()
    writeStoredFinishedOnly(false, store)
    expect([...store.data.values()]).toEqual(['false'])
  })
})
