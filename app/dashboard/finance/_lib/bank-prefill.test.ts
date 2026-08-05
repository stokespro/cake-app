// SPRO-77: coverage for the pure helpers behind "Create Bill from an untracked
// bank expense". These decide whether a prefilled bill is recorded as a check
// (and with which check number) or as a card/ACH payment, so a wrong answer
// here writes the wrong payment method onto a real bill.

import { describe, expect, it } from 'vitest';
import { derivePrefillPayment, looksLikeCheck, parseCheckNumber } from './bank-prefill';

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
