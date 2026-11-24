import { NET } from '../../web/belts';
import { SPOTS } from '../../web/warehouse';
import type { Crate, Placement, PlacementArea, Zone } from '../shared/types';

/** How many spots each area has, read off the floor's own geometry so the server never hands out a spot the page can't draw. */
export const CAPACITY: Record<PlacementArea, number> = {
  intake: NET.intake.slots.length,
  working: NET.working.slots.length,
  dock: NET.dock.slots.length,
  storage: NET.storage.slots.length,
  warehouse: SPOTS.length,
};

/**
 * Where crates go: the single source of truth for placement and order. The page only animates crates into these
 * placements; it never picks a spot or an order itself. Pure: (crates with their previous placements, now) → placements.
 */

/**
 * The area a crate in a given state belongs in. Waiting on you keeps it in its assembler (which jams). Intake only
 * takes new crates (it is fed by the hopper alone): a crate back at "intake" after it has had turns (e.g. /clear),
 * or after it was placed anywhere else, waits at the dock instead.
 */
export function areaOf(c: Pick<Crate, 'zone' | 'turns' | 'archived' | 'placement'>): PlacementArea {
  if (c.archived) return 'warehouse';
  return floorArea(c.zone, c.turns > 0 || (!!c.placement && c.placement.area !== 'intake'));
}

function floorArea(zone: Zone, beenOut: boolean): Exclude<PlacementArea, 'warehouse'> {
  if (zone === 'alert') return 'working';
  if (zone === 'intake' && beenOut) return 'dock';
  return zone;
}

/** Queues hand out spots in order; the other areas keep a crate on its spot while it stays in the area. */
const QUEUES = new Set<PlacementArea>(['intake', 'dock']);

/** Order within a queue, front first: the dock by how long each has waited, intake by when it started. */
function queueKey(area: PlacementArea, c: Crate): number {
  return area === 'dock' ? c.zoneSince : c.startedAt;
}

/** When a crate arrived in a sticky area, for handing out spots in arrival order. */
function arrivedAt(area: PlacementArea, c: Crate): number {
  return area === 'warehouse' ? (c.archivedAt ?? c.zoneSince) : c.zoneSince;
}

export function assignPlacements(crates: Crate[], now: number): Map<string, Placement> {
  const byArea = new Map<PlacementArea, Crate[]>();
  for (const c of crates) {
    const area = areaOf(c);
    const list = byArea.get(area);
    if (list) list.push(c);
    else byArea.set(area, [c]);
  }

  const slotOf = new Map<string, number>();
  for (const [area, list] of byArea) {
    const cap = CAPACITY[area];
    if (QUEUES.has(area)) {
      [...list]
        .sort((a, b) => queueKey(area, a) - queueKey(area, b) || a.id.localeCompare(b.id))
        .forEach((c, i) => slotOf.set(c.id, Math.min(i, cap - 1)));
      continue;
    }
    // Sticky: the crate at the bottom of each spot (or alone on it) keeps it. Crates piled on top of others take
    // empty spots top-first (last in, first out), or stay put; then newcomers in the order they arrived. With every
    // spot taken, newcomers pile up evenly: the lowest pile first, the first spot on a tie (so a full warehouse lays
    // a second layer from spot 0 on, then a third, and so on).
    const prevIn = (c: Crate) => (c.placement?.area === area && c.placement.slot < cap ? c.placement : undefined);
    const height = new Array<number>(cap).fill(0);
    const rest: Crate[] = [];
    for (const c of [...list].sort((a, b) => (prevIn(a)?.since ?? Infinity) - (prevIn(b)?.since ?? Infinity))) {
      const prev = prevIn(c);
      if (prev && prev.rank === prev.pileSize - 1 && !height[prev.slot]) {
        height[prev.slot]++;
        slotOf.set(c.id, prev.slot);
      } else rest.push(c);
    }
    const piled = rest.filter((c) => prevIn(c)).sort((a, b) => prevIn(a)!.rank - prevIn(b)!.rank);
    const arriving = rest.filter((c) => !prevIn(c)).sort((a, b) => arrivedAt(area, a) - arrivedAt(area, b) || a.id.localeCompare(b.id));
    for (const c of [...piled, ...arriving]) {
      // A piled crate moves only to an empty spot; otherwise it stays on its pile.
      const empty = height.indexOf(0);
      const slot = empty >= 0 ? empty : (prevIn(c)?.slot ?? height.indexOf(Math.min(...height)));
      height[slot]++;
      slotOf.set(c.id, slot);
    }
  }

  // Piles: the crate put on a spot last is on top. Staying put keeps a crate's time on the spot.
  const since = new Map<string, number>();
  const spots = new Map<string, Crate[]>();
  for (const c of crates) {
    const area = areaOf(c);
    const slot = slotOf.get(c.id)!;
    const prev = c.placement;
    since.set(c.id, prev && prev.area === area && prev.slot === slot ? prev.since : now);
    const key = `${area}/${slot}`;
    const pile = spots.get(key);
    if (pile) pile.push(c);
    else spots.set(key, [c]);
  }
  const out = new Map<string, Placement>();
  for (const pile of spots.values()) {
    const area = areaOf(pile[0]);
    // Top first: latest on the spot; in a queue's back pile, the one furthest back in the queue.
    const top = (c: Crate) => (QUEUES.has(area) ? queueKey(area, c) : since.get(c.id)!);
    pile.sort((a, b) => top(b) - top(a) || since.get(b.id)! - since.get(a.id)! || b.id.localeCompare(a.id));
    pile.forEach((c, rank) => out.set(c.id, { area, slot: slotOf.get(c.id)!, rank, pileSize: pile.length, since: since.get(c.id)! }));
  }
  return out;
}
