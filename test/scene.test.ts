import { describe, expect, it, vi } from 'vitest';
import { LOOP, NET } from '../web/belts';
import { Scene, type Sprite } from '../web/scene';
import { WAREHOUSE_X } from '../web/warehouse';
import type { CrateView } from '../src/shared/types';

function crate(id: string, zone: CrateView['zone'], zoneSince: number): CrateView {
  return { id, sessionIds: [id], cwd: '/cr', repo: 'cr', label: id, labelSource: 'auto', zone, zoneSince, turns: 2, startedAt: zoneSince, updatedAt: zoneSince, archived: false, archiveCount: 0, reactivationCount: 0 };
}

const sprite = (scene: Scene, id: string) => scene.inspect().sprites.get(id)!;
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
    const internals = scene.inspect();
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
    const internals = scene.inspect();
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

describe('rerouting on the loop', () => {
  it('a crate heading for the dock that ends before passing storage turns off there instead of lapping', () => {
    const scene = new Scene();
    const c = crate('a', 'working', 1);
    scene.setCrates([c], 1000);
    step(scene, 20);
    scene.setCrates([{ ...c, zone: 'dock', zoneSince: 2 }], 2000);
    const ahead = (target: number) => (target - LOOP.project(sprite(scene, 'a')) + LOOP.total) % LOOP.total;
    step(scene, 60, () => sprite(scene, 'a').path[0]?.track === LOOP && ahead(NET.storage.entryLoopS) > 40 && ahead(NET.storage.entryLoopS) < ahead(NET.dock.entryLoopS));
    expect(sprite(scene, 'a').path[0]?.track).toBe(LOOP);
    const toStorage = ahead(NET.storage.entryLoopS);

    scene.setCrates([{ ...c, zone: 'storage', zoneSince: 3 }], 3000);
    const s = sprite(scene, 'a');
    expect(usesDockBelt(s)).toBe(false);
    const pts = [{ x: s.x, y: s.y }, ...route(s)] as { x: number; y: number }[];
    const length = pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
    expect(length).toBeLessThan(toStorage + 400);
  });
});

describe('cranes set crates down where they stay', () => {
  it('a crate lowered onto a pile or into the wagon never moves once it is down', () => {
    const scene = new Scene();
    const internals = scene.inspect();
    const cap = NET.storage.slots.length;
    const full = Array.from({ length: cap }, (_, i) => crate(`s${i}`, 'storage', i));
    const movers = ['A', 'B', 'C'].map((id, i) => crate(id, 'dock', 10 + i));
    scene.setCrates([...full, ...movers], 1000);
    step(scene, 10);
    const drawn = new Map<string, { x: number; y: number; resting: boolean }>();
    let worst = 0;
    const watch = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        scene.update(1 / 60);
        const held = [...Object.values(internals.cranes), internals.gantry].map((c) => c.holding);
        for (const [id, s] of internals.sprites) {
          // Once a crate has been set down (not on a belt, not on a crane, train standing), it must not move at all.
          const resting = !s.path.length && !s.next && !held.includes(id) && !scene.train.moving;
          const at = { ...(s.phase === 'cargo' || s.phase === 'yard' ? { x: s.x, y: s.y } : internals.pileOffset(s)), resting };
          const before = drawn.get(id);
          if (before?.resting && resting) worst = Math.max(worst, Math.hypot(at.x - before.x, at.y - before.y));
          drawn.set(id, at);
        }
      }
    };
    // Three crates pile up in storage one after another, then the top two are archived into the wagon together.
    let now = movers;
    for (const [i, c] of movers.entries()) {
      now = now.map((m) => (m.id === c.id ? { ...m, zone: 'storage' as const, zoneSince: 100 + i } : m));
      scene.setCrates([...full, ...now], 2000 + i);
      watch(40);
    }
    scene.setCrates([...full, ...now.map((m, i) => (i > 0 ? { ...m, archived: true, archivedAt: 3000 + i } : m))], 3000);
    watch(90);
    expect([...internals.sprites.values()].filter((s) => s.phase === 'cargo' || s.phase === 'yard').length).toBe(2);
    expect(worst).toBeLessThan(0.5);
  });
});

describe('layout bookkeeping', () => {
  it('a crate rerouted while riding into the dock and then archived does not keep the layout re-running', () => {
    const scene = new Scene();
    const a = crate('A', 'dock', 1);
    const x = crate('X', 'working', 2);
    scene.setCrates([a, x], 1000);
    step(scene, 5);
    scene.setCrates([a, { ...x, zone: 'dock', zoneSince: 3 }], 2000);
    step(scene, 20, () => sprite(scene, 'X').path[0]?.track === NET.dock.track);
    scene.setCrates([a, { ...x, zone: 'working', zoneSince: 4 }], 3000);
    scene.setCrates([a, { ...x, zone: 'working', zoneSince: 4, archived: true, archivedAt: 5 }], 4000);
    step(scene, 120);
    const relayout = vi.spyOn(scene as never as { relayout(): void }, 'relayout');
    step(scene, 2);
    expect(relayout).not.toHaveBeenCalled();
  });
});

describe('crates leaving mid-job', () => {
  const inside = (scene: Scene) => scene.inspect();

  it('a crate brought back while the freight crane holds it gives up its place in the wagon', () => {
    const scene = new Scene();
    const a = crate('A', 'storage', 1);
    const b = crate('B', 'storage', 2);
    scene.setCrates([a, b], 1000);
    step(scene, 3);
    scene.setCrates([{ ...a, archived: true, archivedAt: 5 }, b], 2000);
    step(scene, 60, () => inside(scene).cranes.freight.holding === 'A');
    expect(inside(scene).cranes.freight.holding).toBe('A');
    scene.setCrates([a, b], 3000);
    step(scene, 60);
    scene.setCrates([a, { ...b, archived: true, archivedAt: 6 }], 4000);
    step(scene, 60, () => inside(scene).sprites.get('B')!.wagonSlot !== undefined);
    expect(inside(scene).sprites.get('B')!.wagonSlot).toBe(0);
  });

  it('a crate dropped from the factory during a gantry job does not strand the train', () => {
    const scene = new Scene();
    const a = { ...crate('A', 'storage', 1), archived: true, archivedAt: 5 };
    const b = crate('B', 'storage', 2);
    scene.setCrates([crate('A', 'storage', 1), b], 1000);
    step(scene, 3);
    scene.setCrates([a, b], 2000);
    step(scene, 120, () => inside(scene).gantryJobs.has('A') && inside(scene).gantry.holding !== 'A');
    expect(inside(scene).gantryJobs.has('A')).toBe(true);
    scene.setCrates([b], 3000);
    scene.setCrates([{ ...b, archived: true, archivedAt: 6 }], 3001);
    step(scene, 300, () => inside(scene).sprites.get('B')!.phase === 'yard');
    expect(inside(scene).sprites.get('B')!.phase).toBe('yard');
  });
});

describe('cranes never deadlock', () => {
  const phaseOf = (scene: Scene, id: string) => scene.inspect().sprites.get(id)!.phase;
  const moving = (scene: Scene, id: string) => {
    const s = sprite(scene, id);
    return s.path.length > 0 || !!s.next;
  };

  it('a crate leaving storage while another arrives: neither gets stuck at the shared transfer point', () => {
    // Timings that used to leave the storage crane hovering over a crate waiting for that same crane.
    for (const delay of [7.25, 8, 9, 9.5]) {
      const scene = new Scene();
      const a = crate('A', 'storage', 1);
      const b = crate('B', 'working', 2);
      scene.setCrates([a, b], 1000);
      step(scene, 3);
      scene.setCrates([a, { ...b, zone: 'storage', zoneSince: 3 }], 2000);
      step(scene, delay);
      scene.setCrates([{ ...a, zone: 'working', zoneSince: 4 }, { ...b, zone: 'storage', zoneSince: 3 }], 3000);
      step(scene, 120);
      expect([moving(scene, 'A'), moving(scene, 'B')], `delay ${delay}`).toEqual([false, false]);
    }
  }, 60_000);

  it('archiving a crate while a recalled one is unloaded at the freight station: both get where they are going', () => {
    for (const [zone, delay] of [['dock', 1], ['dock', 5], ['working', 3], ['working', 7], ['storage', 20.5]] as const) {
      const scene = new Scene();
      const a = crate('A', zone, 1);
      const b = { ...crate('B', 'storage', 2), archived: true, archivedAt: 5 };
      scene.setCrates([a, b], 1000);
      step(scene, 3);
      scene.setCrates([a, { ...b, archived: false }], 2000);
      step(scene, delay);
      scene.setCrates([{ ...a, archived: true, archivedAt: 6 }, { ...b, archived: false }], 3000);
      step(scene, 300);
      expect(phaseOf(scene, 'A'), `${zone} ${delay}`).toBe('yard');
      expect([phaseOf(scene, 'B'), moving(scene, 'B')], `${zone} ${delay}`).toEqual(['floor', false]);
    }
  }, 120_000);
});

describe('piles', () => {
  const internals = (scene: Scene) => scene.inspect();

  it('stack in the order crates are physically placed there, not by session timestamps', () => {
    const scene = new Scene();
    const cap = NET.storage.slots.length;
    const full = Array.from({ length: cap }, (_, i) => crate(`s${i}`, 'storage', i));
    const first = crate('first', 'dock', 1);
    const last = crate('last', 'dock', 1);
    scene.setCrates([...full, first, last], 1000);
    const { sprites } = internals(scene);
    const resting = () => [...sprites.values()].every((s) => s.settled !== undefined);
    // "first" is placed on the pile first, even though its session's timestamp is the newer one.
    scene.setCrates([...full, { ...first, zone: 'storage', zoneSince: 60 }, last], 2000);
    step(scene, 120, resting);
    scene.setCrates([...full, { ...first, zone: 'storage', zoneSince: 60 }, { ...last, zone: 'storage', zoneSince: 10 }], 3000);
    step(scene, 120, resting);
    expect(sprites.get('last')!.pileRank).toBe(0);
    const inFront = () => {
      const order = internals(scene).drawOrder().map(([id]) => id);
      return order.indexOf('last') > order.indexOf('first');
    };
    expect(inFront()).toBe(true);
    // Crates set down by different routes can rest a hair apart; the one placed last still goes in front.
    sprites.get('first')!.y += 0.01;
    expect(inFront()).toBe(true);
  });

  it('are last in, first out: the newest crate is on top, drawn last, and the first to leave the pile', () => {
    const scene = new Scene();
    const cap = NET.storage.slots.length;
    const crates = Array.from({ length: cap + 2 }, (_, i) => crate(`c${i}`, 'storage', 100 + i));
    scene.setCrates(crates, 1000);
    const pile = [`c${cap - 1}`, `c${cap}`, `c${cap + 1}`];
    const { sprites } = internals(scene);
    expect(new Set(pile.map((id) => sprites.get(id)!.at.slot)).size).toBe(1);

    // Drawn bottom to top in arrival order, each one higher than the one under it.
    const order = internals(scene).drawOrder().map(([id]) => id).filter((id) => pile.includes(id));
    expect(order).toEqual(pile);
    const heights = pile.map((id) => internals(scene).pileOffset(sprites.get(id)!).y);
    expect(heights[1]).toBeLessThan(heights[0]);
    expect(heights[2]).toBeLessThan(heights[1]);

    // A spot frees up: the top crate (newest) moves into it, the older ones stay put.
    scene.setCrates(crates.filter((c) => c.id !== 'c0'), 2000);
    expect(sprites.get(`c${cap + 1}`)!.at.slot).toBe(0);
    expect(sprites.get(`c${cap}`)!.at.slot).toBe(cap - 1);
    expect(sprites.get(`c${cap - 1}`)!.at.slot).toBe(cap - 1);
  });
});

describe('freight train and warehouse', () => {
  const st = (scene: Scene, id: string) => (scene.inspect()).sprites.get(id)!;

  it('crates in the wagon stack like a pile: the one loaded last sits on top, in front', () => {
    const scene = new Scene();
    const a = crate('A', 'dock', 100);
    const b = crate('B', 'storage', 100);
    scene.setCrates([a, b], 1000);
    step(scene, 10);
    scene.setCrates([{ ...a, archived: true, archivedAt: 2000 }, { ...b, archived: true, archivedAt: 2001 }], 2000);
    step(scene, 120, () => scene.train.cargo.length === 2);
    const [first, last] = scene.train.cargo;
    expect(st(scene, last).y).toBeLessThan(st(scene, first).y);
    const order = (scene.inspect()).drawOrder().map(([id]) => id);
    expect(order.indexOf(last)).toBeGreaterThan(order.indexOf(first));

    // At the warehouse the gantry unloads from the top: last loaded, first off.
    const stored: string[] = [];
    step(scene, 180, () => {
      for (const id of [first, last]) if (st(scene, id).phase === 'yard' && !stored.includes(id)) stored.push(id);
      return stored.length === 2;
    });
    expect(stored).toEqual([last, first]);
  });

  it('recalled crates come off the wagon at the factory from the top: last loaded, first off', () => {
    const scene = new Scene();
    const a = { ...crate('A', 'storage', 1), archived: true, archivedAt: 5 };
    const b = { ...crate('B', 'storage', 2), archived: true, archivedAt: 6 };
    scene.setCrates([a, b], 1000);
    scene.panTo('warehouse');
    scene.setCrates([{ ...a, archived: false }, { ...b, archived: false }], 2000);
    step(scene, 240, () => scene.train.cargo.length === 2 && scene.train.heading < 0);
    const loaded = [...scene.train.cargo];
    expect(loaded).toHaveLength(2);
    const freight = (scene.inspect()).cranes.freight;
    let firstOff: string | null = null;
    step(scene, 60, () => (firstOff = freight.holding) !== null);
    expect(firstOff).toBe(loaded[1]);
    // ...and the train stays until the other one is off too.
    step(scene, 120, () => !scene.train.cargo.length);
    expect(scene.train.cargo).toEqual([]);
    expect(scene.train.atFactory).toBe(true);
  });

  it('archived crates ride the train to the warehouse and get stacked; bringing one back reverses the trip', () => {
    const scene = new Scene();
    let a = crate('A', 'dock', 100);
    scene.setCrates([a], 1000);
    a = { ...a, archived: true, archivedAt: 2000, zone: 'storage' };
    scene.setCrates([a], 2000);

    step(scene, 120, () => st(scene, 'A').phase === 'yard');
    expect(st(scene, 'A').phase).toBe('yard');
    expect(scene.stackOf('A')).toContain('A');
    expect(st(scene, 'A').x).toBeGreaterThan(1600);

    a = { ...a, archived: false, zone: 'storage' };
    scene.setCrates([a], 3000);
    step(scene, 180, () => {
      const s = st(scene, 'A');
      return s.phase === 'floor' && !s.path.length && !s.next && s.at.zone === 'storage';
    });
    const back = st(scene, 'A');
    expect(back.phase).toBe('floor');
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
    expect(st(scene, 'old').phase).toBe('yard');
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
      // The parked gantry trolley (30px tall) sits above every crate.
      expect(c.y - 28).toBeGreaterThan(STACKS.home.y + 15);
    }
    // ...and short of the rail ends, so the supports show past it.
    expect(STACKS.home.y - 15).toBeGreaterThan(STACKS.rails.top);
    // The train stops clear of the gantry's left rail.
    expect(train.left).toBeGreaterThan(STACKS.rails.left + 10);
  });
});
