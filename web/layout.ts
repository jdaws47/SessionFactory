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
  /** x position where this area's feeder belt meets the main belt. */
  port: number;
}

export const W = 1600;
export const H = 900;
export const CRATE_W = 118;
export const CRATE_H = 56;

export const AREAS: Record<Area, AreaDef> = {
  intake: { x: 30, y: 36, w: 230, h: 334, port: 145, title: 'INTAKE', subtitle: 'new sessions' },
  working: { x: 290, y: 36, w: 840, h: 334, port: 710, title: 'ASSEMBLY HALL', subtitle: 'claude is working' },
  alert: { x: 1160, y: 36, w: 410, h: 334, port: 1365, title: 'ALERT BAY', subtitle: 'needs you' },
  freight: { x: 30, y: 510, w: 230, h: 360, port: 145, title: 'FREIGHT', subtitle: 'to warehouse' },
  dock: { x: 290, y: 510, w: 840, h: 360, port: 710, title: 'LOADING DOCK', subtitle: 'waiting on you' },
  storage: { x: 1160, y: 510, w: 410, h: 360, port: 1365, title: 'STORAGE', subtitle: 'session ended' },
};

export const HOPPER: Rect = { x: AREAS.intake.x + 55, y: AREAS.intake.y + 44, w: 120, h: 86 };
export const TRAIN_Y = AREAS.freight.y + 290;

function grid(area: AreaDef, i: number, cols: number, cellW: number, cellH: number, top: number): Point {
  const usable = cols * cellW;
  const left = area.x + (area.w - usable) / 2;
  return { x: left + (i % cols) * cellW + cellW / 2, y: area.y + top + Math.floor(i / cols) * cellH + cellH / 2 };
}

export function machineRects(occupied: number): Rect[] {
  const area = AREAS.working;
  const count = Math.max(8, Math.ceil(occupied / 4) * 4);
  const cols = 4;
  const rows = count / cols;
  const cellW = (area.w - 40) / cols;
  const cellH = Math.min(140, (area.h - 54) / rows);
  return Array.from({ length: count }, (_, i) => ({
    x: area.x + 20 + (i % cols) * cellW + 10,
    y: area.y + 48 + Math.floor(i / cols) * cellH + 6,
    w: cellW - 20,
    h: cellH - 12,
  }));
}

export const OPERATOR: Point = { x: AREAS.dock.x + 62, y: AREAS.dock.y + 120 };

/** Center of the i-th crate slot in a zone; `count` is how many crates share the zone. */
export function slotPosition(zone: Zone, i: number, count: number): Point {
  switch (zone) {
    case 'intake':
      return grid(AREAS.intake, i, 1, 130, 78, 146);
    case 'working': {
      const m = machineRects(count)[i];
      return { x: m.x + m.w / 2, y: m.y + m.h / 2 + 10 };
    }
    case 'alert':
      return grid(AREAS.alert, i, 3, 132, 98, 60);
    case 'dock':
      return { x: AREAS.dock.x + 180 + (i % 5) * 134, y: OPERATOR.y + Math.floor(i / 5) * 96 };
    case 'storage':
      return grid(AREAS.storage, i, 3, 132, 86, 56);
  }
}

export function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
