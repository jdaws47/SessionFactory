import { assignPlacements } from '../src/server/placement';
import type { FactoryEvent } from '../src/server/events';

export const CLEAN_ROOT = '/work/clean-room';

let clock = 1_000_000;

/** Builds a normalized event with sensible defaults and a monotonically increasing timestamp. */
export function ev(partial: Partial<FactoryEvent> & Pick<FactoryEvent, 'kind'>): FactoryEvent {
  clock += 1000;
  return {
    at: clock,
    sessionId: 's1',
    cwd: `${CLEAN_ROOT}/cerebrum`,
    ...partial,
  } as FactoryEvent;
}

const placedBefore = new WeakMap<object, Map<string, import('../src/shared/types').Placement>>();

/**
 * Hands a scene a state snapshot the way the server does: each crate carries its placement from the real
 * assignPlacements(), computed against the placements of the previous snapshot for that scene.
 */
export function serve(scene: { setCrates(crates: import('../src/shared/types').CrateView[], now: number): void }, crates: import('../src/shared/types').CrateView[], now: number): void {
  const before = placedBefore.get(scene) ?? new Map();
  const withPrev = crates.map((c) => ({ ...c, placement: before.get(c.id) }));
  const placed = assignPlacements(withPrev, now);
  placedBefore.set(scene, placed);
  scene.setCrates(withPrev.map((c) => ({ ...c, placement: placed.get(c.id) })), now);
}
