import type { Area, Point } from './layout';
import { AREAS } from './layout';

/** Crates and belt slats move at the same speed so items look carried. */
export const BELT_SPEED = 110;
export const LANE_TOP = 415;
export const LANE_BOTTOM = 465;
const R = (LANE_BOTTOM - LANE_TOP) / 2;
const LOOP_LEFT = 70;
const LOOP_RIGHT = 1530;
const FEED_R = 25;
const FEED_DX = 20;

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

function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): Point[] {
  const steps = Math.max(6, Math.ceil((Math.abs(toDeg - fromDeg) / 90) * 10));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

/** The main loop runs clockwise: top lane flows right, bottom lane flows left. */
export const LOOP = new Track(
  [
    { x: LOOP_LEFT, y: LANE_TOP },
    { x: LOOP_RIGHT, y: LANE_TOP },
    ...arc(LOOP_RIGHT, LANE_TOP + R, R, -90, 90).slice(1, -1),
    { x: LOOP_RIGHT, y: LANE_BOTTOM },
    { x: LOOP_LEFT, y: LANE_BOTTOM },
    ...arc(LOOP_LEFT, LANE_TOP + R, R, 90, 270).slice(1, -1),
  ],
  true,
);

const BOTTOM_LANE_START = LOOP.len[LOOP.pts.findIndex((p) => p.x === LOOP_RIGHT && p.y === LANE_BOTTOM)];

function loopS(x: number, lane: 'top' | 'bottom'): number {
  return lane === 'top' ? x - LOOP_LEFT : BOTTOM_LANE_START + (LOOP_RIGHT - x);
}

export interface Feeders {
  in: Track;
  out: Track;
  mergeS: number;
  divergeS: number;
}

function feedersFor(area: Area): Feeders {
  const a = AREAS[area];
  const p = a.port;
  if (a.y < LANE_TOP) {
    const edge = a.y + a.h;
    return {
      out: new Track([{ x: p + FEED_DX, y: edge }, ...arc(p + FEED_DX + FEED_R, LANE_TOP - FEED_R, FEED_R, 180, 90)]),
      in: new Track([...arc(p - FEED_DX - FEED_R, LANE_TOP - FEED_R, FEED_R, 90, 0), { x: p - FEED_DX, y: edge }]),
      mergeS: loopS(p + FEED_DX + FEED_R, 'top'),
      divergeS: loopS(p - FEED_DX - FEED_R, 'top'),
    };
  }
  const edge = a.y;
  return {
    out: new Track([{ x: p - FEED_DX, y: edge }, ...arc(p - FEED_DX - FEED_R, LANE_BOTTOM + FEED_R, FEED_R, 0, -90)]),
    in: new Track([...arc(p + FEED_DX + FEED_R, LANE_BOTTOM + FEED_R, FEED_R, -90, -180), { x: p + FEED_DX, y: edge }]),
    mergeS: loopS(p - FEED_DX - FEED_R, 'bottom'),
    divergeS: loopS(p + FEED_DX + FEED_R, 'bottom'),
  };
}

export const FEEDERS = Object.fromEntries((Object.keys(AREAS) as Area[]).map((k) => [k, feedersFor(k)])) as Record<Area, Feeders>;

/** Every belt to draw, each with its direction of travel. */
export const ALL_TRACKS: Track[] = [LOOP, ...Object.values(FEEDERS).flatMap((f) => [f.in, f.out])];

/** Path from a crate's spot in one area to a target spot in another, riding the belts one way. */
export function route(fromArea: Area, toArea: Area, target: Point): Point[] {
  if (fromArea === toArea) return [target];
  const a = FEEDERS[fromArea];
  const b = FEEDERS[toArea];
  return [...a.out.pts, ...LOOP.between(a.mergeS, b.divergeS), ...b.in.pts, target];
}
