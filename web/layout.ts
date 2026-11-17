import type { Zone } from '../src/shared/types';

export type Area = Zone | 'freight';

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
  intake: { x: 30, y: 36, w: 230, h: 334, title: 'INTAKE', subtitle: 'new' },
  working: { x: 290, y: 36, w: 840, h: 334, title: 'ASSEMBLY HALL', subtitle: 'claude is working' },
  alert: { x: 1160, y: 36, w: 410, h: 334, title: 'ALERT BAY', subtitle: 'needs you' },
  freight: { x: 30, y: 510, w: 230, h: 360, title: 'FREIGHT', subtitle: 'archive' },
  dock: { x: 290, y: 510, w: 840, h: 360, title: 'LOADING DOCK', subtitle: 'waiting on you' },
  storage: { x: 1160, y: 510, w: 410, h: 360, title: 'STORAGE', subtitle: 'session ended' },
};

/** The hopper's mouth sits just above where new crates land on the intake belt (belts.HOPPER_DROP). */
export const HOPPER: Rect = { x: 85, y: 88, w: 120, h: 84 };
export const TRAIN_Y = 818;
export const OPERATOR: Point = { x: 440, y: 752 };

export function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
