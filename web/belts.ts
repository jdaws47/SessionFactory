import type { Area, Point } from './layout';

/** Crates and belt sections move at the same speed so items look carried. */
export const BELT_SPEED = 200;
export const LANE_TOP = 415;
export const LANE_BOTTOM = 465;
const R = 22;
const STUB_OFFSET = 16;

export interface Pose extends Point {
  angle: number;
}

/** A directed polyline with cumulative lengths; items move from pts[0] toward the end. */
export class Track {
  readonly len: number[] = [0];
  readonly total: number;

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
  slots: Slot[];
  entryLoopS: number;
  exitLoopS: number;
  /** Where the zone belt branches off the loop and where it rejoins it. */
  junctions: Point[];
}

/** The main loop runs clockwise: top lane flows right, bottom lane flows left. */
export const LOOP = new Track(
  rounded(
    [
      { x: 12, y: LANE_TOP },
      { x: 1588, y: LANE_TOP },
      { x: 1588, y: LANE_BOTTOM },
      { x: 12, y: LANE_BOTTOM },
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

/** A slot with its own entrance and exit belts branching off the zone bus. dir is the bus flow (+1 right, −1 left). */
function stubSlot(track: Track, busY: number, dir: 1 | -1, pos: Point): StubSlot {
  const inX = pos.x - STUB_OFFSET * dir;
  const outX = pos.x + STUB_OFFSET * dir;
  const diverge = { x: inX - R * dir, y: busY };
  const merge = { x: outX + R * dir, y: busY };
  return {
    kind: 'stub',
    pos,
    in: new Track(rounded([diverge, { x: inX, y: busY }, { x: inX, y: pos.y }], R)),
    out: new Track(rounded([{ x: outX, y: pos.y }, { x: outX, y: busY }, merge], R)),
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
    slots: trackSlots(track, [{ x: HOPPER_DROP.x, y: 336 }, { x: HOPPER_DROP.x, y: 266 }]),
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
export const MACHINE_COLUMNS = [420, 620, 820, 1020, 1220, 1420];

export const HOPPER_DROP: Point = { x: 145, y: 196 };
export const DOCK_FRONT_X = 440;
export const DOCK_Y = 650;
export const FREIGHT_LOAD: Point = { x: 150, y: 770 };

/** Storage yard: belt along the top, crane field below. */
export const YARD = {
  busY: 572,
  pickup: { x: 1430, y: 572 },
  drop: { x: 1270, y: 572 },
  columns: [1244, 1370, 1496],
  rows: [656, 734, 812],
  rails: { left: 1172, right: 1558, top: 600, bottom: 852 },
};

function craneYard(track: Track): CraneSlot[] {
  const pickupS = track.project(YARD.pickup);
  const dropS = track.project(YARD.drop);
  return YARD.rows.flatMap((y) => YARD.columns.map((x) => ({ kind: 'crane' as const, pos: { x, y }, pickup: YARD.pickup, drop: YARD.drop, pickupS, dropS })));
}

export const NET: Record<Area, ZoneNet> = {
  intake: hopperLine(),
  working: zone(topZoneTrack(310, 1530, TOP_BUS), (t) => TOP_ROWS.flatMap((y) => MACHINE_COLUMNS.map((x) => stubSlot(t, TOP_BUS, 1, { x, y })))),
  freight: zone(bottomZoneTrack(230, 60, FREIGHT_LOAD.y), (t) => trackSlots(t, [FREIGHT_LOAD])),
  dock: zone(bottomZoneTrack(1100, 330, DOCK_Y), (t) => trackSlots(t, [0, 1, 2, 3, 4].map((i) => ({ x: DOCK_FRONT_X + i * 134, y: DOCK_Y })))),
  storage: zone(bottomZoneTrack(1540, 1180, YARD.busY), craneYard),
};

export const HOPPER_S = 0;

export interface Gate {
  zone: Area;
  /** Where the bar crosses the belt. */
  at: Point;
  /** Direction the belt runs at the gate. */
  belt: 'h' | 'v';
  label: string[];
}

/** Gates sit where crates wait, and say why they are waiting. They lift while the belt carries something. */
export const GATES: Gate[] = [
  { zone: 'dock', at: { x: DOCK_FRONT_X - 72, y: DOCK_Y }, belt: 'h', label: ['waiting', 'on you'] },
  { zone: 'intake', at: { x: HOPPER_DROP.x, y: 375 }, belt: 'v', label: ['awaiting', 'prompt'] },
];

/** Draw order: slot branches under zone belts, zone belts under the main loop. */
export const ALL_TRACKS: Track[] = [
  ...Object.values(NET).flatMap((z) => z.slots.flatMap((s) => (s.kind === 'stub' ? [s.in, s.out] : []))),
  ...Object.values(NET).map((z) => z.track),
  LOOP,
];

/** Where zone belts split off and merge into the loop (drawn as splitter/merger blocks). */
export const JUNCTIONS: Point[] = Object.values(NET).flatMap((z) => z.junctions);

function leave(zoneName: Area, slot: number): Point[] {
  const z = NET[zoneName];
  const s = z.slots[slot];
  if (s.kind === 'stub') return [s.pos, ...s.out.pts, ...z.track.between(s.mergeS, z.track.total)];
  if (s.kind === 'crane') return [s.pos, s.drop, ...z.track.between(s.dropS, z.track.total)];
  return z.track.between(s.s, z.track.total);
}

function arrive(zoneName: Area, slot: number): Point[] {
  const z = NET[zoneName];
  const s = z.slots[slot];
  if (s.kind === 'stub') return [...z.track.between(0, s.divergeS), ...s.in.pts, s.pos];
  if (s.kind === 'crane') return [...z.track.between(0, s.pickupS), s.pickup, s.pos];
  return [...z.track.between(0, s.s), s.pos];
}

export interface SlotRef {
  zone: Area;
  slot: number;
}

/** Belt path between two slots. Moving forward along the same zone belt stays on it; anything else goes round the loop. */
export function travel(from: SlotRef, to: SlotRef): Point[] {
  const a = NET[from.zone].slots[from.slot];
  const b = NET[to.zone].slots[to.slot];
  if (from.zone === to.zone && from.slot === to.slot) return [b.pos];
  if (from.zone === to.zone && a.kind === 'crane' && b.kind === 'crane') return [a.pos, b.pos];
  if (from.zone === to.zone && a.kind === 'track' && b.kind === 'track' && b.s >= a.s) {
    return [...NET[to.zone].track.between(a.s, b.s), b.pos];
  }
  return [...leave(from.zone, from.slot), ...LOOP.between(NET[from.zone].exitLoopS, NET[to.zone].entryLoopS), ...arrive(to.zone, to.slot)];
}

/** Path for a brand-new crate dropped from the hopper onto the intake belt. */
export function fromHopper(to: SlotRef): Point[] {
  const intake = NET.intake;
  const b = NET[to.zone].slots[to.slot];
  if (to.zone === 'intake' && b.kind === 'track' && b.s >= HOPPER_S) return [HOPPER_DROP, ...intake.track.between(HOPPER_S, b.s), b.pos];
  return [HOPPER_DROP, ...intake.track.between(HOPPER_S, intake.track.total), ...LOOP.between(intake.exitLoopS, NET[to.zone].entryLoopS), ...arrive(to.zone, to.slot)];
}
