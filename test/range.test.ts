import { describe, expect, it } from 'vitest';
import { inRange, toKeyRange } from '../src/range';

describe('toKeyRange', () => {
  it('returns undefined for undefined or empty bounds', () => {
    expect(toKeyRange(undefined)).toBeUndefined();
    expect(toKeyRange({})).toBeUndefined();
  });

  it('treats plain values, arrays and dates as equality', () => {
    expect(toKeyRange(5)).toMatchObject({ lower: 5, upper: 5, lowerOpen: false, upperOpen: false });
    expect(toKeyRange(['a', 1])).toMatchObject({ lower: ['a', 1], upper: ['a', 1] });
    const d = new Date(0);
    expect(toKeyRange(d)!.lower).toEqual(d);
  });

  it('builds bounds with correct openness', () => {
    expect(toKeyRange({ gte: 1, lt: 5 })).toMatchObject({ lower: 1, upper: 5, lowerOpen: false, upperOpen: true });
    expect(toKeyRange({ gt: 1, lte: 5 })).toMatchObject({ lower: 1, upper: 5, lowerOpen: true, upperOpen: false });
    const lower = toKeyRange({ gt: 0 })!;
    expect(lower.lower).toBe(0);
    expect(lower.lowerOpen).toBe(true);
    expect(lower.upper).toBeUndefined();
    const upper = toKeyRange({ lte: 'z' })!;
    expect(upper.upper).toBe('z');
    expect(upper.upperOpen).toBe(false);
    expect(upper.lower).toBeUndefined();
  });

  it('treats 0 and empty string as real bounds', () => {
    expect(toKeyRange({ gte: 0 })!.lower).toBe(0);
    expect(toKeyRange({ lte: '' })!.upper).toBe('');
  });
});

describe('inRange', () => {
  it('equality', () => {
    expect(inRange(5, 5)).toBe(true);
    expect(inRange(5, 6)).toBe(false);
    expect(inRange(['a', 1], ['a', 1])).toBe(true);
  });

  it('bounds', () => {
    expect(inRange(18, { gte: 18 })).toBe(true);
    expect(inRange(18, { gt: 18 })).toBe(false);
    expect(inRange(5, { gte: 1, lt: 5 })).toBe(false);
    expect(inRange(4, { gte: 1, lt: 5 })).toBe(true);
    expect(inRange('m', { lte: 'm' })).toBe(true);
    expect(inRange('n', { lte: 'm' })).toBe(false);
    expect(inRange(1, {})).toBe(true);
  });

  it('returns false for invalid keys instead of throwing', () => {
    expect(inRange(undefined as unknown as IDBValidKey, { gte: 1 })).toBe(false);
    expect(inRange([undefined] as unknown as IDBValidKey, ['a'])).toBe(false);
  });
});
