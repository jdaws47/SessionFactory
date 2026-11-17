import { describe, expect, it } from 'vitest';
import { Smoke } from '../web/smoke';

const at = { x: 0, y: 0 };

describe('smoke', () => {
  it('keeps puffing while a source is active', () => {
    const smoke = new Smoke();
    for (let f = 0; f < 120; f++) {
      smoke.source('stack', at, true, 'stack');
      smoke.update(1 / 60);
    }
    expect(smoke.count).toBeGreaterThan(1);
  });

  it('when a source stops, existing puffs linger and fade instead of vanishing, and no new ones appear', () => {
    const smoke = new Smoke();
    for (let f = 0; f < 120; f++) {
      smoke.source('engine', at, true, 'engine');
      smoke.update(1 / 60);
    }
    const before = smoke.count;
    smoke.source('engine', at, false, 'engine');
    smoke.update(1 / 60);
    expect(smoke.count).toBe(before);
    for (let f = 0; f < 60 * 5; f++) {
      smoke.source('engine', at, false, 'engine');
      smoke.update(1 / 60);
    }
    expect(smoke.count).toBe(0);
  });
});
