import { describe, expect, it } from 'vitest';
import { NET } from '../web/belts';
import { Scene } from '../web/scene';
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
    return { worst, worstPair, stuck, overlapFrames };
  }

  for (const seed of [7, 42, 1234]) {
    it(`chaotic floor (seed ${seed}): a change every second never gridlocks`, () => {
      expect(overlapTest(seed).stuck).toEqual([]);
    });

    it(`realistic floor (seed ${seed}): 8 sessions, a change every 4s, crates keep apart`, () => {
      const { worstPair, stuck, overlapFrames } = overlapTest(seed, 8, 240);
      expect(stuck).toEqual([]);
      expect(overlapFrames, worstPair).toBe(0);
    });
  }
});
