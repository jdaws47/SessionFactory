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

  it("the dock belt's rollers sit between its spots, one per gap", () => {
    const spots = NET.dock.slots.map((q) => (q.kind === 'track' ? q.s : NaN)).sort((a, b) => a - b);
    expect(NET.dock.track.joints).toHaveLength(spots.length - 1);
    NET.dock.track.joints.forEach((j, i) => expect(j > spots[i] && j < spots[i + 1]).toBe(true));
  });

  it('a crate sent further back in the dock queue circulates on the dock recycle loop, not the main loop', () => {
    const pts = travel({ zone: 'dock', slot: 0 }, { zone: 'dock', slot: 3 });
    expect(pts.some((p) => p.track === NET.dock.recycle!.track)).toBe(true);
    expect(pts.some((p) => p.track === LOOP)).toBe(false);
  });

  it('the dock recycle merge sits clear of every parked queue spot', async () => {
    const { CRATE_W } = await import('../web/layout');
    const recycle = NET.dock.recycle!;
    const merge = NET.dock.track.at(recycle.mergeS);
    for (const slot of NET.dock.slots) expect(Math.abs(slot.pos.x - merge.x)).toBeGreaterThanOrEqual(CRATE_W);
  });

  it('the dock recycle belt meets the in-leg head-on at its corner, never running alongside it', async () => {
    const { DOCK_IN_X, DOCK_Y } = await import('../web/belts');
    const recycle = NET.dock.recycle!.track;
    const nearInLeg = recycle.pts.filter((p) => Math.abs(p.x - DOCK_IN_X) < 118);
    expect(nearInLeg.every((p) => p.y >= DOCK_Y - 25)).toBe(true);
  });

  it('marks the dock recycle splitter and merger', async () => {
    const { JUNCTIONS, DOCK_IN_X, DOCK_OUT_X, DOCK_Y } = await import('../web/belts');
    expect(JUNCTIONS).toContainEqual({ x: DOCK_IN_X, y: DOCK_Y });
    expect(JUNCTIONS.some((j) => j.y === DOCK_Y && j.x > DOCK_OUT_X && j.x < DOCK_OUT_X + 60)).toBe(true);
  });

  it('the loading dock has at least five spots', () => {
    expect(NET.dock.slots.length).toBeGreaterThanOrEqual(5);
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
  it('storage crates are craned between the top belt and the yard', () => {
    const pts = travel({ zone: 'dock', slot: 0 }, { zone: 'storage', slot: 2 });
    const yard = NET.storage.slots[2];
    expect(yard.kind).toBe('crane');
    if (yard.kind === 'crane') {
      const [pickup, spot] = pts.slice(-2);
      expect(pickup).toMatchObject({ ...yard.pickup });
      expect(pickup.crane).toBeUndefined();
      expect(spot).toMatchObject({ ...yard.pos, crane: 'storage' });
    }
    const out = travel({ zone: 'storage', slot: 2 }, { zone: 'dock', slot: 0 });
    expect(out[1]).toMatchObject({ x: YARD.drop.x, y: YARD.drop.y, crane: 'storage' });
  });
});

describe('platforms', () => {
  it('size themselves around their contents, stay on screen, and keep their headers clear of the loop', async () => {
    const { AREAS, W, H } = await import('../web/layout');
    for (const [name, a] of Object.entries(AREAS)) {
      expect(a.x, name).toBeGreaterThanOrEqual(0);
      expect(a.y, name).toBeGreaterThanOrEqual(0);
      expect(a.x + a.w, name).toBeLessThanOrEqual(W);
      expect(a.y + a.h, name).toBeLessThanOrEqual(H);
      const above = a.y < LANE_TOP;
      if (above) expect(a.y + a.h, name).toBeLessThanOrEqual(LANE_TOP - 15);
      else expect(a.y, name).toBeGreaterThanOrEqual(LANE_BOTTOM + 15);
    }
  });

  it('line up the edges that face the main loop', async () => {
    const { AREAS } = await import('../web/layout');
    const top = [AREAS.intake, AREAS.working].map((a) => Math.round(a.y + a.h));
    const bottom = [AREAS.freight, AREAS.dock, AREAS.storage].map((a) => Math.round(a.y));
    expect(new Set(top).size).toBe(1);
    expect(new Set(bottom).size).toBe(1);
  });

  it('run loading dock, storage, freight from left to right with equal gaps', async () => {
    const { AREAS } = await import('../web/layout');
    const { dock, storage, freight } = AREAS;
    expect(dock.x < storage.x && storage.x < freight.x).toBe(true);
    const a = storage.x - (dock.x + dock.w);
    const b = freight.x - (storage.x + storage.w);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
  });

  it('do not overlap each other', async () => {
    const { AREAS } = await import('../web/layout');
    const list = Object.entries(AREAS);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [na, a] = list[i];
        const [nb, b] = list[j];
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${na} / ${nb}`).toBe(true);
      }
    }
  });

  it('centre the assembly hall on its machines', async () => {
    const { AREAS } = await import('../web/layout');
    const { MACHINE_COLUMNS } = await import('../web/belts');
    const hall = AREAS.working;
    const machinesCentre = (MACHINE_COLUMNS[0] + MACHINE_COLUMNS[MACHINE_COLUMNS.length - 1]) / 2;
    expect(Math.abs(hall.x + hall.w / 2 - machinesCentre)).toBeLessThanOrEqual(5);
  });
});

describe('screen bounds', () => {
  it('keeps every belt, and any crate riding it, on screen', async () => {
    const { W, CRATE_W } = await import('../web/layout');
    for (const t of ALL_TRACKS) {
      for (const p of t.pts) {
        expect(p.x - CRATE_W / 2).toBeGreaterThanOrEqual(0);
        expect(p.x + CRATE_W / 2).toBeLessThanOrEqual(W);
      }
    }
  });
});

describe('freight station layout', () => {
  it('centres the belt stop, the wagon and the crane between the belt legs, with rails clear of them', async () => {
    const { FREIGHT } = await import('../web/belts');
    const centre = (FREIGHT.inX + FREIGHT.outX) / 2;
    expect((FREIGHT.inX + FREIGHT.outX) / 2).toBe(centre);
    expect(FREIGHT.transfer.x).toBe(centre);
    expect(FREIGHT.wagon.x).toBe(centre);
    expect((FREIGHT.rails.left + FREIGHT.rails.right) / 2).toBe(centre);
    for (const rail of [FREIGHT.rails.left, FREIGHT.rails.right]) {
      for (const leg of [FREIGHT.inX, FREIGHT.outX]) expect(Math.abs(rail - leg) - 4 - 15).toBeGreaterThanOrEqual(4);
    }
  });

  it('archived crates are craned from the belt into the wagon', () => {
    const pts = travel({ zone: 'dock', slot: 0 }, { zone: 'freight', slot: 0 });
    expect(pts[pts.length - 1]).toMatchObject({ crane: 'freight' });
  });
});

describe('storage yard layout', () => {
  it('centres the yard on its belt, keeps spots between the rails, the rails clear of the belt legs, and the transfer points a crate apart', async () => {
    const centre = (YARD.inX + YARD.outX) / 2;
    expect((YARD.columns[0] + YARD.columns[YARD.columns.length - 1]) / 2).toBe(centre);
    const { CRATE_W } = await import('../web/layout');
    // Crates (and lifted crates, 8% bigger) stay clear of the rails, which are 8px wide.
    const half = (CRATE_W * 1.08) / 2;
    for (const x of YARD.columns) {
      expect(x - half - (YARD.rails.left + 4)).toBeGreaterThanOrEqual(2);
      expect(YARD.rails.right - 4 - (x + half)).toBeGreaterThanOrEqual(2);
    }
    expect((YARD.rails.left + YARD.rails.right) / 2).toBe(centre);
    const beltHalfWidth = 15;
    const railHalfWidth = 4;
    for (const rail of [YARD.rails.left, YARD.rails.right]) {
      for (const leg of [YARD.inX, YARD.outX]) expect(Math.abs(rail - leg) - railHalfWidth - beltHalfWidth).toBeGreaterThanOrEqual(4);
    }
    // Arriving crates stop upstream, over one column; leaving ones are set down downstream, over the other, a crate
    // apart, so one waiting to come in never stands where one going out is set down.
    expect([YARD.pickup.x, YARD.drop.x]).toEqual([YARD.columns[YARD.columns.length - 1], YARD.columns[0]]);
    expect(YARD.pickup.x - YARD.drop.x).toBeGreaterThanOrEqual(CRATE_W);
  });
});
