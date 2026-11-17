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
  /** Distances where independent belt sections meet (accumulation joints). Empty = one section. */
  splits: number[] = [];

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
  /** The dock's recycle loop: splits off just past the front, runs back underneath, merges in at the back. */
  recycle?: { track: Track; divergeS: number; mergeS: number };
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
    slots: trackSlots(track, [{ x: HOPPER_DROP.x, y: 300 }]),
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

export const HOPPER_DROP: Point = { x: 145, y: 196 };
export const DOCK_FRONT_X = 460;
export const DOCK_Y = 630;
export const RECYCLE_Y = 760;
export const DOCK_IN_X = 1120;
export const DOCK_OUT_X = 350;
/** Crate width plus a small gap. */
const DOCK_SPACING = 128;

/**
 * The loading dock: in-leg down from the loop, a queue running left past the operator, out-leg back up.
 * A recycle loop splits off just past the front, runs back under the queue and merges in at the back, so
 * crates that must clear the way for a departure circulate inside the dock instead of lapping the main loop.
 * The queue is an accumulation conveyor (one section per spot).
 */
function dockLine(): ZoneNet {
  const z = zone(bottomZoneTrack(DOCK_IN_X, DOCK_OUT_X, DOCK_Y), (t) => trackSlots(t, [0, 1, 2, 3].map((i) => ({ x: DOCK_FRONT_X + i * DOCK_SPACING, y: DOCK_Y }))));
  const spots = z.slots.map((q) => (q.kind === 'track' ? q.s : 0)).sort((a, b) => a - b);
  z.track.splits = spots.slice(1).map((v, i) => (v + spots[i]) / 2);
  const downX = DOCK_OUT_X + 28;
  // The recycle belt climbs back up a full crate-width (plus a gap) away from the in-leg, so crates on the two
  // side-by-side belts never overlap.
  const upX = DOCK_IN_X - 124;
  const diverge = { x: downX + R, y: DOCK_Y };
  const merge = { x: upX - R, y: DOCK_Y };
  const track = new Track(rounded([diverge, { x: downX, y: DOCK_Y }, { x: downX, y: RECYCLE_Y }, { x: upX, y: RECYCLE_Y }, { x: upX, y: DOCK_Y }, merge], R));
  z.recycle = { track, divergeS: z.track.project(diverge), mergeS: z.track.project(merge) };
  z.junctions = [...z.junctions, { x: downX, y: DOCK_Y }, { x: upX, y: DOCK_Y }];
  return z;
}

/**
 * Freight station: the belt runs across the upper platform with its stop dead centre; a small magnetic
 * crane lowers crates into the wagon on the tracks below (and lifts them back out).
 */
export const FREIGHT = {
  busY: 690,
  /** The out-leg sits as far left as the loop allows; the platform is centred between the legs. */
  inX: 267,
  outX: 113,
  transfer: { x: 190, y: 690 },
  wagon: { x: 190, y: 784 },
  rails: { left: 136, right: 244, top: 670, bottom: 815 },
  home: { x: 190, y: 737 },
};

/** Storage yard: belt along the top, crane field below. */
export const YARD = {
  busY: 582,
  /** The yard belt's legs sit symmetrically about the platform centre (1365). */
  inX: 1465,
  outX: 1265,
  /** One transfer point, the middle of the belt through the yard: crates are picked up and set down here. */
  pickup: { x: 1365, y: 582 },
  drop: { x: 1365, y: 582 },
  columns: [1302, 1428],
  rows: [662, 740],
  /** Rails stand just outside the belt's legs with a small gap. */
  rails: { left: 1240, right: 1490, top: 562, bottom: 776 },
  /** Where the crane parks between jobs: between the belt and the first row, under the transfer point. */
  home: { x: 1365, y: 622 },
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
  ...Object.values(NET).flatMap((z) => (z.recycle ? [z.recycle.track] : [])),
  ...Object.values(NET).map((z) => z.track),
  LOOP,
];

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
  if (lap && !(from.zone === to.zone && NET[to.zone].recycle)) {
    return [...leave(from.zone, from.slot), ...on(LOOP, LOOP.between(NET[from.zone].exitLoopS, NET[to.zone].entryLoopS)), ...arrive(to.zone, to.slot)];
  }
  const recycle = NET[to.zone].recycle;
  if (from.zone === to.zone && recycle && a.kind === 'track' && b.kind === 'track' && (lap || b.s < a.s)) {
    // Round the dock's own recycle loop rather than the main loop.
    const main = NET[to.zone].track;
    return [...on(main, main.between(a.s, recycle.divergeS)), ...on(recycle.track, recycle.track.pts), ...on(main, main.between(recycle.mergeS, b.s)), b.pos];
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
