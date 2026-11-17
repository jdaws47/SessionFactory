import { describe, expect, it } from 'vitest';
import { FEEDERS, LANE_BOTTOM, LANE_TOP, LOOP, route } from '../web/belts';

describe('belt routing', () => {
  it('only ever travels with the belt: right on the top lane, left on the bottom lane', () => {
    const areas = Object.keys(FEEDERS) as (keyof typeof FEEDERS)[];
    for (const from of areas) {
      for (const to of areas) {
        if (from === to) continue;
        const pts = route(from, to, { x: 0, y: 0 });
        for (let i = 1; i < pts.length - 1; i++) {
          const [a, b] = [pts[i - 1], pts[i]];
          if (a.y === LANE_TOP && b.y === LANE_TOP) expect(b.x, `${from}->${to}`).toBeGreaterThanOrEqual(a.x - 1e-6);
          if (a.y === LANE_BOTTOM && b.y === LANE_BOTTOM) expect(b.x, `${from}->${to}`).toBeLessThanOrEqual(a.x + 1e-6);
        }
      }
    }
  });

  it('goes round the right-hand bend to get from the assembly hall to the dock below it', () => {
    const pts = route('working', 'dock', { x: 700, y: 650 });
    expect(Math.max(...pts.map((p) => p.x))).toBeGreaterThan(1530);
  });

  it('is a closed loop', () => {
    const start = LOOP.at(0);
    const end = LOOP.at(LOOP.total - 0.001);
    expect(Math.hypot(start.x - end.x, start.y - end.y)).toBeLessThan(1);
  });
});
