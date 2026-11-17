import type { Zone } from '../src/shared/types';
import { FREIGHT, LANE_BOTTOM, LANE_TOP, NET, type Track, YARD } from './belts';

/** Places on the floor. Sessions waiting on you stay in their assembler (it jams), so 'alert' has no area. */
export type Area = Exclude<Zone, 'alert'> | 'freight';

/**
 * Where a crate in a given state sits on the floor. Waiting on you means a jammed assembler; a session
 * back at "intake" after it has already had turns (e.g. /clear) waits at the dock, since intake only
 * takes brand-new crates from the hopper.
 */
export function floorArea(zone: Zone, turns = 0): Area {
  if (zone === 'alert') return 'working';
  if (zone === 'intake' && turns > 0) return 'dock';
  return zone;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AreaDef extends Rect {
  title: string;
  subtitle: string;
}

export const W = 1600;
export const H = 900;
export const CRATE_W = 118;
export const CRATE_H = 56;



/** The hopper's mouth sits just above where new crates land on the intake belt (belts.HOPPER_DROP). */
export const HOPPER: Rect = { x: 85, y: 112, w: 120, h: 84 };
export const MACHINE_W = 148;
export const MACHINE_H = 76;
export const TRAIN_Y = 688;
/** The operator stands between the dock queue and its recycle belt, at the front. */
export const OPERATOR: Point = { x: 491, y: 655 };

export function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

const TITLES: Record<Area, { title: string; subtitle: string }> = {
  intake: { title: 'INTAKE', subtitle: 'new' },
  working: { title: 'ASSEMBLY HALL', subtitle: 'claude is working' },
  freight: { title: 'FREIGHT', subtitle: 'archive' },
  dock: { title: 'LOADING DOCK', subtitle: 'waiting on you' },
  storage: { title: 'STORAGE', subtitle: 'session ended' },
};

const PAD = 14;
const HEADER = 34;
const BELT_HALF = 15;
/** Belt points this far from the loop count as inside a platform; the legs that reach the loop stay outside. */
const LEG_CLEARANCE = 80;

function around(p: Point, halfW: number, halfH: number): Rect {
  return { x: p.x - halfW, y: p.y - halfH, w: halfW * 2, h: halfH * 2 };
}

function bounds(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}

function beltInside(track: Track, above: boolean): Rect[] {
  return track.pts.filter((p) => (above ? p.y <= LANE_TOP - LEG_CLEARANCE : p.y >= LANE_BOTTOM + LEG_CLEARANCE)).map((p) => around(p, BELT_HALF, BELT_HALF));
}

/** Everything drawn in each area (crates at their spots, machines, signs, cranes, props), as rectangles. */
function contents(area: Area): Rect[] {
  const z = NET[area];
  const above = area === 'intake' || area === 'working';
  const crates = z.slots.map((s) => around(s.pos, CRATE_W / 2, CRATE_H / 2));
  const belts = [...beltInside(z.track, above), ...z.slots.flatMap((s) => (s.kind === 'stub' ? [...beltInside(s.in, above), ...beltInside(s.out, above)] : []))];
  switch (area) {
    case 'intake':
      return [...crates, ...belts, { ...HOPPER, y: HOPPER.y - 4, h: HOPPER.h + 4 }];
    case 'working':
      return [
        ...belts,
        // Machine housing with its smokestack, and the tool sign on the side away from the bus.
        ...z.slots.map((s) => ({ x: s.pos.x - MACHINE_W / 2, y: s.pos.y - MACHINE_H / 2 - 22, w: MACHINE_W, h: MACHINE_H + 44 })),
      ];
    case 'dock':
      return [
        ...crates.map((r) => ({ ...r, y: r.y - 12, h: r.h + 12 })),
        ...belts,
        ...(z.recycle ? beltInside(z.recycle.track, false) : []),
        // Operator, workbench, retro computer and mug.
        { x: OPERATOR.x - 12, y: OPERATOR.y - 33, w: 112, h: 57 },
      ];
    case 'storage':
      return [...crates, ...belts, { x: YARD.rails.left - 4, y: YARD.rails.top - 6, w: YARD.rails.right - YARD.rails.left + 8, h: YARD.rails.bottom - YARD.rails.top + 12 }];
    case 'freight':
      return [
        ...belts,
        { x: FREIGHT.rails.left - 4, y: FREIGHT.rails.top - 6, w: FREIGHT.rails.right - FREIGHT.rails.left + 8, h: FREIGHT.rails.bottom - FREIGHT.rails.top + 12 },
        // Wagon and locomotive, and the label under the train.
        { x: FREIGHT.wagon.x - 46, y: TRAIN_Y - 34, w: 152, h: 76 },
      ];
  }
}

/** Platforms size themselves to their contents, plus padding and a header strip for the title. */
export const AREAS: Record<Area, AreaDef> = Object.fromEntries(
  (Object.keys(TITLES) as Area[]).map((area) => {
    const b = bounds(contents(area));
    return [area, { ...TITLES[area], x: b.x - PAD, y: b.y - PAD - HEADER, w: b.w + PAD * 2, h: b.h + PAD * 2 + HEADER }];
  }),
) as Record<Area, AreaDef>;
