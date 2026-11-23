import { ALL_TRACKS, type Track, type Waypoint } from './belts';
import { CRATE_H, CRATE_W, type Point } from './layout';

/**
 * The belts as interlocking cells, like a railway's blocks. Every belt is cut into short cells; two cells conflict
 * when crates standing on them would touch (on any belts, including the same one). A crate only moves into cells it
 * holds, and it takes all the cells up to the next place it can stop without being in anyone's way (a safe cell, or
 * the end of its trip) at once, or none of them. So no crate ever stops where it blocks a crate that blocks it.
 */

/** Cell length along a belt. */
export const CELL = 8;

export interface Cell extends Point {
  track: Track;
  s: number;
}

export const CELLS: Cell[] = [];
const firstCell = new Map<Track, number>();

for (const track of ALL_TRACKS) {
  firstCell.set(track, CELLS.length);
  const n = Math.max(1, Math.round(track.total / CELL));
  for (let i = 0; i <= n - (track.closed ? 1 : 0); i++) {
    const s = (track.total * i) / n;
    CELLS.push({ ...track.at(s), track, s });
  }
}

/** The cell at distance s along a track. */
export function cellAt(track: Track, s: number): number {
  const base = firstCell.get(track)!;
  const n = Math.max(1, Math.round(track.total / CELL));
  let i = Math.round((s / track.total) * n);
  if (track.closed) i = ((i % n) + n) % n;
  else i = Math.max(0, Math.min(n, i));
  return base + i;
}

/** Footprints are trimmed a little, as for crates passing close by: only a real overlap is a conflict. */
const touch = (a: Point, b: Point) => Math.abs(a.x - b.x) < CRATE_W - 6 && Math.abs(a.y - b.y) < CRATE_H - 6;

/** For every cell, the cells it conflicts with (itself included). */
export const CONFLICTS: number[][] = CELLS.map(() => []);
{
  const order = CELLS.map((_, i) => i).sort((a, b) => CELLS[a].x - CELLS[b].x);
  for (let k = 0; k < order.length; k++) {
    const a = order[k];
    for (let m = k; m < order.length && CELLS[order[m]].x - CELLS[a].x < CRATE_W - 6; m++) {
      const b = order[m];
      if (!touch(CELLS[a], CELLS[b])) continue;
      CONFLICTS[a].push(b);
      if (a !== b) CONFLICTS[b].push(a);
    }
  }
}

/** Whether track `a` branches off track `b` (its first point lies on b). */
function branchesOff(a: Track, b: Track): boolean {
  const p = a.pts[0];
  const q = b.at(b.project(p));
  return Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 1;
}

/**
 * A crate can stop on a safe cell without risking a standoff. Touching its own belt is fine (crates behind just
 * queue), and so is touching a belt at a splitter between the two: whatever it holds up there is heading off the
 * same way it came, behind it. Touching a merger or an unrelated belt running too close is not: the crate it holds
 * up may be the one it is waiting for.
 */
export const SAFE: boolean[] = CONFLICTS.map((list, i) => {
  const a = CELLS[i].track;
  const near = (c: Cell, t: Track) => Math.hypot(c.x - t.pts[0].x, c.y - t.pts[0].y) < CRATE_W + 12;
  // Only the parent belt past the split: a crate on it there is moving on away from the branch.
  const past = (c: Cell, branch: Track) => {
    const at = c.track.project(branch.pts[0]);
    const d = c.s - at;
    return c.track.closed ? ((d % c.track.total) + c.track.total) % c.track.total < c.track.total / 2 : d >= -CELL;
  };
  return list.every((j) => {
    const b = CELLS[j].track;
    return b === a || (branchesOff(a, b) && near(CELLS[i], a) && past(CELLS[j], a)) || (branchesOff(b, a) && near(CELLS[j], b) && past(CELLS[i], b));
  });
});

/**
 * The cells a route crosses from a crate's position, in order, each with how far along the route it is reached.
 * Stops at a crane hop (the crane carries the crate from there), at the end of the route, and once `enough` says so.
 * The route is the crate's path followed by the path of its next trip, if any.
 */
export function routeCells(from: Point, path: Waypoint[], then: Waypoint[] | undefined, enough: (c: { cell: number; dist: number }) => boolean): { cell: number; dist: number }[] {
  const out: { cell: number; dist: number }[] = [];
  const n = path.length + (then?.length ?? 0);
  const get = (i: number) => (i < path.length ? path[i] : then![i - path.length]);
  let at: Point = from;
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const w = get(i);
    if (w.crane) break;
    const track = w.track ?? (i + 1 < n ? get(i + 1).track : undefined);
    const seg = Math.hypot(w.x - at.x, w.y - at.y);
    if (track) {
      // Each step of a route is a straight piece of one belt, so it ends `seg` further along that belt than it starts.
      const s1 = along(track, w);
      const s0 = s1 - seg;
      const steps = Math.max(1, Math.ceil(seg / CELL));
      for (let k = 0; k <= steps; k++) {
        const cell = cellAt(track, s0 + (seg * k) / steps);
        if (out.length && out[out.length - 1].cell === cell) continue;
        const c = { cell, dist: dist + (seg * k) / steps };
        out.push(c);
        if (enough(c)) return out;
      }
    }
    dist += seg;
    at = w;
  }
  return out;
}

const alongCache = new Map<Track, Map<string, number>>();

/** Distance along a track of a route waypoint (waypoints repeat, so this is cached). */
function along(track: Track, p: Point): number {
  let m = alongCache.get(track);
  if (!m) alongCache.set(track, (m = new Map()));
  const key = `${p.x},${p.y}`;
  let s = m.get(key);
  if (s === undefined) {
    s = track.project(p);
    if (m.size > 20000) m.clear();
    m.set(key, s);
  }
  return s;
}

const nearCache = new Map<string, number | undefined>();

/** The cell under a point standing on a belt, if any. */
export function cellNear(p: Point): number | undefined {
  const key = `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  if (nearCache.has(key)) return nearCache.get(key);
  const found = findCell(p);
  if (nearCache.size > 5000) nearCache.clear();
  nearCache.set(key, found);
  return found;
}

function findCell(p: Point): number | undefined {
  let best: number | undefined;
  let bestD = 2;
  for (let i = 0; i < CELLS.length; i++) {
    const d = Math.abs(CELLS[i].x - p.x) + Math.abs(CELLS[i].y - p.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best !== undefined) return best;
  // Between two cells' centres: the nearest cell on the belt it is on.
  for (const track of ALL_TRACKS) {
    const s = track.project(p);
    const q = track.at(s);
    if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) < 1) return cellAt(track, s);
  }
  return undefined;
}
