import { describe, expect, it } from 'vitest';
import { NET } from '../web/belts';
import { Scene } from '../web/scene';
import { WAREHOUSE_X } from '../web/warehouse';
import type { CrateView } from '../src/shared/types';

function crate(id: string, zone: CrateView['zone'], zoneSince: number): CrateView {
  return { id, sessionIds: [id], cwd: '/cr', repo: 'cr', label: id, labelSource: 'auto', zone, zoneSince, turns: 2, startedAt: zoneSince, updatedAt: zoneSince, archived: false, archiveCount: 0, reactivationCount: 0 };
}

type Sprite = { x: number; y: number; path: { track?: unknown }[]; next?: { path: { track?: unknown }[] } };
const sprite = (scene: Scene, id: string) => (scene as unknown as { sprites: Map<string, Sprite> }).sprites.get(id)!;
const route = (s: Sprite) => [...s.path, ...(s.next?.path ?? [])];
const recycles = (s: Sprite) => route(s).some((p) => p.track === NET.dock.recycle!.track);
const usesDockBelt = (s: Sprite) => route(s).some((p) => p.track === NET.dock.track);

function step(scene: Scene, seconds: number, until?: () => boolean): void {
  for (let t = 0; t < seconds; t += 1 / 60) {
    scene.update(1 / 60);
    if (until?.()) return;
  }
}

describe('dock departures while a crate is still arriving', () => {
  it('a crate resumed before it reaches the dock turns back on the loop, and nobody recycles', () => {
    const scene = new Scene();
    const a = crate('A', 'dock', 100);
    let x = crate('X', 'working', 200);
    scene.setCrates([a, x], 1000);
    x = { ...x, zone: 'dock', zoneSince: 300 };
    scene.setCrates([a, x], 1100);
    step(scene, 0.5);
    expect(usesDockBelt(sprite(scene, 'X'))).toBe(true);

    x = { ...x, zone: 'working', zoneSince: 400 };
    scene.setCrates([a, x], 1200);
    expect(recycles(sprite(scene, 'A'))).toBe(false);
    expect(usesDockBelt(sprite(scene, 'X'))).toBe(false);
  });

  it('a crate already riding into the dock settles first; the ones in front recycle only then', () => {
    const scene = new Scene();
    const a = crate('A', 'dock', 100);
    let x = crate('X', 'working', 200);
    scene.setCrates([a, x], 1000);
    x = { ...x, zone: 'dock', zoneSince: 300 };
    scene.setCrates([a, x], 1100);
    step(scene, 60, () => sprite(scene, 'X').path[0]?.track === NET.dock.track);
    expect(sprite(scene, 'X').path[0]?.track).toBe(NET.dock.track);

    x = { ...x, zone: 'working', zoneSince: 400 };
    scene.setCrates([a, x], 1200);
    expect(recycles(sprite(scene, 'A'))).toBe(false);

    step(scene, 60, () => recycles(sprite(scene, 'A')));
    const settledX = sprite(scene, 'X');
    expect(recycles(sprite(scene, 'A'))).toBe(true);
    expect(route(settledX).some((p) => p.track === NET.dock.track)).toBe(true);
  });
});

describe('no teleporting', () => {
  it('a crate going round the dock recycle loop that is sent elsewhere finishes the loop first', () => {
    const scene = new Scene();
    let crates = [crate('A', 'dock', 100), crate('B', 'dock', 200), crate('C', 'dock', 300)];
    scene.setCrates(crates, 1000);
    crates = crates.map((c) => (c.id === 'B' ? { ...c, zone: 'working', zoneSince: 400 } : c));
    scene.setCrates(crates, 1100);
    step(scene, 60, () => sprite(scene, 'A').path[0]?.track === NET.dock.recycle!.track);
    expect(sprite(scene, 'A').path[0]?.track).toBe(NET.dock.recycle!.track);
    let { x, y } = sprite(scene, 'A');
    crates = crates.map((c) => (c.id === 'A' ? { ...c, zone: 'storage', zoneSince: 500 } : c));
    scene.setCrates(crates, 1200);
    let worst = 0;
    for (let f = 0; f < 60 * 60; f++) {
      scene.update(1 / 60);
      const a = sprite(scene, 'A');
      worst = Math.max(worst, Math.hypot(a.x - x, a.y - y));
      ({ x, y } = a);
    }
    expect(worst).toBeLessThan(6);
  });
});

describe('dock order', () => {
  it('when a middle crate leaves, the queue keeps its order (everyone circulates, nobody overtakes)', () => {
    const scene = new Scene();
    let crates = [crate('A', 'dock', 100), crate('B', 'dock', 200), crate('C', 'dock', 300)];
    scene.setCrates(crates, 1000);
    crates = crates.map((c) => (c.id === 'B' ? { ...c, zone: 'working', zoneSince: 400 } : c));
    scene.setCrates(crates, 1100);
    step(scene, 60);
    const internals = scene as unknown as { dockQueue: string[] };
    expect(internals.dockQueue).toEqual(['A', 'C']);
    expect(sprite(scene, 'A').x).toBeLessThan(sprite(scene, 'C').x);
  });

  it('when the front crate leaves, the rest just move up', () => {
    const scene = new Scene();
    let crates = [crate('A', 'dock', 100), crate('B', 'dock', 200), crate('C', 'dock', 300)];
    scene.setCrates(crates, 1000);
    crates = crates.map((c) => (c.id === 'A' ? { ...c, zone: 'working', zoneSince: 400 } : c));
    scene.setCrates(crates, 1100);
    expect(recycles(sprite(scene, 'B'))).toBe(false);
    expect(recycles(sprite(scene, 'C'))).toBe(false);
  });
});

describe('crates never drive through each other', () => {
  function overlapTest(seed: number, count = 12, every = 70) {
    let r = seed;
    const rnd = () => ((r = (r * 16807) % 2147483647) - 1) / 2147483646;
    const zones: CrateView['zone'][] = ['working', 'dock', 'dock', 'alert', 'storage'];
    const scene = new Scene();
    const ids = Array.from({ length: count }, (_, i) => `c${i}`);
    let crates = ids.map((id, i) => crate(id, zones[i % zones.length], i));
    let clock = 1000;
    scene.setCrates(crates, clock);
    const internals = scene as unknown as { sprites: Map<string, Sprite & { at: { zone: string; slot: number }; pileRank: number }>; cranes: Record<string, { holding: string | null }> };
    let worst = 0;
    let worstPair = '';
    let overlapFrames = 0;
    let worstJump = 0;
    const prev = new Map<string, { x: number; y: number }>();
    // Pairs stacked in the same pile overlap by design until they have first moved apart.
    const piled = new Set<string>();
    for (let f = 0; f < 60 * 90; f++) {
      if (f < 60 * 50 && f % every === 0) {
        const pick = ids[Math.floor(rnd() * ids.length)];
        clock += 1000;
        crates = crates.map((c) => (c.id === pick ? { ...c, zone: zones[Math.floor(rnd() * zones.length)], zoneSince: clock } : c));
        scene.setCrates(crates, clock);
      }
      scene.update(1 / 60);
      // Nothing ever jumps: a frame's move is at most the fastest belt/crane/train speed allows.
      for (const [id, sp] of internals.sprites) {
        const before = prev.get(id);
        if (before) worstJump = Math.max(worstJump, Math.hypot(sp.x - before.x, sp.y - before.y));
        prev.set(id, { x: sp.x, y: sp.y });
      }
      const held = new Set(Object.values(internals.cranes).map((c) => c.holding));
      const list = [...internals.sprites.entries()].filter(([id]) => !held.has(id));
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [ia, a] = list[i];
          const [ib, b] = list[j];
          const settled = (s: Sprite) => !s.path.length && !s.next;
          const key = `${ia}/${ib}`;
          const ox = Math.max(0, 118 - Math.abs(a.x - b.x));
          const oy = Math.max(0, 56 - Math.abs(a.y - b.y));
          const o = (ox * oy) / (118 * 56);
          const sameSpot = a.at.zone === b.at.zone && a.at.slot === b.at.slot;
          if (sameSpot && (settled(a) || settled(b))) piled.add(key);
          if (o === 0) piled.delete(key);
          if (piled.has(key)) continue;
          if (o > 0.1) overlapFrames++;
          if (o > worst) {
            worst = o;
            worstPair = `${ia}/${ib} at frame ${f}`;
          }
        }
      }
    }
    const stuck = [...internals.sprites.entries()].filter(([, s]) => s.path.length || s.next).map(([id]) => id);
    return { worst, worstPair, stuck, overlapFrames, worstJump };
  }

  for (const seed of [7, 42, 1234]) {
    it(`chaotic floor (seed ${seed}): a change every second never gridlocks, and nothing ever jumps`, () => {
      const { stuck, worstJump } = overlapTest(seed);
      expect(stuck).toEqual([]);
      expect(worstJump).toBeLessThan(6);
    });

    it(`realistic floor (seed ${seed}): 8 sessions, a change every 4s, crates keep apart`, () => {
      const { worstPair, stuck, overlapFrames } = overlapTest(seed, 8, 240);
      expect(stuck).toEqual([]);
      expect(overlapFrames, worstPair).toBe(0);
    });
  }
});

describe('freight train and warehouse', () => {
  type Stage = Sprite & { stage?: string; at: { zone: string; slot: number } };
  const st = (scene: Scene, id: string) => (scene as unknown as { sprites: Map<string, Stage> }).sprites.get(id)!;

  it('archived crates ride the train to the warehouse and get stacked; bringing one back reverses the trip', () => {
    const scene = new Scene();
    let a = crate('A', 'dock', 100);
    scene.setCrates([a], 1000);
    a = { ...a, archived: true, archivedAt: 2000, zone: 'storage' };
    scene.setCrates([a], 2000);

    step(scene, 120, () => st(scene, 'A').stage === 'yard');
    expect(st(scene, 'A').stage).toBe('yard');
    expect(scene.stackOf('A')).toContain('A');
    expect(st(scene, 'A').x).toBeGreaterThan(1600);

    a = { ...a, archived: false, zone: 'storage' };
    scene.setCrates([a], 3000);
    step(scene, 180, () => {
      const s = st(scene, 'A');
      return !s.stage && !s.path.length && !s.next && s.at.zone === 'storage';
    });
    const back = st(scene, 'A');
    expect(back.stage).toBeUndefined();
    expect(back.x).toBeLessThan(1600);
    expect(scene.train.atFactory).toBe(true);
  });

  it('an idle train follows you to whichever page you are looking at', () => {
    const scene = new Scene();
    scene.setCrates([], 1000);
    scene.panTo('warehouse');
    step(scene, 30, () => scene.train.atWarehouse);
    expect(scene.train.atWarehouse).toBe(true);
    scene.panTo('factory');
    step(scene, 30, () => scene.train.atFactory);
    expect(scene.train.atFactory).toBe(true);
  });

  it('when the train leaves the warehouse with a recalled crate, the view follows it home', () => {
    const scene = new Scene();
    const followed: string[] = [];
    scene.onFollowTrain = (where) => {
      followed.push(where);
      scene.panTo(where);
    };
    const old = { ...crate('old', 'storage', 1), archived: true, archivedAt: 5 };
    scene.setCrates([old], 1000);
    scene.panTo('warehouse');
    scene.setCrates([{ ...old, archived: false }], 2000);
    step(scene, 120, () => scene.train.heading < 0);
    expect(followed).toEqual([]);
    step(scene, 120, () => followed.length > 0);
    expect(followed).toEqual(['factory']);
    // Only once most of the train has crossed onto the factory page.
    expect(scene.train.x).toBeLessThan(WAREHOUSE_X);
    expect(scene.train.x).toBeGreaterThan(WAREHOUSE_X - 10);
    expect(scene.onWarehouse).toBe(false);
  });

  it('a train leaving the factory is never followed', () => {
    const scene = new Scene();
    const followed: string[] = [];
    scene.onFollowTrain = (where) => followed.push(where);
    const c = crate('done', 'storage', 1);
    scene.setCrates([c], 1000);
    step(scene, 60);
    scene.setCrates([{ ...c, archived: true, archivedAt: 5 }], 2000);
    let left = false;
    step(scene, 120, () => (left ||= scene.train.moving && scene.train.heading > 0) && scene.train.atWarehouse);
    expect(left).toBe(true);
    expect(followed).toEqual([]);
    expect(scene.onWarehouse).toBe(false);
  });

  it('crates archived before the page loaded are already on the stacks', () => {
    const scene = new Scene();
    scene.setCrates([{ ...crate('old', 'storage', 1), archived: true, archivedAt: 5 }], 1000);
    expect(st(scene, 'old').stage).toBe('yard');
    expect(st(scene, 'old').x).toBeGreaterThan(1600);
  });
});

describe('warehouse layout', () => {
  it('keeps every crate spot inside the building, clear of the train at its stop and of the gantry rails', async () => {
    const { STACKS, SPOTS, TRAIN } = await import('../web/warehouse');
    const p = STACKS.platform;
    const train = { left: TRAIN.warehouseX - TRAIN.half, right: TRAIN.warehouseX + TRAIN.half, top: TRAIN.railY - 34, bottom: TRAIN.railY + 42 };
    // The wagon fits a crate between the engines.
    expect(TRAIN.wagonW).toBeGreaterThanOrEqual(118 + 4);
    expect(TRAIN.half * 2 - 80).toBeGreaterThanOrEqual(TRAIN.wagonW);
    expect(SPOTS.length).toBeGreaterThanOrEqual(90);
    for (const c of SPOTS) {
      const clearOfTrain = c.x + 59 < train.left || c.x - 59 > train.right || c.y + 28 < train.top || c.y - 28 > train.bottom;
      expect(clearOfTrain).toBe(true);
      expect(c.x - 59).toBeGreaterThan(STACKS.rails.left + 4);
      expect(c.x + 59).toBeLessThan(STACKS.rails.right - 4);
      expect(c.y + 28).toBeLessThan(p.y + p.h);
    }
    // The train stops clear of the gantry's left rail.
    expect(train.left).toBeGreaterThan(STACKS.rails.left + 10);
  });
});
