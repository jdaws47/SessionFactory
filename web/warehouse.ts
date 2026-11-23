import { FREIGHT } from './belts';
import { type Point, TRAIN_Y, W } from './layout';

/** The world is two screens wide: the factory, and the warehouse to its right. */
export const WAREHOUSE_X = W;
export const WORLD_W = W * 2;

/** The freight train shuttles along the rail between the freight station and the warehouse platform. */
export const TRAIN = {
  factoryX: FREIGHT.wagon.x,
  /** Pulled well in, clear of the gantry's left rail. */
  warehouseX: WAREHOUSE_X + 215,
  /** The wagon fits one crate snugly; an engine sits at each end. Half the whole train's length: */
  half: 108,
  wagonW: 126,
  /** Where crates ride on the wagon (relative to the train's x). */
  wagonY: FREIGHT.wagon.y,
  railY: TRAIN_Y,
  speed: 170,
  accel: 140,
};

/** Warehouse floor: a gantry crane over a field of crate spots; once every spot is taken, crates pile up on them. */
const PLATFORM = { x: WAREHOUSE_X + 60, y: 40, w: W - 100, h: 830 };
export const STACKS = {
  platform: PLATFORM,
  /** Rails run the full platform so the gantry reaches every spot (and the train). */
  rails: { left: PLATFORM.x + 24, right: PLATFORM.x + PLATFORM.w - 24, top: PLATFORM.y + 52, bottom: PLATFORM.y + PLATFORM.h - 14 },
  /** Parks top-left in its own lane above the first row, short of the rail ends so the supports show past it. */
  home: { x: PLATFORM.x + 70, y: PLATFORM.y + 75 },
  /** Fills the building from the left wall below the parking lane; spots over the train's track are left out (see SPOTS). */
  field: { x: PLATFORM.x + 44, y: 142, cols: 10, rows: 10, cw: 136, ch: 70 },
  /** Each crate up a pile sits this much further up and to the left, like the factory's piles, shown up to 4 high. */
  lift: 6,
  shownLevels: 4,
};

/** The train (both engines) and its track at the warehouse stop, which crate spots keep clear of. */
const TRAIN_FOOTPRINT = { x: TRAIN.warehouseX - TRAIN.half - 6, y: TRAIN.railY - 40, w: TRAIN.half * 2 + 12, h: 84 };

function gridCentre(col: number, row: number): Point {
  const f = STACKS.field;
  return { x: f.x + col * f.cw + f.cw / 2, y: f.y + row * f.ch + f.ch / 2 };
}

/** Every usable crate spot, column by column from the train side; spots that would sit on the train are skipped. */
export const SPOTS: Point[] = Array.from({ length: STACKS.field.cols * STACKS.field.rows }, (_, i) =>
  gridCentre(Math.floor(i / STACKS.field.rows), i % STACKS.field.rows),
).filter((c) => {
  const t = TRAIN_FOOTPRINT;
  return c.x + 59 < t.x || c.x - 59 > t.x + t.w || c.y + 28 < t.y || c.y - 28 > t.y + t.h;
});

export function stackCentre(index: number): Point {
  return SPOTS[Math.min(index, SPOTS.length - 1)];
}

/** Where a crate at a given level of a stack sits. */
export function stackSpot(index: number, level: number): Point {
  const c = stackCentre(index);
  const k = Math.min(level, STACKS.shownLevels - 1) * STACKS.lift;
  return { x: c.x - k, y: c.y - k };
}

/**
 * Stacks of crates, one per spot. A crate goes on the spot the server placed it on (or, without one, on the lowest
 * stack, nearest the train first); taking a crate out lets the ones above settle.
 */
export class Stacks {
  readonly stacks: string[][] = Array.from({ length: SPOTS.length }, () => []);

  /** Puts a crate on the spot the server placed it on (or the first free one if it has no placement yet). */
  place(id: string, spot?: number): { index: number; level: number } {
    const found = this.where(id);
    if (found && (spot === undefined || found.index === spot)) return found;
    if (found) this.remove(id);
    const lowest = Math.min(...this.stacks.map((s) => s.length));
    let index = spot ?? this.stacks.findIndex((s) => s.length === lowest);
    if (index < 0 || index >= this.stacks.length) index = this.stacks.length - 1;
    this.stacks[index].push(id);
    return { index, level: this.stacks[index].length - 1 };
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
    return w ? stackSpot(w.index, w.level) : undefined;
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

  /** +1 heading for the warehouse, -1 heading back to the factory, 0 standing. */
  get heading(): number {
    return Math.sign(this.target - this.x);
  }

  goTo(where: 'factory' | 'warehouse'): void {
    this.target = where === 'factory' ? TRAIN.factoryX : TRAIN.warehouseX;
    this.idle = 0;
  }

  /** Where the n-th crate sits in the wagon: centred on it, later crates stacked a little higher. */
  wagonSpot(n = 0): Point {
    return { x: this.x, y: TRAIN.wagonY - Math.min(n, 3) * 6 };
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
