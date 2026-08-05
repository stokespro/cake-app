// SPRO-77: coverage for the pure helpers behind "Create Bill from an untracked
// bank expense". These decide whether a prefilled bill is recorded as a check
// (and with which check number) or as a card/ACH payment, so a wrong answer
// here writes the wrong payment method onto a real bill.

import { describe, expect, it } from 'vitest';
import {
  amountsMatch,
  daysBetweenIsoDates,
  derivePrefillPayment,
  duplicateDateWindow,
  excludeReconciledElsewhere,
  DUPLICATE_CANDIDATE_LIMIT,
  DUPLICATE_WINDOW_DAYS,
  looksLikeCheck,
  parseCheckNumber,
  parseIsoDateUtc,
  rankDuplicateCandidates,
} from './bank-prefill';

describe('parseCheckNumber', () => {
  it.each([
    ['CHECK # 237', '237'],
    ['CHECK #237', '237'],
    ['CHECK 237', '237'],
    ['CHECK NO 237', '237'],
    ['CHECK NO. 237', '237'],
    ['CHECK NBR 237', '237'],
    ['CHECK NUMBER 237', '237'],
    ['CK #237', '237'],
    ['CHK 237', '237'],
  ])('parses %s', (description, expected) => {
    expect(parseCheckNumber(description)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(parseCheckNumber('check #237')).toBe('237');
    expect(parseCheckNumber('Check No 237')).toBe('237');
  });

  it('strips leading zeros', () => {
    expect(parseCheckNumber('CHECK #000237')).toBe('237');
  });

  it('keeps at least one digit when the number is all zeros', () => {
    expect(parseCheckNumber('CHECK #0000')).toBe('0');
  });

  it('finds the check number mid-description', () => {
    expect(parseCheckNumber('POSTED CHECK # 1042 REGENT BANK')).toBe('1042');
  });

  it('returns null when there is no number', () => {
    expect(parseCheckNumber('CHECK #')).toBeNull();
    expect(parseCheckNumber('PAPER CHECK')).toBeNull();
  });

  it('returns null for a description with no check reference at all', () => {
    expect(parseCheckNumber('ACH DEBIT OG&E UTIL_PMNT 4471')).toBeNull();
  });

  it('does not treat a debit CHECKCARD description as a check', () => {
    expect(parseCheckNumber('DBT CRD 0913 CHECKCARD 1234 SUNOCO')).toBeNull();
  });

  it('handles null / undefined / empty input', () => {
    expect(parseCheckNumber(null)).toBeNull();
    expect(parseCheckNumber(undefined)).toBeNull();
    expect(parseCheckNumber('')).toBeNull();
  });
});

describe('looksLikeCheck', () => {
  it('is true when a check number parses', () => {
    expect(looksLikeCheck('CHECK # 237')).toBe(true);
    expect(looksLikeCheck('CK #237')).toBe(true);
  });

  it('is true for a check reference whose number is missing', () => {
    expect(looksLikeCheck('CHECK #')).toBe(true);
  });

  it('is false for a card description containing CHECKCARD', () => {
    expect(looksLikeCheck('DBT CRD 0913 CHECKCARD 1234 SUNOCO')).toBe(false);
  });

  it('is false for an ordinary ACH description', () => {
    expect(looksLikeCheck('ACH DEBIT OG&E UTIL_PMNT')).toBe(false);
  });

  it('is false for empty input', () => {
    expect(looksLikeCheck('')).toBe(false);
    expect(looksLikeCheck(null)).toBe(false);
  });
});

describe('derivePrefillPayment', () => {
  it('returns check + parsed number for a check description', () => {
    expect(derivePrefillPayment('CHECK # 0237')).toEqual({
      payment_method: 'check',
      payment_ref: '237',
    });
  });

  it('returns check with a BLANK ref when it looks like a check but the number is unparsable', () => {
    // Deliberate: never silently downgrade a check to ACH. The bill sheet's
    // inline validation then asks the user for the check number.
    expect(derivePrefillPayment('CHECK #')).toEqual({
      payment_method: 'check',
      payment_ref: '',
    });
  });

  it('returns card for a debit-card description', () => {
    expect(derivePrefillPayment('DBT CRD 0913 SUNOCO 1234')).toEqual({
      payment_method: 'card',
      payment_ref: '',
    });
    expect(derivePrefillPayment('DEBIT CARD PURCHASE LOWES')).toEqual({
      payment_method: 'card',
      payment_ref: '',
    });
  });

  it('falls back to ach for everything else', () => {
    expect(derivePrefillPayment('ACH DEBIT OG&E UTIL_PMNT')).toEqual({
      payment_method: 'ach',
      payment_ref: '',
    });
    expect(derivePrefillPayment('WIRE OUT BENEFICIARY')).toEqual({
      payment_method: 'ach',
      payment_ref: '',
    });
    expect(derivePrefillPayment('TRANSFER TO SAVINGS')).toEqual({
      payment_method: 'ach',
      payment_ref: '',
    });
    expect(derivePrefillPayment('')).toEqual({ payment_method: 'ach', payment_ref: '' });
  });

  it('only treats a card description as card when it leads the string, matching the SQL matcher', () => {
    // reconcile_non_check_debits() anchors its card regex with ^.
    expect(derivePrefillPayment('POS DBT CRD 0913 SUNOCO').payment_method).toBe('ach');
  });
});

// -----------------------------------------------------------------------
// Real production regression cases
// -----------------------------------------------------------------------
// Sampled read-only from banksync.regent_bank_to_cake_supabase_banksync and
// verified against derivePrefillPayment() before being locked in here as
// permanent regression coverage. These are the actual false-positive /
// false-negative traps real bank descriptions produce — do not "fix" the
// documented-limitation cases below; they're intentional.
describe('derivePrefillPayment — real production descriptions (banksync sample)', () => {
  it.each([
    ['CHECK # 111', { payment_method: 'check', payment_ref: '111' }],
    ['CHECK # 423', { payment_method: 'check', payment_ref: '423' }],
    ['CHECK # 500', { payment_method: 'check', payment_ref: '500' }],
    ['CHECK # 195', { payment_method: 'check', payment_ref: '195' }],
    // The soft-fail Joshua chose: looks like a check, number didn't parse —
    // still 'check' with a blank ref so the bill sheet's own validation asks
    // for the number, rather than silently downgrading to 'ach'.
    ['CHECK #', { payment_method: 'check', payment_ref: '' }],
    ['DBT CRD 2142 DBH2I1OD WARREN BROKEN ARROW RE BROKEN ARROW OK C#6144', { payment_method: 'card', payment_ref: '' }],
    ['DBT CRD 1016 DBUIRMIA METRC LLC LAKELAND FL C#6144', { payment_method: 'card', payment_ref: '' }],
    ['AEP PUBLIC SERVIBILL PAY 7529030411', { payment_method: 'ach', payment_ref: '' }],
    ['TRANSFER FROM X5514 TO X1752 MANAGEMENT FEE', { payment_method: 'ach', payment_ref: '' }],
    ['Home Depot', { payment_method: 'ach', payment_ref: '' }],
  ] as const)('%s', (description, expected) => {
    expect(derivePrefillPayment(description)).toEqual(expected);
  });

  it('does not treat a check-ORDERING fee as a check payment', () => {
    // "CHK" here means "check stock", not a check payment — the false-
    // positive trap: 'chk' matches our word-boundary check keyword, but is
    // never immediately followed by a number (there's an "ORDER" in between),
    // so it correctly falls through to 'ach'.
    expect(derivePrefillPayment('HARLAND CLARKE CHK ORDER 3114000006')).toEqual({
      payment_method: 'ach',
      payment_ref: '',
    });
  });

  it('does not turn trailing digits in an unrelated fee description into a check ref', () => {
    expect(derivePrefillPayment('NON-SUFFICIENT FUNDS FEE 111')).toEqual({
      payment_method: 'ach',
      payment_ref: '',
    });
    expect(derivePrefillPayment('NON-SUFFICIENT FUNDS FEE')).toEqual({
      payment_method: 'ach',
      payment_ref: '',
    });
  });

  it('does not match "ck" inside "CKG" (word-boundary must close after the k)', () => {
    // 'CKG' embeds 'ck' but the boundary right after 'ck' is word-to-word
    // (K -> G), so \bck\b does not match — this is what stops "CKG" from
    // being read as a check reference.
    expect(derivePrefillPayment('CRB CKG T1B MONTHLY FEE')).toEqual({
      payment_method: 'ach',
      payment_ref: '',
    });
  });

  it('documents a known limitation: a card transaction without the DBT CRD prefix reads as ach', () => {
    // Real POS/merchant-terminal descriptions sometimes omit "DBT CRD"
    // entirely. CARD_RE mirrors reconcile_non_check_debits()'s own ^-anchored
    // classification, so this is a shared, deliberate limitation — not a bug
    // to "fix" here.
    expect(
      derivePrefillPayment('1634 17716086 QT 13 INSIDE 3050 S SH QT 13 INSIDE 3050 TULSA OK C#6144')
    ).toEqual({ payment_method: 'ach', payment_ref: '' });
  });
});

// -----------------------------------------------------------------------
// Duplicate-bill detection (SPRO-77 round 2)
// -----------------------------------------------------------------------
// These decide whether the "a bill for this amount already exists" warning
// fires. A false negative creates a duplicate liability (the bs_id 1083 /
// "PSO - large" $22,815 case), so the date-window edges matter.

describe('parseIsoDateUtc', () => {
  it('parses a YYYY-MM-DD date at UTC midnight', () => {
    expect(parseIsoDateUtc('2026-08-01')?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('rejects anything that is not exactly YYYY-MM-DD', () => {
    // '2026-08' and a full timestamp are both Date-parseable — accepting them
    // would silently shift the comparison basis.
    expect(parseIsoDateUtc('2026-08')).toBeNull();
    expect(parseIsoDateUtc('2026-08-01T12:00:00Z')).toBeNull();
    expect(parseIsoDateUtc('08/01/2026')).toBeNull();
    expect(parseIsoDateUtc('')).toBeNull();
    expect(parseIsoDateUtc(null)).toBeNull();
    expect(parseIsoDateUtc(undefined)).toBeNull();
  });

  it('rejects a well-shaped but impossible date', () => {
    expect(parseIsoDateUtc('2026-13-45')).toBeNull();
  });
});

describe('daysBetweenIsoDates', () => {
  it('is positive when the second date is later', () => {
    expect(daysBetweenIsoDates('2026-07-31', '2026-08-01')).toBe(1);
  });

  it('is negative when the second date is earlier', () => {
    expect(daysBetweenIsoDates('2026-08-01', '2026-07-31')).toBe(-1);
  });

  it('is 0 for the same date', () => {
    expect(daysBetweenIsoDates('2026-08-01', '2026-08-01')).toBe(0);
  });

  it('is unaffected by daylight-saving boundaries (UTC math)', () => {
    // US DST starts 2026-03-08. Local-time date math would return 89 or 91.
    expect(daysBetweenIsoDates('2026-01-01', '2026-04-01')).toBe(90);
  });

  it('returns null when either date is unusable', () => {
    expect(daysBetweenIsoDates('nope', '2026-08-01')).toBeNull();
    expect(daysBetweenIsoDates('2026-08-01', 'nope')).toBeNull();
  });
});

describe('duplicateDateWindow', () => {
  it('spans DUPLICATE_WINDOW_DAYS either side of the transaction date', () => {
    expect(duplicateDateWindow('2026-08-01')).toEqual({
      minDate: '2026-06-17',
      maxDate: '2026-09-15',
    });
    expect(daysBetweenIsoDates('2026-06-17', '2026-08-01')).toBe(DUPLICATE_WINDOW_DAYS);
    expect(daysBetweenIsoDates('2026-08-01', '2026-09-15')).toBe(DUPLICATE_WINDOW_DAYS);
  });

  it('crosses a year boundary correctly', () => {
    expect(duplicateDateWindow('2026-01-05', 10)).toEqual({
      minDate: '2025-12-26',
      maxDate: '2026-01-15',
    });
  });

  it('returns null for an unusable transaction date rather than an Invalid Date window', () => {
    // A window of 'Invalid Date' strings would make every DB comparison fail
    // and silently disable the safeguard — callers must be able to detect it.
    expect(duplicateDateWindow('not-a-date')).toBeNull();
  });
});

describe('amountsMatch', () => {
  it('matches a bank outflow (negative) against a positive bill amount', () => {
    // banksync stores outflows negative; finance_bills.amount is positive.
    expect(amountsMatch(22815, -22815)).toBe(true);
  });

  it('matches within a cent', () => {
    expect(amountsMatch(100.0, -100.01)).toBe(true);
    expect(amountsMatch(100.0, -99.99)).toBe(true);
  });

  it('does not match beyond a cent', () => {
    expect(amountsMatch(100.0, -100.02)).toBe(false);
    expect(amountsMatch(100.0, -1000.0)).toBe(false);
  });
});

describe('rankDuplicateCandidates', () => {
  const c = (id: string, due_date: string) => ({ id, due_date });

  it('orders by absolute distance from the transaction date', () => {
    const ranked = rankDuplicateCandidates(
      [c('far', '2026-09-10'), c('near', '2026-08-02'), c('before', '2026-07-30')],
      '2026-08-01'
    );
    expect(ranked.map((r) => r.id)).toEqual(['near', 'before', 'far']);
  });

  it('treats before and after the transaction date symmetrically, keeping input order on a tie', () => {
    // Both are 5 days out, so neither wins on distance and the stable sort
    // preserves the caller's own ordering.
    expect(
      rankDuplicateCandidates([c('after', '2026-08-06'), c('before', '2026-07-27')], '2026-08-01').map((r) => r.id)
    ).toEqual(['after', 'before']);
    expect(
      rankDuplicateCandidates([c('before', '2026-07-27'), c('after', '2026-08-06')], '2026-08-01').map((r) => r.id)
    ).toEqual(['before', 'after']);
    // A closer date still wins regardless of which side it falls on.
    expect(
      rankDuplicateCandidates([c('after', '2026-08-06'), c('before', '2026-07-31')], '2026-08-01').map((r) => r.id)
    ).toEqual(['before', 'after']);
  });

  it('caps the list at the limit', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      c(`b${i}`, `2026-08-${String((i % 28) + 1).padStart(2, '0')}`)
    );
    expect(rankDuplicateCandidates(many, '2026-08-01')).toHaveLength(DUPLICATE_CANDIDATE_LIMIT);
    expect(rankDuplicateCandidates(many, '2026-08-01', 3)).toHaveLength(3);
  });

  it('keeps a candidate with an unusable due date but sorts it last', () => {
    const ranked = rankDuplicateCandidates([c('bad', 'unknown'), c('good', '2026-08-03')], '2026-08-01');
    expect(ranked.map((r) => r.id)).toEqual(['good', 'bad']);
  });

  it('does not mutate the input array', () => {
    const input = [c('far', '2026-09-10'), c('near', '2026-08-02')];
    rankDuplicateCandidates(input, '2026-08-01');
    expect(input.map((r) => r.id)).toEqual(['far', 'near']);
  });

  it('returns an empty list for no candidates', () => {
    expect(rankDuplicateCandidates([], '2026-08-01')).toEqual([]);
  });
});

describe('excludeReconciledElsewhere', () => {
  const b = (id: string) => ({ id });

  it('drops candidates whose id is in the excluded set', () => {
    // The recurring-bill case: June's rent bill is already reconciled to
    // June's debit, so it must never be offered as a "duplicate" of July's
    // untracked debit even though the amount+date window found it.
    const result = excludeReconciledElsewhere([b('june-rent'), b('july-rent')], ['june-rent']);
    expect(result.map((c) => c.id)).toEqual(['july-rent']);
  });

  it('keeps everything when nothing is excluded', () => {
    const result = excludeReconciledElsewhere([b('a'), b('b')], []);
    expect(result.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('drops everything when every candidate is excluded', () => {
    expect(excludeReconciledElsewhere([b('a'), b('b')], ['a', 'b'])).toEqual([]);
  });

  it('is a no-op on an empty candidate list', () => {
    expect(excludeReconciledElsewhere([], ['a'])).toEqual([]);
  });

  it('ignores excluded ids that do not match any candidate', () => {
    const result = excludeReconciledElsewhere([b('a')], ['does-not-exist']);
    expect(result.map((c) => c.id)).toEqual(['a']);
  });

  it('accepts a Set directly, not just an array', () => {
    const result = excludeReconciledElsewhere([b('a'), b('b')], new Set(['a']));
    expect(result.map((c) => c.id)).toEqual(['b']);
  });

  it('does not mutate the input array', () => {
    const input = [b('a'), b('b')];
    excludeReconciledElsewhere(input, ['a']);
    expect(input.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
