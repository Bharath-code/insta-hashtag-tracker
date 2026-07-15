import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../src/services/cursor';

describe('cursor', () => {
  it('round-trips', () => {
    const c = { p: '2026-07-15T10:00:00.000Z', i: '18001234567' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('returns null for garbage input', () => {
    expect(decodeCursor('not-base64!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('returns null for valid base64 of wrong shape', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 1 })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null when p is not a date', () => {
    const bad = Buffer.from(JSON.stringify({ p: 'nope', i: '1' })).toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});
