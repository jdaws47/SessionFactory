import type { Area, Point } from './layout';

/** Crates and belt sections move at the same speed so items look carried. */
export const BELT_SPEED = 200;
export const LANE_TOP = 405;
export const LANE_BOTTOM = 475;
const R = 22;

export interface Pose extends Point {
  angle: number;
}

/** A directed polyline with cumulative lengths; items move from pts[0] toward the end. */
export class Track {
  readonly len: number[] = [0];
  readonly total: number;
  /** Distances where independent belt sections meet. Empty = one section. */
  splits: number[] = [];
  /** The section joints drawn as rollers (the dock's accumulation zones); the rest are too fine to draw. */
  joints: number[] = [];

  constructor(
    readonly pts: Point[],
    readonly closed = false,
  ) {
    const all = closed ? [...pts, pts[0]] : pts;
    for (let i = 1; i < all.length; i++) this.len.push(this.len[i - 1] + Math.hypot(all[i].x - all[i - 1].x, all[i].y - all[i - 1].y));
    this.total = this.len[this.len.length - 1];
  }

  private point(i: number): Point {
    return this.pts[i % this.pts.length];
  }

  at(s: number): Pose {
    if (this.closed) s = ((s % this.total) + this.total) % this.total;
    else s = Math.max(0, Math.min(this.total, s));
    let i = 1;
    while (i < this.len.length - 1 && this.len[i] < s) i++;
    const a = this.point(i - 1);
    const b = this.point(i);
    const seg = this.len[i] - this.len[i - 1] || 1;
    const f = (s - this.len[i - 1]) / seg;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  /** Distance along the track of the point on it nearest to p. */
  project(p: Point): number {
    let best = { d: Infinity, s: 0 };
    for (let i = 1; i < this.len.length; i++) {
      const a = this.point(i - 1);
      const b = this.point(i);
      const seg = this.len[i] - this.len[i - 1];
      if (!seg) continue;
      const f = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (seg * seg)));
      const d = Math.hypot(a.x + (b.x - a.x) * f - p.x, a.y + (b.y - a.y) * f - p.y);
      if (d < best.d) best = { d, s: this.len[i - 1] + f * seg };
    }
    return best.s;
  }

  /** Index of the section containing distance s. */
  sectionOf(s: number): number {
    let i = 0;
    while (i < this.splits.length && s >= this.splits[i]) i++;
    return i;
  }

  /** [start, end] distance of every section. */
  sections(): [number, number][] {
    const edges = [0, ...this.splits, this.total];
    return edges.slice(1).map((end, i) => [edges[i], end]);
  }

  /** Points travelled going forward from s0 to s1, wrapping around a closed loop. */
  between(s0: number, s1: number): Point[] {
    if (this.closed && s1 < s0) s1 += this.total;
    const out: Point[] = [this.at(s0)];
    for (let k = 0; k <= 2 * this.len.length; k++) {
      const lap = Math.floor(k / this.len.length);
      const i = k % this.len.length;
      const s = this.len[i] + lap * this.total;
      if (s > s0 && s < s1) out.push(this.point(i));
    }
    out.push(this.at(s1));
    return out;
  }
}

/**
 * Turns an orthogonal polyline into one with squircle (superellipse) corners of radius r.
 * Corner centre C, incoming direction d1, outgoing d2: P(θ) = C − d2·r·√cosθ + d1·r·√sinθ.
 */
export function rounded(points: Point[], r: number, closed = false): Point[] {
  const out: Point[] = [];
  const n = points.length;
  const unit = (a: Point, b: Point) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };
  for (let i = 0; i < n; i++) {
    const v = points[i];
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(v);
      continue;
    }
    const d1 = unit(points[(i - 1 + n) % n], v);
    const d2 = unit(v, points[(i + 1) % n]);
    const c = { x: v.x - d1.x * r + d2.x * r, y: v.y - d1.y * r + d2.y * r };
    const steps = 12;
    for (let k = 0; k <= steps; k++) {
      const th = (k / steps) * (Math.PI / 2);
      const a = Math.sqrt(Math.cos(th));
      const b = Math.sqrt(Math.sin(th));
      out.push({ x: c.x - d2.x * r * a + d1.x * r * b, y: c.y - d2.y * r * a + d1.y * r * b });
    }
  }
  return out;
}

export interface StubSlot {
  kind: 'stub';
  pos: Point;
  in: Track;
  out: Track;
  divergeS: number;
  mergeS: number;
}

export interface TrackSlot {
  kind: 'track';
  pos: Point;
  s: number;
}

/** A spot in a crane yard: the crane lifts crates between the belt and the spot. */
export interface CraneSlot {
  kind: 'crane';
  pos: Point;
  pickup: Point;
  drop: Point;
  pickupS: number;
  dropS: number;
}

export type Slot = StubSlot | TrackSlot | CraneSlot;

export interface ZoneNet {
  /** One-way belt from the loop, through the zone, back to the loop. */
  track: Track;
  /** The dock's exit lane: runs under the queue to the out-leg, which it joins at `mergeS` along the dock belt. */
  exit?: { track: Track; mergeS: number };
  slots: Slot[];
  entryLoopS: number;
  exitLoopS: number;
  /** Where the zone belt branches off the loop and where it rejoins it. */
  junctions: Point[];
}

/** Loop ends sit far enough in that a crate rounding the bend stays on screen (half a crate is 59px). */
export const LOOP_LEFT = 64;
export const LOOP_RIGHT = 1536;

/** The main loop runs clockwise: top lane flows right, bottom lane flows left. */
export const LOOP = new Track(
  rounded(
    [
      { x: LOOP_LEFT, y: LANE_TOP },
      { x: LOOP_RIGHT, y: LANE_TOP },
      { x: LOOP_RIGHT, y: LANE_BOTTOM },
      { x: LOOP_LEFT, y: LANE_BOTTOM },
    ],
    25,
    true,
  ),
  true,
);

/** Zone belt for a zone above the loop: in-leg on the left, out-leg on the right. */
function topZoneTrack(xIn: number, xOut: number, busY: number): Point[] {
  return [
    { x: xIn - R, y: LANE_TOP },
    { x: xIn, y: LANE_TOP },
    { x: xIn, y: busY },
    { x: xOut, y: busY },
    { x: xOut, y: LANE_TOP },
    { x: xOut + R, y: LANE_TOP },
  ];
}

/** Zone belt for a zone below the loop: in-leg on the right, out-leg on the left. */
function bottomZoneTrack(xIn: number, xOut: number, busY: number): Point[] {
  return [
    { x: xIn + R, y: LANE_BOTTOM },
    { x: xIn, y: LANE_BOTTOM },
    { x: xIn, y: busY },
    { x: xOut, y: busY },
    { x: xOut, y: LANE_BOTTOM },
    { x: xOut - R, y: LANE_BOTTOM },
  ];
}

/** Distance from a machine's centre to the belts that enter its left side and leave its right side. */
const SIDE_BELT = 90;

/**
 * An assembler spot: a branch leaves the bus, runs up (or down) beside the machine and enters it from the
 * left; the exit leaves from the right and runs back to the bus. The bus flows right.
 */
function stubSlot(track: Track, busY: number, pos: Point): StubSlot {
  const inX = pos.x - SIDE_BELT;
  const outX = pos.x + SIDE_BELT;
  const diverge = { x: inX - R, y: busY };
  const merge = { x: outX + R, y: busY };
  return {
    kind: 'stub',
    pos,
    in: new Track(rounded([diverge, { x: inX, y: busY }, { x: inX, y: pos.y }, pos], R)),
    out: new Track(rounded([pos, { x: outX, y: pos.y }, { x: outX, y: busY }, merge], R)),
    divergeS: track.project(diverge),
    mergeS: track.project(merge),
  };
}

function zone(points: Point[], makeSlots: (t: Track) => Slot[]): ZoneNet {
  const track = new Track(rounded(points, R));
  return {
    track,
    slots: makeSlots(track),
    entryLoopS: LOOP.project(track.pts[0]),
    exitLoopS: LOOP.project(track.pts[track.pts.length - 1]),
    junctions: [points[1], points[points.length - 2]],
  };
}

/**
 * Intake is a straight belt from the hopper down to the loop. It is only ever fed by the hopper
 * (crates returning to "intake" wait at the dock instead), so it has no entrance from the loop.
 */
function hopperLine(): ZoneNet {
  const corner = { x: HOPPER_DROP.x, y: LANE_TOP };
  const track = new Track(rounded([HOPPER_DROP, corner, { x: HOPPER_DROP.x + R, y: LANE_TOP }], R));
  const exitLoopS = LOOP.project(track.pts[track.pts.length - 1]);
  return {
    track,
    slots: trackSlots(track, [{ x: HOPPER_DROP.x, y: 324 }]),
    entryLoopS: exitLoopS,
    exitLoopS,
    junctions: [corner],
  };
}

function trackSlots(track: Track, positions: Point[]): TrackSlot[] {
  return positions.map((pos) => ({ kind: 'track', pos, s: track.project(pos) }));
}

const TOP_BUS = 220;
const TOP_ROWS = [148, 292];
export const MACHINE_COLUMNS = [450, 675, 900, 1125, 1350];

export const HOPPER_DROP: Point = { x: 145, y: 220 };
/** The front spot stands a crate's width clear of the exit lane climbing to the out-leg beside it. */
export const DOCK_FRONT_X = 229;
export const DOCK_Y = 585;
/** The exit lane runs under the queue at this height. */
export const EXIT_Y = 715;
export const DOCK_IN_X = 881;
export const DOCK_OUT_X = 111;
/** Crate width plus a small gap. */
const DOCK_SPACING = 128;

/**
 * The loading dock's overhead crane lifts a crate leaving from anywhere but the front straight down onto the exit
 * lane, and lifts one that arrived out of turn over the crates in its way. Its rails stand just outside the front
 * spot and the in-leg's corner; it parks below the lane, out of the way.
 */
export const DOCK_CRANE = {
  rails: { left: 150, right: 862, top: 552, bottom: 772 },
  home: { x: 820, y: 762 },
};

/**
 * The loading dock: in-leg down from the loop, a queue running left past the operator, out-leg back up. The queue
 * is an accumulation conveyor (its rollers mark each spot's zone); crates only ever move up it, in the order they
 * arrived. The front crate leaves by riding on out; any other is lifted by the dock crane onto the exit lane under
 * the queue, which climbs into the out-leg.
 */
function dockLine(): ZoneNet {
  const z = zone(bottomZoneTrack(DOCK_IN_X, DOCK_OUT_X, DOCK_Y), (t) => trackSlots(t, [0, 1, 2, 3, 4].map((i) => ({ x: DOCK_FRONT_X + i * DOCK_SPACING, y: DOCK_Y }))));
  const spots = z.slots.map((q) => (q.kind === 'track' ? q.s : 0)).sort((a, b) => a - b);
  z.track.joints = spots.slice(1).map((v, i) => (v + spots[i]) / 2);
  const back = Math.max(...z.slots.map((q) => q.pos.x));
  const merge = { x: DOCK_OUT_X, y: DOCK_Y - R };
  const track = new Track(rounded([{ x: back + 60, y: EXIT_Y }, { x: DOCK_OUT_X, y: EXIT_Y }, merge], R));
  z.exit = { track, mergeS: z.track.project(merge) };
  // Merger where the exit lane climbs into the out-leg.
  z.junctions = [...z.junctions, merge];
  return z;
}

/**
 * Freight station: the belt runs across the upper platform with its stop dead centre; a small magnetic
 * crane lowers crates into the wagon on the tracks below (and lifts them back out).
 */
export const FREIGHT = {
  busY: 582,
  /** Rightmost on the bottom row, so the train can run straight out to the warehouse. */
  inX: 1483,
  outX: 1329,
  transfer: { x: 1406, y: 582 },
  wagon: { x: 1406, y: 676 },
  /** Rails span the whole platform, just outside the belt legs, like the storage crane's. */
  rails: { left: 1294, right: 1518, top: 552, bottom: 726 },
  home: { x: 1406, y: 629 },
};

/** Storage yard: belt along the top, crane field below. */
export const YARD = {
  busY: 582,
  /** The yard belt's legs sit symmetrically about the yard centre (1093). */
  inX: 1193,
  outX: 993,
  /**
   * Two transfer points over the yard's columns: arriving crates stop at the pickup (upstream) to be lifted in;
   * leaving crates are set down at the drop (downstream), so one coming in never stands where one going out lands.
   */
  pickup: { x: 1156, y: 582 },
  drop: { x: 1030, y: 582 },
  columns: [1030, 1156],
  rows: [662, 740, 818],
  /** Rails stand outside the belt's legs, with clear space between them and any crate in the yard. */
  rails: { left: 958, right: 1228, top: 562, bottom: 854 },
  /** Where the crane parks between jobs: between the belt and the first row, under the transfer point. */
  home: { x: 1093, y: 622 },
};

function freightStation(track: Track): CraneSlot[] {
  const s = track.project(FREIGHT.transfer);
  return [{ kind: 'crane', pos: FREIGHT.wagon, pickup: FREIGHT.transfer, drop: FREIGHT.transfer, pickupS: s, dropS: s }];
}

function craneYard(track: Track): CraneSlot[] {
  const pickupS = track.project(YARD.pickup);
  const dropS = track.project(YARD.drop);
  return YARD.rows.flatMap((y) => YARD.columns.map((x) => ({ kind: 'crane' as const, pos: { x, y }, pickup: YARD.pickup, drop: YARD.drop, pickupS, dropS })));
}

export const NET: Record<Area, ZoneNet> = {
  intake: hopperLine(),
  working: zone(topZoneTrack(310, 1485, TOP_BUS), (t) => TOP_ROWS.flatMap((y) => MACHINE_COLUMNS.map((x) => stubSlot(t, TOP_BUS, { x, y })))),
  freight: zone(bottomZoneTrack(FREIGHT.inX, FREIGHT.outX, FREIGHT.busY), freightStation),
  dock: dockLine(),
  storage: zone(bottomZoneTrack(YARD.inX, YARD.outX, YARD.busY), craneYard),
};

export const HOPPER_S = 0;

/** Draw order: slot branches under zone belts, zone belts under the main loop. */
export const ALL_TRACKS: Track[] = [
  ...Object.values(NET).flatMap((z) => z.slots.flatMap((s) => (s.kind === 'stub' ? [s.in, s.out] : []))),
  ...Object.values(NET).flatMap((z) => (z.exit ? [z.exit.track] : [])),
  ...Object.values(NET).map((z) => z.track),
  LOOP,
];

/**
 * Belts are made of short sections, each running only while it carries a moving crate, so a crate is stuck to its
 * spot on the belt: when it stops, the belt under it stops. Sections are shorter than the closest two crates can
 * be (one above the other on a vertical belt), so a crate never shares a section with one standing still.
 */
const SECTION = 20;
for (const track of ALL_TRACKS) {
  const n = Math.max(1, Math.round(track.total / SECTION));
  track.splits = Array.from({ length: n - 1 }, (_, i) => (track.total * (i + 1)) / n);
}

/** Where zone belts split off and merge into the loop (drawn as splitter/merger blocks). */
export const JUNCTIONS: Point[] = Object.values(NET).flatMap((z) => z.junctions);

/** A point on a crate's route, tagged with the belt carrying it there (none for slots and the hopper drop). */
export interface Waypoint extends Point {
  track?: Track;
  /** The crate does not move itself to this point: it waits for this zone's crane to carry it. */
  crane?: Area;
}

function on(track: Track, pts: Point[]): Waypoint[] {
  return pts.map((p) => ({ x: p.x, y: p.y, track }));
}

function leave(zoneName: Area, slot: number): Waypoint[] {
  const z = NET[zoneName];
  const s = z.slots[slot];
  // Behind the front of the dock queue: the dock crane lowers it onto the exit lane below.
  if (z.exit && slot > 0) return [s.pos, ...craneToExit(s.pos.x)];
  if (s.kind === 'stub') return [s.pos, ...on(s.out, s.out.pts), ...on(z.track, z.track.between(s.mergeS, z.track.total))];
  if (s.kind === 'crane') return [s.pos, { ...s.drop, crane: zoneName }, ...on(z.track, z.track.between(s.dropS, z.track.total))];
  return on(z.track, z.track.between(s.s, z.track.total));
}

function arrive(zoneName: Area, slot: number): Waypoint[] {
  const z = NET[zoneName];
  const s = z.slots[slot];
  if (s.kind === 'stub') return [...on(z.track, z.track.between(0, s.divergeS)), ...on(s.in, s.in.pts), s.pos];
  if (s.kind === 'crane') return [...on(z.track, z.track.between(0, s.pickupS)), s.pickup, { ...s.pos, crane: zoneName }];
  return [...on(z.track, z.track.between(0, s.s)), s.pos];
}

/** From the dock crane's hook at `x` down onto the exit lane, and along it into the dock's out-leg. */
function craneToExit(x: number): Waypoint[] {
  const dock = NET.dock;
  const lane = dock.exit!.track;
  const drop = { x, y: EXIT_Y };
  return [{ ...drop, crane: 'dock' }, ...on(lane, lane.between(lane.project(drop), lane.total)), ...on(dock.track, dock.track.between(dock.exit!.mergeS, dock.track.total))];
}

/** Route for a crate standing on the dock belt at `x` (not at the front) that leaves the dock: craned out, on to `to`. */
export function liftOutOfDock(x: number, to: SlotRef): Waypoint[] {
  return [...craneToExit(x), ...on(LOOP, LOOP.between(NET.dock.exitLoopS, NET[to.zone].entryLoopS)), ...arrive(to.zone, to.slot)];
}

export interface SlotRef {
  zone: Area;
  slot: number;
}

/**
 * Belt path between two slots. Moving forward along the same zone belt stays on it; anything else goes
 * round the loop. `lap` forces the trip round the loop even back to the same spot (clearing the way out).
 */
export function travel(from: SlotRef, to: SlotRef, lap = false): Waypoint[] {
  const a = NET[from.zone].slots[from.slot];
  const b = NET[to.zone].slots[to.slot];
  if (from.zone === to.zone && from.slot === to.slot && !lap) return [b.pos];
  if (from.zone === to.zone && a.kind === 'crane' && b.kind === 'crane') return [a.pos, { ...b.pos, crane: to.zone }];
  if (from.zone === to.zone && a.kind === 'track' && b.kind === 'track' && b.s >= a.s && !lap) {
    return [...on(NET[to.zone].track, NET[to.zone].track.between(a.s, b.s)), b.pos];
  }
  return [...leave(from.zone, from.slot), ...on(LOOP, LOOP.between(NET[from.zone].exitLoopS, NET[to.zone].entryLoopS)), ...arrive(to.zone, to.slot)];
}

/** Route that carries on along a zone's belt from distance s, out onto the loop, and on to a slot. */
export function onwardFrom(zoneName: Area, s: number, to: SlotRef): Waypoint[] {
  const z = NET[zoneName];
  return [...on(z.track, z.track.between(s, z.track.total)), ...on(LOOP, LOOP.between(z.exitLoopS, NET[to.zone].entryLoopS)), ...arrive(to.zone, to.slot)];
}

/** Route from a point on the main loop (distance loopS) to a slot: used to turn a crate round before it enters a zone. */
export function fromLoop(loopS: number, to: SlotRef): Waypoint[] {
  return [...on(LOOP, LOOP.between(loopS, NET[to.zone].entryLoopS)), ...arrive(to.zone, to.slot)];
}

/** Path for a brand-new crate dropped from the hopper onto the intake belt. */
export function fromHopper(to: SlotRef): Waypoint[] {
  const intake = NET.intake;
  const b = NET[to.zone].slots[to.slot];
  if (to.zone === 'intake' && b.kind === 'track' && b.s >= HOPPER_S) return [HOPPER_DROP, ...on(intake.track, intake.track.between(HOPPER_S, b.s)), b.pos];
  return [
    HOPPER_DROP,
    ...on(intake.track, intake.track.between(HOPPER_S, intake.track.total)),
    ...on(LOOP, LOOP.between(intake.exitLoopS, NET[to.zone].entryLoopS)),
    ...arrive(to.zone, to.slot),
  ];
}
