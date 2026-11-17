import type { Zone } from '../src/shared/types';

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

export const AREAS: Record<Area, AreaDef> = {
  intake: { x: 65, y: 36, w: 160, h: 334, title: 'INTAKE', subtitle: 'new' },
  working: { x: 290, y: 36, w: 1280, h: 334, title: 'ASSEMBLY HALL', subtitle: 'claude is working · jammed machines need you' },
  freight: { x: 30, y: 510, w: 230, h: 360, title: 'FREIGHT', subtitle: 'archive' },
  dock: { x: 300, y: 510, w: 830, h: 290, title: 'LOADING DOCK', subtitle: 'waiting on you' },
  storage: { x: 1160, y: 510, w: 410, h: 360, title: 'STORAGE', subtitle: 'session ended' },
};

/** The hopper's mouth sits just above where new crates land on the intake belt (belts.HOPPER_DROP). */
export const HOPPER: Rect = { x: 85, y: 88, w: 120, h: 84 };
export const TRAIN_Y = 808;
/** The operator stands between the dock queue and its recycle belt, at the front. */
export const OPERATOR: Point = { x: 440, y: 700 };

export function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
