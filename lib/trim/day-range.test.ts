import { describe, expect, it } from 'vitest'
import {
  addDays,
  chicagoClockText,
  chicagoDayRangeToUtc,
  chicagoToday,
  daysBetween,
  isValidDay,
} from './day-range'

describe('chicagoDayRangeToUtc', () => {
  it('a summer day runs from 05:00Z (CDT, UTC-5) to 05:00Z the next day', () => {
    expect(chicagoDayRangeToUtc('2026-10-21', '2026-10-21')).toEqual({
      fromIso: '2026-10-21T05:00:00.000Z',
      toExclusiveIso: '2026-10-22T05:00:00.000Z',
    })
    expect(chicagoDayRangeToUtc('2026-07-04', '2026-07-04')).toEqual({
      fromIso: '2026-07-04T05:00:00.000Z',
      toExclusiveIso: '2026-07-05T05:00:00.000Z',
    })
  })

  it('a winter day runs from 06:00Z (CST, UTC-6) to 06:00Z the next day', () => {
    expect(chicagoDayRangeToUtc('2026-01-15', '2026-01-15')).toEqual({
      fromIso: '2026-01-15T06:00:00.000Z',
      toExclusiveIso: '2026-01-16T06:00:00.000Z',
    })
  })

  it('spring forward (2026-03-08) is a 23 hour day: starts CST, ends CDT', () => {
    const r = chicagoDayRangeToUtc('2026-03-08', '2026-03-08')!
    expect(r).toEqual({ fromIso: '2026-03-08T06:00:00.000Z', toExclusiveIso: '2026-03-09T05:00:00.000Z' })
    expect((Date.parse(r.toExclusiveIso) - Date.parse(r.fromIso)) / 3_600_000).toBe(23)
  })

  it('fall back (2026-11-01) is a 25 hour day: starts CDT, ends CST', () => {
    const r = chicagoDayRangeToUtc('2026-11-01', '2026-11-01')!
    expect(r).toEqual({ fromIso: '2026-11-01T05:00:00.000Z', toExclusiveIso: '2026-11-02T06:00:00.000Z' })
    expect((Date.parse(r.toExclusiveIso) - Date.parse(r.fromIso)) / 3_600_000).toBe(25)
  })

  it('a range across the DST change uses each end\'s own offset', () => {
    expect(chicagoDayRangeToUtc('2026-11-01', '2026-11-02')).toEqual({
      fromIso: '2026-11-01T05:00:00.000Z',
      toExclusiveIso: '2026-11-03T06:00:00.000Z',
    })
  })

  it('credits an evening return to its own day, not the next UTC day', () => {
    const { fromIso, toExclusiveIso } = chicagoDayRangeToUtc('2026-10-21', '2026-10-21')!
    const eveningReturn = Date.parse('2026-10-22T00:30:00Z') // 7:30pm CDT on Oct 21
    expect(eveningReturn).toBeGreaterThanOrEqual(Date.parse(fromIso))
    expect(eveningReturn).toBeLessThan(Date.parse(toExclusiveIso))
    const earlyMorning = Date.parse('2026-10-21T04:59:00Z') // 11:59pm CDT on Oct 20
    expect(earlyMorning).toBeLessThan(Date.parse(fromIso))
  })

  it('handles a year boundary', () => {
    expect(chicagoDayRangeToUtc('2026-12-31', '2026-12-31')).toEqual({
      fromIso: '2026-12-31T06:00:00.000Z',
      toExclusiveIso: '2027-01-01T06:00:00.000Z',
    })
  })

  it.each([
    ['malformed', '10/21/2026', '2026-10-21'],
    ['impossible date', '2026-02-30', '2026-03-01'],
    ['month 13', '2026-13-01', '2026-13-02'],
    ['empty', '', ''],
    ['to before from', '2026-10-22', '2026-10-21'],
  ])('returns null for %s', (_label, from, to) => {
    expect(chicagoDayRangeToUtc(from, to)).toBeNull()
  })

  it('returns null for non-string input', () => {
    expect(chicagoDayRangeToUtc(undefined as never, null as never)).toBeNull()
  })
})

describe('calendar helpers', () => {
  it('isValidDay accepts real dates only', () => {
    expect(isValidDay('2026-02-28')).toBe(true)
    expect(isValidDay('2028-02-29')).toBe(true)
    expect(isValidDay('2026-02-29')).toBe(false)
    expect(isValidDay('2026-2-9')).toBe(false)
    expect(isValidDay(20261021)).toBe(false)
  })

  it('addDays and daysBetween are time-zone free', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-10-21', -6)).toBe('2026-10-15')
    expect(daysBetween('2026-11-01', '2026-11-02')).toBe(1)
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2)
  })
})

describe('chicagoToday', () => {
  it('is the Chicago date, which lags UTC in the evening', () => {
    expect(chicagoToday(new Date('2026-10-22T00:30:00Z'))).toBe('2026-10-21')
    expect(chicagoToday(new Date('2026-10-21T12:00:00Z'))).toBe('2026-10-21')
    expect(chicagoToday(new Date('2026-01-15T05:59:00Z'))).toBe('2026-01-14') // 11:59pm CST
    expect(chicagoToday(new Date('2026-01-15T06:00:00Z'))).toBe('2026-01-15')
  })
})

describe('chicagoClockText', () => {
  it('formats in Chicago whatever the host zone is', () => {
    expect(chicagoClockText('2026-10-21T19:05:00Z')).toBe('2:05 PM')
    expect(chicagoClockText('2026-10-22T00:30:00Z', true)).toBe('Oct 21, 7:30 PM')
    expect(chicagoClockText('2026-01-15T18:00:00Z')).toBe('12:00 PM')
  })
  it('dashes on missing or bad input', () => {
    expect(chicagoClockText(null)).toBe('—')
    expect(chicagoClockText('nope')).toBe('—')
  })
})
