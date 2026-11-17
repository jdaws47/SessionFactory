import { describe, expect, it } from 'vitest';
import { ALL_TRACKS, fromHopper, LANE_BOTTOM, LANE_TOP, LOOP, NET, travel, YARD } from '../web/belts';
import type { Area, Point } from '../web/layout';

const zones = Object.keys(NET) as Area[];
const allSlots = zones.flatMap((zone) => NET[zone].slots.map((_, slot) => ({ zone, slot })));
/** Intake is only ever entered from the hopper. */
const destinations = allSlots.filter((s) => s.zone !== 'intake');

function distanceToBelts(p: Point): number {
  return Math.min(...ALL_TRACKS.map((t) => {
    const q = t.at(t.project(p));
    return Math.hypot(q.x - p.x, q.y - p.y);
  }));
}

describe('belt network', () => {
  it('only ever travels with the loop: right on the top lane, left on the bottom lane', () => {
    for (const from of allSlots) {
      for (const to of destinations) {
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
      for (const to of destinations) {
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

  it('crates enter each assembler from its left side and leave from its right side', () => {
    NET.working.slots.forEach((slot, i) => {
      if (slot.kind !== 'stub') throw new Error('assembler spots are stubs');
      const into = travel({ zone: 'dock', slot: 0 }, { zone: 'working', slot: i });
      const [before, at] = into.slice(-3, -1);
      expect(before.y).toBeCloseTo(slot.pos.y);
      expect(before.x).toBeLessThan(at.x);
      const out = travel({ zone: 'working', slot: i }, { zone: 'dock', slot: 0 });
      const first = out.find((p) => p.x !== slot.pos.x || p.y !== slot.pos.y)!;
      expect(first.y).toBeCloseTo(slot.pos.y);
      expect(first.x).toBeGreaterThan(slot.pos.x);
    });
  });

  it('moves forward along the loading dock without leaving it', () => {
    const pts = travel({ zone: 'dock', slot: 3 }, { zone: 'dock', slot: 0 });
    expect(Math.max(...pts.map((p) => p.y))).toBeLessThanOrEqual(NET.dock.slots[0].pos.y + 0.5);
    expect(pts.every((p) => p.y > LANE_BOTTOM)).toBe(true);
  });

  it('the hopper drops straight onto the intake belt, centred under it', () => {
    const pts = fromHopper({ zone: 'intake', slot: 0 });
    expect(new Set(pts.slice(0, -1).map((p) => Math.round(p.x)))).toEqual(new Set([145]));
  });

  it("tags every leg with its own belt, so passing a zone's merge never counts as riding that zone's belt", () => {
    for (const from of allSlots.filter((s) => s.zone !== 'intake')) {
      for (const to of destinations) expect(travel(from, to).some((p) => p.track === NET.intake.track)).toBe(false);
    }
    const toWork = travel({ zone: 'dock', slot: 0 }, { zone: 'working', slot: 0 });
    expect(toWork.some((p) => p.track === LOOP)).toBe(true);
  });

  it('a crate joining the back of the dock queue never runs the sections the crates in front sit on', () => {
    const dock = NET.dock.track;
    const front = NET.dock.slots[0];
    if (front.kind !== 'track') throw new Error('dock spots are on the belt');
    const pts = travel({ zone: 'working', slot: 0 }, { zone: 'dock', slot: 2 });
    const sections = new Set(pts.filter((p) => p.track === dock).map((p) => dock.sectionOf(dock.project(p))));
    expect(sections.has(dock.sectionOf(front.s))).toBe(false);
    expect(dock.splits.length).toBe(NET.dock.slots.length - 1);
  });

  it('a crate sent further back in the dock queue circulates on the dock recycle loop, not the main loop', () => {
    const pts = travel({ zone: 'dock', slot: 0 }, { zone: 'dock', slot: 3 });
    expect(pts.some((p) => p.track === NET.dock.recycle!.track)).toBe(true);
    expect(pts.some((p) => p.track === LOOP)).toBe(false);
  });

  it('crates going opposite ways on the main loop never overlap', async () => {
    const { CRATE_H } = await import('../web/layout');
    expect(LANE_BOTTOM - LANE_TOP).toBeGreaterThanOrEqual(CRATE_H + 10);
  });

  it('a crate clearing the way circulates even when it comes back to the same spot', () => {
    const pts = travel({ zone: 'dock', slot: 0 }, { zone: 'dock', slot: 0 }, true);
    expect(pts.some((p) => p.track === NET.dock.recycle!.track)).toBe(true);
    expect(pts[pts.length - 1]).toEqual(NET.dock.slots[0].pos);
  });

  it('the loop is closed', () => {
    const start = LOOP.at(0);
    const end = LOOP.at(LOOP.total - 0.001);
    expect(Math.hypot(start.x - end.x, start.y - end.y)).toBeLessThan(1);
  });
});

describe('floor placement', () => {
  it('sends a session back at intake after it has had turns (e.g. /clear) to the dock', async () => {
    const { floorArea } = await import('../web/layout');
    expect(floorArea('intake', 0)).toBe('intake');
    expect(floorArea('intake', 3)).toBe('dock');
    expect(floorArea('alert', 3)).toBe('working');
  });

  it('storage crates are craned between the top belt and the yard', () => {
    const pts = travel({ zone: 'dock', slot: 0 }, { zone: 'storage', slot: 4 });
    const yard = NET.storage.slots[4];
    expect(yard.kind).toBe('crane');
    if (yard.kind === 'crane') {
      const [pickup, spot] = pts.slice(-2);
      expect(pickup).toMatchObject({ ...yard.pickup });
      expect(pickup.crane).toBeUndefined();
      expect(spot).toMatchObject({ ...yard.pos, crane: 'storage' });
    }
    const out = travel({ zone: 'storage', slot: 4 }, { zone: 'dock', slot: 0 });
    expect(out[1]).toMatchObject({ x: YARD.drop.x, y: YARD.drop.y, crane: 'storage' });
  });
});

describe('freight station layout', () => {
  it('centres the belt stop, the wagon and the crane on the platform, with rails clear of the belt legs', async () => {
    const { AREAS } = await import('../web/layout');
    const { FREIGHT } = await import('../web/belts');
    const centre = AREAS.freight.x + AREAS.freight.w / 2;
    expect((FREIGHT.inX + FREIGHT.outX) / 2).toBe(centre);
    expect(FREIGHT.transfer.x).toBe(centre);
    expect(FREIGHT.wagon.x).toBe(centre);
    expect((FREIGHT.rails.left + FREIGHT.rails.right) / 2).toBe(centre);
    expect(FREIGHT.rails.left - 4 - (FREIGHT.outX + 15)).toBeGreaterThanOrEqual(4);
    expect(FREIGHT.inX - 15 - (FREIGHT.rails.right + 4)).toBeGreaterThanOrEqual(4);
  });

  it('archived crates are craned from the belt into the wagon', () => {
    const pts = travel({ zone: 'dock', slot: 0 }, { zone: 'freight', slot: 0 });
    expect(pts[pts.length - 1]).toMatchObject({ crane: 'freight' });
  });
});

describe('storage yard layout', () => {
  it('centres the yard belt on the platform and keeps the crane rails clear of it', async () => {
    const { AREAS } = await import('../web/layout');
    const centre = AREAS.storage.x + AREAS.storage.w / 2;
    expect((YARD.inX + YARD.outX) / 2).toBe(centre);
    const beltHalfWidth = 15;
    const railHalfWidth = 4;
    expect(YARD.outX - beltHalfWidth - (YARD.rails.left + railHalfWidth)).toBeGreaterThanOrEqual(4);
    expect(YARD.rails.right - railHalfWidth - (YARD.inX + beltHalfWidth)).toBeGreaterThanOrEqual(4);
    expect(YARD.pickup.x).toBe(centre);
  });
});
