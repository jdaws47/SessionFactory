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
