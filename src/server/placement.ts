import { CAPACITY, type Crate, type Placement, type PlacementArea, type Zone } from '../shared/types';

/**
 * Where crates go: the single source of truth for placement and order. The page only animates crates into these
 * placements; it never picks a spot or an order itself. Pure: (crates with their previous placements, now) → placements.
 */

/**
 * The area a crate in a given state belongs in. Waiting on you keeps it in its assembler (which jams); a session back
 * at "intake" after it has already had turns (e.g. /clear) waits at the dock, since intake only takes new crates.
 */
export function areaOf(c: Pick<Crate, 'zone' | 'turns' | 'archived'>): PlacementArea {
  if (c.archived) return 'warehouse';
  return floorArea(c.zone, c.turns);
}

function floorArea(zone: Zone, turns: number): Exclude<PlacementArea, 'warehouse'> {
  if (zone === 'alert') return 'working';
  if (zone === 'intake' && turns > 0) return 'dock';
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
    byArea.set(area, [...(byArea.get(area) ?? []), c]);
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
    // free spots top-first (last in, first out), then newcomers in the order they arrived.
    const prevIn = (c: Crate) => (c.placement?.area === area && c.placement.slot < cap ? c.placement : undefined);
    const used = new Set<number>();
    const rest: Crate[] = [];
    for (const c of [...list].sort((a, b) => (prevIn(a)?.since ?? Infinity) - (prevIn(b)?.since ?? Infinity))) {
      const prev = prevIn(c);
      if (prev && prev.rank === prev.pileSize - 1 && !used.has(prev.slot)) {
        used.add(prev.slot);
        slotOf.set(c.id, prev.slot);
      } else rest.push(c);
    }
    const piled = rest.filter((c) => prevIn(c)).sort((a, b) => prevIn(a)!.rank - prevIn(b)!.rank);
    const arriving = rest.filter((c) => !prevIn(c)).sort((a, b) => arrivedAt(area, a) - arrivedAt(area, b) || a.id.localeCompare(b.id));
    for (const c of [...piled, ...arriving]) {
      let slot = 0;
      while (slot < cap && used.has(slot)) slot++;
      if (slot >= cap) slot = cap - 1;
      used.add(slot);
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
    spots.set(key, [...(spots.get(key) ?? []), c]);
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
