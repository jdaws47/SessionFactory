import { FREIGHT } from './belts';
import { CRATE_H, type Point, TRAIN_Y, W } from './layout';

/** The world is two screens wide: the factory, and the warehouse to its right. */
export const WAREHOUSE_X = W;
export const WORLD_W = W * 2;

/** The freight train shuttles along the rail between the freight station and the warehouse platform. */
export const TRAIN = {
  factoryX: FREIGHT.wagon.x,
  warehouseX: WAREHOUSE_X + 150,
  /** Where crates ride on the wagon (relative to the train's x). */
  wagonY: FREIGHT.wagon.y,
  railY: TRAIN_Y,
  speed: 170,
  accel: 140,
};

/** Warehouse floor: a gantry crane over a field of crate spots (one crate per spot). */
const PLATFORM = { x: WAREHOUSE_X + 60, y: 40, w: W - 100, h: 830 };
export const STACKS = {
  platform: PLATFORM,
  /** Rails run the full platform so the gantry reaches every spot (and the train). */
  rails: { left: PLATFORM.x + 24, right: PLATFORM.x + PLATFORM.w - 24, top: PLATFORM.y + 52, bottom: PLATFORM.y + PLATFORM.h - 14 },
  /** Parks top-left, out of the way. */
  home: { x: PLATFORM.x + 70, y: PLATFORM.y + 52 },
  /** Starts just past the train stop's far engine; 9 x 10 spots. */
  field: { x: WAREHOUSE_X + 262, y: 112, cols: 9, rows: 10, cw: 136, ch: 74 },
  levels: 1,
  lift: 0,
};

export function stackCentre(index: number): Point {
  const f = STACKS.field;
  const col = Math.floor(index / f.rows);
  const row = index % f.rows;
  return { x: f.x + col * f.cw + f.cw / 2, y: f.y + row * f.ch + f.ch / 2 };
}

/** Where a crate at a given level of a stack sits. */
export function stackSpot(index: number, level: number): Point {
  const c = stackCentre(index);
  return { x: c.x, y: c.y - level * STACKS.lift };
}

/**
 * Stacks of crates: each stack holds up to STACKS.levels (more pile on the last stack). New crates go on the
 * first stack with room, filling from the train side outwards; taking a crate out lets the ones above settle.
 */
export class Stacks {
  readonly stacks: string[][] = Array.from({ length: STACKS.field.cols * STACKS.field.rows }, () => []);

  place(id: string): { index: number; level: number } {
    const found = this.where(id);
    if (found) return found;
    let index = this.stacks.findIndex((s) => s.length < STACKS.levels);
    if (index < 0) index = this.stacks.length - 1;
    this.stacks[index].push(id);
    return { index, level: this.stacks[index].length - 1 };
  }

  /** Reserves a spot for a crate on its way in, without it being on a stack yet. */
  nextSpot(): Point {
    const index = this.stacks.findIndex((s) => s.length < STACKS.levels);
    const i = index < 0 ? this.stacks.length - 1 : index;
    return stackSpot(i, Math.min(this.stacks[i].length, STACKS.levels - 1));
  }

  remove(id: string): void {
    for (const s of this.stacks) {
      const i = s.indexOf(id);
      if (i >= 0) s.splice(i, 1);
    }
  }

  where(id: string): { index: number; level: number } | undefined {
    for (let index = 0; index < this.stacks.length; index++) {
      const level = this.stacks[index].indexOf(id);
      if (level >= 0) return { index, level };
    }
    return undefined;
  }

  spotOf(id: string): Point | undefined {
    const w = this.where(id);
    return w ? stackSpot(w.index, Math.min(w.level, STACKS.levels + 2)) : undefined;
  }
}

/** The train: moves between its two stops with gentle acceleration; crates ride in its wagon. */
export class Train {
  x = TRAIN.factoryX;
  private target = TRAIN.factoryX;
  private v = 0;
  /** Crates in the wagon, in loading order. */
  cargo: string[] = [];
  /** Seconds since the train last arrived or took on a crate. */
  idle = 0;

  get atFactory(): boolean {
    return this.x === TRAIN.factoryX && this.target === TRAIN.factoryX;
  }

  get atWarehouse(): boolean {
    return this.x === TRAIN.warehouseX && this.target === TRAIN.warehouseX;
  }

  get moving(): boolean {
    return this.x !== this.target;
  }

  goTo(where: 'factory' | 'warehouse'): void {
    this.target = where === 'factory' ? TRAIN.factoryX : TRAIN.warehouseX;
    this.idle = 0;
  }

  /** Where the n-th crate sits in the wagon (up to three side by side, the rest stacked on top). */
  wagonSpot(n = 0): Point {
    const slot = Math.min(n, 5);
    return { x: this.x - 30 + (slot % 3) * 30, y: TRAIN.wagonY - Math.floor(slot / 3) * 10 - CRATE_H * 0 };
  }

  update(dt: number): void {
    const gap = this.target - this.x;
    if (gap === 0) {
      this.v = 0;
      this.idle += dt;
      return;
    }
    const stopping = Math.sqrt(2 * TRAIN.accel * Math.abs(gap));
    this.v = Math.min(this.v + TRAIN.accel * dt, TRAIN.speed, stopping);
    const step = this.v * dt;
    this.x = Math.abs(gap) <= step ? this.target : this.x + Math.sign(gap) * step;
  }
}
