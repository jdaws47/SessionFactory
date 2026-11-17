import { describe, expect, it } from 'vitest';
import { ALL_TRACKS, fromHopper, LANE_BOTTOM, LANE_TOP, LOOP, NET, travel } from '../web/belts';
import type { Area, Point } from '../web/layout';

const zones = Object.keys(NET) as Area[];
const allSlots = zones.flatMap((zone) => NET[zone].slots.map((_, slot) => ({ zone, slot })));

function distanceToBelts(p: Point): number {
  return Math.min(...ALL_TRACKS.map((t) => {
    const q = t.at(t.project(p));
    return Math.hypot(q.x - p.x, q.y - p.y);
  }));
}

describe('belt network', () => {
  it('only ever travels with the loop: right on the top lane, left on the bottom lane', () => {
    for (const from of allSlots) {
      for (const to of allSlots) {
        const pts = travel(from, to);
        for (let i = 1; i < pts.length; i++) {
          const [a, b] = [pts[i - 1], pts[i]];
          if (a.y === LANE_TOP && b.y === LANE_TOP) expect(b.x).toBeGreaterThanOrEqual(a.x - 1e-6);
          if (a.y === LANE_BOTTOM && b.y === LANE_BOTTOM) expect(b.x).toBeLessThanOrEqual(a.x + 1e-6);
        }
      }
    }
  });

  it('never leaves the belts: every waypoint is on a belt or is a slot itself', () => {
    const slotPoints = zones.flatMap((z) => NET[z].slots.map((s) => s.pos));
    const isSlot = (p: Point) => slotPoints.some((s) => s.x === p.x && s.y === p.y);
    for (const from of allSlots) {
      for (const to of allSlots) {
        for (const p of travel(from, to)) if (!isSlot(p)) expect(distanceToBelts(p), `${from.zone}->${to.zone}`).toBeLessThan(0.5);
      }
      for (const p of fromHopper(from).slice(1)) if (!isSlot(p)) expect(distanceToBelts(p)).toBeLessThan(0.5);
    }
  }, 60_000);

  it('gives every assembler its own entrance and exit', () => {
    for (const slot of NET.working.slots) {
      expect(slot.kind).toBe('stub');
      if (slot.kind === 'stub') expect(slot.divergeS).toBeLessThan(slot.mergeS);
    }
  });

  it('moves forward along the loading dock without leaving it', () => {
    const pts = travel({ zone: 'dock', slot: 3 }, { zone: 'dock', slot: 0 });
    expect(Math.max(...pts.map((p) => p.y))).toBeLessThanOrEqual(NET.dock.slots[0].pos.y + 0.5);
    expect(pts.every((p) => p.y > LANE_BOTTOM)).toBe(true);
  });

  it('the loop is closed', () => {
    const start = LOOP.at(0);
    const end = LOOP.at(LOOP.total - 0.001);
    expect(Math.hypot(start.x - end.x, start.y - end.y)).toBeLessThan(1);
  });
});
