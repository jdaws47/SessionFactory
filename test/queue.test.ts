import { describe, expect, it } from 'vitest';
import { reorderQueue } from '../web/queue';

describe('loading dock queue order', () => {
  it('new arrivals join the back', () => {
    expect(reorderQueue(['a', 'b'], new Set(['a', 'b', 'c']), ['c'])).toEqual({ queue: ['a', 'b', 'c'], loopers: [] });
  });

  it('when the front crate leaves, the rest just move up', () => {
    expect(reorderQueue(['a', 'b', 'c'], new Set(['b', 'c']), [])).toEqual({ queue: ['b', 'c'], loopers: [] });
  });

  it('when a crate in the middle leaves, the ones in front loop round to the back', () => {
    expect(reorderQueue(['a', 'b', 'x', 'c', 'd'], new Set(['a', 'b', 'c', 'd']), ['e'])).toEqual({
      queue: ['c', 'd', 'a', 'b', 'e'],
      loopers: ['a', 'b'],
    });
  });

  it('with several leaving, everything in front of the last one loops', () => {
    expect(reorderQueue(['a', 'x', 'b', 'y', 'c'], new Set(['a', 'b', 'c']), [])).toEqual({ queue: ['c', 'a', 'b'], loopers: ['a', 'b'] });
  });
});
