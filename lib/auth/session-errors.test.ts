import { describe, expect, it } from 'vitest';
import { isSessionError, NO_SESSION_REASON } from './session-errors';

describe('isSessionError', () => {
  it('recognizes the bare "No valid session" string', () => {
    expect(isSessionError(NO_SESSION_REASON)).toBe(true);
  });

  it('recognizes an Error whose message is "No valid session"', () => {
    expect(isSessionError(new Error(NO_SESSION_REASON))).toBe(true);
  });

  it('recognizes { error: "No valid session" } (the common server action shape)', () => {
    expect(isSessionError({ error: NO_SESSION_REASON })).toBe(true);
  });

  it('recognizes { message: "No valid session" }', () => {
    expect(isSessionError({ message: NO_SESSION_REASON })).toBe(true);
  });

  it('rejects null', () => {
    expect(isSessionError(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isSessionError(undefined)).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSessionError('')).toBe(false);
  });

  it('rejects a different error string', () => {
    expect(isSessionError('Something else went wrong')).toBe(false);
  });

  it('rejects an unrelated authorization error shape', () => {
    expect(isSessionError({ error: "Role 'sales' is not authorized for this action" })).toBe(false);
  });
});
