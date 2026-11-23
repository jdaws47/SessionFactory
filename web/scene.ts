import type { CrateView } from '../src/shared/types';
import { ALL_TRACKS, BELT_SPEED, DOCK_CRANE, type Track, FREIGHT, fromHopper, fromLoop, liftOutOfDock, onwardFrom, HOPPER_DROP, JUNCTIONS, LOOP, NET, type SlotRef, travel, type Waypoint, YARD } from './belts';
import { AREAS, type Area, CRATE_H, CRATE_W, HOPPER, MACHINE_H, MACHINE_W, type Point, TRAIN_Y, W } from './layout';
import { Crane } from './crane';
import { CELL, cellNear, CELLS, CONFLICTS, REACH_X, REACH_Y, routeCells, SAFE } from './cells';
import { Smoke } from './smoke';
import { STACKS, Stacks, stackSpot, Train, TRAIN, WAREHOUSE_X, WORLD_W } from './warehouse';
import { squircleAt, squirclePath } from './shapes';
import { C, crateColor, drawBelt, drawCrane, drawOperator, fillSquircle, junction, machineBack, machineFront, minutes, paintScenery, paintWarehouse, RADIUS, sectionKey, wrap } from './paint';

/**
 * A crate's lifecycle. 'floor': on the factory floor. 'toFreight': archived and on its way to the train (belts, freight
 * crane). 'cargo': riding the train. 'yard': parked on a warehouse stack. Unloaded at the factory it is 'floor' again.
 */
export type Phase = 'floor' | 'toFreight' | 'cargo' | 'yard';

/** Off the factory floor for good: on the train or in the warehouse. */
const away = (s: Sprite): boolean => s.phase === 'cargo' || s.phase === 'yard';

interface Leg {
  path: Waypoint[];
  to: SlotRef;
}

export interface Sprite {
  x: number;
  y: number;
  /** Where the crate is heading (or sits); used to keep slots sticky. */
  at: SlotRef;
  /** Where the trip it is on right now ends. */
  currentTo: SlotRef;
  path: Waypoint[];
  /** At most one trip is queued behind the current one, so rapid state changes never pile up detours. */
  next?: Leg;
  /** Where the crate is in its life: see Phase. */
  phase: Phase;
  /** Brought back while on the train or in the warehouse: rides the train home, then heads for `at`. */
  homeward?: boolean;
  /** Fixed place in the wagon while riding the train, so crates don't shuffle when another is unloaded. */
  wagonSlot?: number;
  pileRank: number;
  pileSize: number;
  /** When it came to rest where it is, as a running count (undefined while moving or lifted). */
  settled?: number;
  /** Pile level a crate lowered by crane onto a factory pile lands at (set while the crane carries it). */
  dropLift?: number;
  /** Height in its pile as drawn (levels), easing towards its place so a crate is lifted onto the pile, not teleported. */
  lift?: number;
  /** Seconds spent waiting for the way to clear; the longest-waiting crates claim belt cells first. */
  waited?: number;
}

/** Seconds the train waits after its last crate is loaded (or unloaded) before setting off. */
const TRAIN_DWELL = 1;


export class Scene {
  private sprites = new Map<string, Sprite>();
  private crates = new Map<string, CrateView>();
  private archivedCount = 0;
  private serverNow = Date.now();
  private clientAtSync = Date.now();
  private staticLayer: HTMLCanvasElement | null = null;
  private staticKey = '';
  /** How far each belt section has travelled (key "belt:section"); sections only advance while carrying something. */
  private beltOffset = new Map<string, number>();
  private lastCrates: CrateView[] = [];
  private cranes = { storage: new Crane(YARD.home), freight: new Crane(FREIGHT.home), dock: new Crane(DOCK_CRANE.home) };
  readonly train = new Train();
  private gantry = new Crane(STACKS.home, 260, 0.2, 0.35);
  private stacks = new Stacks();
  /** Warehouse gantry jobs in progress: storing a crate from the train, or fetching one for the train. */
  private gantryJobs = new Map<string, 'store' | 'fetch'>();
  /** Camera position along the two-screen world (0 = factory, WAREHOUSE_X = warehouse). */
  camX = 0;
  private camTarget = 0;
  /** Warehouse search: crates that don't match are dimmed. */
  highlight = '';
  private smoke = new Smoke();
  private lastDraw = 0;

  /** A new state snapshot from the server: remember it and lay the floor out for it. */
  setCrates(crates: CrateView[], now: number): void {
    const first = this.crates.size === 0 && this.sprites.size === 0;
    this.serverNow = now;
    this.clientAtSync = Date.now();
    this.crates = new Map(crates.map((c) => [c.id, c]));
    this.lastCrates = crates;
    this.archivedCount = crates.filter((c) => c.archived).length;
    this.relayout(first);
  }

  /** Sends every crate to the spot and pile place the server gave it; archived crates go by train (see below). */
  private relayout(first = false): void {
    const crates = this.lastCrates;
    for (const c of crates) {
      const p = c.placement;
      if (c.archived || !p || p.area === 'warehouse') continue;
      this.place(c, { zone: p.area, slot: p.slot }, first, p.rank, p.pileSize);
    }

    for (const [id, s] of this.sprites) {
      const c = this.crates.get(id);
      if (!c) {
        // Gone from the factory altogether: nothing may keep waiting on it.
        this.sprites.delete(id);
        this.stacks.remove(id);
        this.gantryJobs.delete(id);
        this.train.cargo = this.train.cargo.filter((cid) => cid !== id);
        for (const crane of [...Object.values(this.cranes), this.gantry]) crane.cancel(id);
        this.release(id);
        this.release(`crane:${id}`);
      } else if (c.archived && s.phase === 'floor') {
        this.go(s, { zone: 'freight', slot: 0 });
        s.phase = 'toFreight';
        s.pileRank = 0;
        s.pileSize = 1;
      } else if (c.archived && s.homeward) {
        s.homeward = false;
      }
    }
    // Archived crates the floor has never seen (first load, history import) are already in the warehouse.
    for (const c of crates) {
      if (!c.archived || this.sprites.has(c.id)) continue;
      const spot = this.stacks.place(c.id, this.warehouseSpot(c.id));
      const pos = stackSpot(spot.index, spot.level);
      this.sprites.set(c.id, { ...pos, at: { zone: 'freight', slot: 0 }, currentTo: { zone: 'freight', slot: 0 }, path: [], phase: 'yard', pileRank: 0, pileSize: 1 });
    }
  }

  /** The warehouse spot the server placed an archived crate on. */
  private warehouseSpot(id: string): number | undefined {
    const p = this.crates.get(id)?.placement;
    return p?.area === 'warehouse' ? p.slot : undefined;
  }

  /** Called when the view should follow the train (set by main so the UI updates too). */
  onFollowTrain?: (where: 'factory' | 'warehouse') => void;

  /** The simulation's live state, for tests and debugging. Not for the UI: it reads crates through setCrates(). */
  inspect() {
    return {
      sprites: this.sprites,
      gantryJobs: this.gantryJobs as ReadonlyMap<string, 'store' | 'fetch'>,
      cranes: this.cranes,
      gantry: this.gantry,
      drawOrder: () => this.drawOrder(),
      pileOffset: (s: Sprite) => this.pileOffset(s),
      covered: (s: Sprite) => this.covered(s),
      /** The belt cell a crate stands on (see cells.ts), if it is on a belt. */
      cellOf: (id: string) => {
        const s = this.sprites.get(id);
        return s && this.occupiedCell(id, s);
      },
      /** How far a belt section has run in total. */
      beltTravel: (track: Track, section: number) => this.beltOffset.get(sectionKey(track, section)) ?? 0,
    };
  }
  /** A recalled crate's train has left the warehouse while you watched; follow it once it crosses the page edge. */
  private followHome = false;
  /** Counts crates coming to rest (see Sprite.settled). */
  private arrivals = 0;

  panTo(where: 'factory' | 'warehouse'): void {
    this.camTarget = where === 'factory' ? 0 : WAREHOUSE_X;
  }

  /** Whether a point (world coordinates) is on the train, wherever it is. */
  onTrain(p: Point): boolean {
    const x = this.train.x;
    return p.x > x - TRAIN.half && p.x < x + TRAIN.half && p.y > TRAIN_Y - 36 && p.y < TRAIN_Y + 32;
  }

  get onWarehouse(): boolean {
    return this.camTarget === WAREHOUSE_X;
  }

  /** The crates on the same warehouse stack as this one, top first. */
  stackOf(id: string): string[] {
    const w = this.stacks.where(id);
    return w ? [...this.stacks.stacks[w.index]].reverse() : [id];
  }

  private place(c: CrateView, to: SlotRef, instant: boolean, pileRank: number, pileSize: number): void {
    let s = this.sprites.get(c.id);
    if (!s) {
      const pos = NET[to.zone].slots[to.slot].pos;
      if (instant) {
        s = { ...pos, at: to, currentTo: to, path: [], phase: 'floor', pileRank, pileSize };
      } else if (c.reactivationCount > 0) {
        s = { x: FREIGHT.wagon.x, y: FREIGHT.wagon.y, at: to, currentTo: to, path: travel({ zone: 'freight', slot: 0 }, to), phase: 'floor', pileRank, pileSize };
      } else {
        s = { x: HOPPER_DROP.x, y: HOPPER.y + HOPPER.h - CRATE_H / 2, at: to, currentTo: to, path: fromHopper(to), phase: 'floor', pileRank, pileSize };
      }
      this.sprites.set(c.id, s);
      return;
    }
    if (away(s)) {
      // In the warehouse or on the train: it comes home by train first (see updateWarehouse()).
      s.at = to;
      s.homeward = true;
      s.pileRank = pileRank;
      s.pileSize = pileSize;
      return;
    }
    if (s.phase === 'toFreight') {
      // Still on its way to freight: just turn it round (and give up any place it had in the wagon).
      s.phase = 'floor';
      s.wagonSlot = undefined;
    }
    s.pileRank = pileRank;
    s.pileSize = pileSize;
    if (s.at.zone !== to.zone || s.at.slot !== to.slot) this.go(s, to);
  }

  /** Sends a sprite to a slot along the belts, after finishing the trip it is already on. */
  /**
   * Where a crane should set a crate down: on top of whatever is already there, so it lands where it will stay.
   * Wagon crates get their place in the wagon now; crates for a factory pile are lowered onto its top.
   */
  private dropPoint(id: string, s: Sprite, p: Point, intoWagon: boolean): Point {
    if (intoWagon) {
      if (s.wagonSlot === undefined) s.wagonSlot = this.nextWagonSlot(id);
      return this.train.wagonSpot(s.wagonSlot);
    }
    const spot = NET[s.at.zone].slots[s.at.slot];
    if (s.path.length !== 1 || spot.pos.x !== p.x || spot.pos.y !== p.y) return p;
    const below = [...this.sprites.entries()].filter(([oid, o]) => oid !== id && o.phase === 'floor' && !o.path.length && !o.next && o.at.zone === s.at.zone && o.at.slot === s.at.slot).length;
    const k = Math.min(below, 3);
    s.dropLift = k;
    return { x: p.x - k * 6, y: p.y - k * 6 };
  }

  /** The lowest wagon place not taken by a crate in the wagon or one on its way into it. */
  private nextWagonSlot(id: string): number {
    const taken = new Set([...this.sprites.entries()].filter(([oid, o]) => oid !== id && o.wagonSlot !== undefined).map(([, o]) => o.wagonSlot));
    let n = 0;
    while (taken.has(n)) n++;
    return n;
  }

  /**
   * When a crate's remaining route rides the main loop past the turn-off for `to` before leaving the loop, the
   * route cut short at that turn-off. Undefined when the turn-off isn't ahead on this stretch of loop.
   */
  private turnOffAhead(s: Sprite, to: SlotRef): Waypoint[] | undefined {
    const entry = NET[to.zone].entryLoopS;
    const ahead = (from: number) => (entry - from + LOOP.total) % LOOP.total;
    let prev: { i: number; s: number } | undefined;
    if (s.path[0]?.track === LOOP) prev = { i: -1, s: LOOP.project(s) };
    for (let i = 0; i < s.path.length; i++) {
      const w = s.path[i];
      if (w.track !== LOOP) {
        if (prev) break; // left the loop: the turn-off wasn't on this stretch
        continue;
      }
      const here = LOOP.project(w);
      if (prev && ahead(prev.s) > 0 && ahead(prev.s) <= (here - prev.s + LOOP.total) % LOOP.total) {
        const kept = s.path.slice(0, prev.i + 1);
        const rest = fromLoop(prev.s, to);
        return joins(s, kept, rest) ? [...kept, ...rest] : undefined;
      }
      prev = { i, s: here };
    }
    return undefined;
  }

  private go(s: Sprite, to: SlotRef): void {
    const same = (a: SlotRef, b: SlotRef) => a.zone === b.zone && a.slot === b.slot;
    const id = this.idOf(s);
    // Waiting for a crane to lift it: the job is called off first. If the crane is already at it (or holding it), the
    // lift goes ahead and the crate sets off from where it is put down.
    const waitingFor = s.path[0]?.crane;
    if (this.heldBy(id) || (waitingFor && !this.craneFor(waitingFor).cancel(id))) {
      s.next = same(s.currentTo, to) ? undefined : { path: travel(s.currentTo, to), to };
      s.at = to;
      return;
    }
    if (waitingFor) this.release(`crane:${id}`);
    if (waitingFor === 'dock' && to.zone !== 'dock' && this.onQueue(s)) {
      // Was waiting for the dock crane, and now leaves the dock: the crane lifts it out onto the exit lane instead.
      const spot = NET.dock.slots.findIndex((q) => Math.hypot(q.pos.x - s.x, q.pos.y - s.y) < 1);
      s.path = spot >= 0 ? travel({ zone: 'dock', slot: spot }, to) : liftOutOfDock(s.x, to);
      s.next = undefined;
      s.currentTo = to;
      s.at = to;
      return;
    }
    const dockBelt = NET.dock.track;
    const here = dockBelt.project(s);
    const onDockBelt = Math.hypot(dockBelt.at(here).x - s.x, dockBelt.at(here).y - s.y) < 2;
    // On the dock belt and given another dock spot: it rides up to it. One sent further back leaves by the exit lane
    // and comes round to the back of the queue (the belt only runs forward).
    if (to.zone === 'dock' && onDockBelt && (waitingFor === 'dock' || (s.currentTo.zone === 'dock' && (s.path.length || s.next)))) {
      const spot = NET.dock.slots[to.slot];
      const at = NET.dock.slots.findIndex((q) => Math.hypot(q.pos.x - s.x, q.pos.y - s.y) < 1);
      // Past the front (on the out-leg) it is already on its way out: it comes round like any other.
      if (spot.kind === 'track' && (spot.s >= here || at >= 0 || this.onQueue(s))) {
        s.path =
          at === to.slot ? [] : spot.s >= here ? [...dockBelt.between(here, spot.s).map((p) => ({ x: p.x, y: p.y, track: dockBelt })), spot.pos] : at >= 0 ? travel({ zone: 'dock', slot: at }, to) : liftOutOfDock(s.x, to);
        s.next = undefined;
        s.currentTo = to;
        s.at = to;
        return;
      }
    }
    // On the way into a crane yard (storage or freight) but not craned in yet: skip the hop and ride on.
    const craneAt = s.currentTo.zone !== to.zone ? s.path.findIndex((w) => w.crane) : -1;
    const hop = craneAt >= 0 ? s.path[craneAt] : undefined;
    const into = NET[s.currentTo.zone].slots[s.currentTo.slot];
    const onward = hop && into.kind === 'crane' ? onwardFrom(s.currentTo.zone, into.pickupS, to) : [];
    if (hop && into.kind === 'crane' && hop.x === into.pos.x && hop.y === into.pos.y && joins(s, s.path.slice(0, craneAt), onward) && this.craneFor(s.currentTo.zone).cancel(id)) {
      this.release(`crane:${id}`);
      s.path = [...s.path.slice(0, craneAt), ...onward];
      s.dropLift = undefined;
      if (!away(s)) s.wagonSlot = undefined;
      s.next = undefined;
      s.currentTo = to;
      s.at = to;
      return;
    }
    // Sent to another spot in the zone it is on its way to, and not in that zone yet: it turns in for the new spot.
    const zoneBelt = NET[to.zone].track;
    const turnIn = s.currentTo.zone === to.zone && s.currentTo.slot !== to.slot ? s.path.findIndex((w, i) => i > 0 && w.track === zoneBelt && s.path[i - 1].track === LOOP) : -1;
    const fresh = turnIn > 0 ? fromLoop(NET[to.zone].entryLoopS, to) : [];
    if (turnIn > 0 && joins(s, s.path.slice(0, turnIn), fresh)) {
      s.path = [...s.path.slice(0, turnIn), ...fresh];
      s.next = undefined;
      s.currentTo = to;
      s.at = to;
      return;
    }
    // Still riding the loop towards another zone, and the new zone's turn-off is coming up first: take it.
    // (Also when only the spot changed: the trip to the old spot would have to pass the new one's pile.)
    const early = s.currentTo.zone !== to.zone || s.currentTo.slot !== to.slot ? this.turnOffAhead(s, to) : undefined;
    if (early) {
      s.path = early;
      s.next = undefined;
      s.currentTo = to;
      s.at = to;
      return;
    }
    // Heading for the dock from the main loop and not in yet: carry on round the loop instead of entering. (A crate
    // already in the dock never qualifies: it finishes its trip first.)
    const entry = s.currentTo.zone === 'dock' && to.zone !== 'dock' ? s.path.findIndex((w) => w.track === NET.dock.track) : -1;
    const dockEntry = entry > 0 && s.path[entry - 1].track === LOOP ? entry : -1;
    const turnRound = dockEntry > 0 ? fromLoop(NET.dock.entryLoopS, to) : [];
    if (dockEntry > 0 && joins(s, s.path.slice(0, dockEntry), turnRound)) {
      s.path = [...s.path.slice(0, dockEntry), ...turnRound];
      s.next = undefined;
      s.currentTo = to;
      s.at = to;
      return;
    }
    if (!s.path.length && !s.next) {
      s.path = travel(s.currentTo, to);
      s.currentTo = to;
    } else {
      s.next = same(s.currentTo, to) ? undefined : { path: travel(s.currentTo, to), to };
    }
    s.at = to;
  }

  /** Belt cells each crate holds (see cells.ts). A crane holds the cell it will set a crate down on as `crane:<id>`. */
  private claims = new Map<string, Set<number>>();
  /** Why each crate could not move on the last frame (the crates or cranes holding the cells it needs), for debugging. */
  lastBlockers = new Map<string, Set<string>>();

  /** The belt cell under a crate standing on a belt (not held by a crane, not in the wagon or warehouse). */
  private occupiedCell(id: string, s: Sprite): number | undefined {
    if (away(s) || this.heldBy(id)) return undefined;
    if (s.path.length && !s.path[0].crane) {
      const cell = routeCells(s, s.path, undefined, () => true)[0]?.cell;
      // Not on the belt yet (still dropping down the hopper's chute): it stands on no cell.
      if (cell !== undefined) return Math.hypot(CELLS[cell].x - s.x, CELLS[cell].y - s.y) <= CELL ? cell : undefined;
    }
    return cellNear(s);
  }

  /** The cell each crate stands on this frame (see owners()). */
  private standing = new Map<string, number>();

  /** Who holds each cell: crates standing on it, crates and cranes that have claimed it. */
  private owners(): Map<number, Set<string>> {
    const owners = new Map<number, Set<string>>();
    const add = (cell: number, who: string) => owners.set(cell, (owners.get(cell) ?? new Set()).add(who));
    this.standing = new Map();
    for (const [id, s] of this.sprites) {
      const c = this.occupiedCell(id, s);
      if (c === undefined) continue;
      this.standing.set(id, c);
      add(c, id);
    }
    for (const [who, cells] of this.claims) for (const c of cells) add(c, who);
    return owners;
  }

  /**
   * Whether `who` may hold `cell`: nobody else stands on or holds a conflicting cell. Crates resting on the spot a
   * crate is heading for are its pile (it lands on top). A crate already touching another may always move away
   * from where that one stands, even from the bottom of a pile: the belt pulls it out and the crates above drop down.
   */
  private cellFree(cell: number, who: string, owners: Map<number, Set<string>>): boolean {
    // A crane claims for the crate it carries: that crate's pile is its pile too.
    const me = this.sprites.get(who.startsWith('crane:') ? who.slice(6) : who);
    const mine = (o: string) => o === who || o === `crane:${who}` || `crane:${o}` === who;
    for (const c of CONFLICTS[cell]) {
      for (const o of owners.get(c) ?? []) {
        if (mine(o)) continue;
        const other = this.sprites.get(o);
        if (me && other && !this.heldBy(o)) {
          const resting = !other.path.length && !other.next;
          if (resting && other.phase === 'floor' && other.at.zone === me.currentTo.zone && other.at.slot === me.currentTo.slot) continue;
          // Touching as cells see it (the same reach as their conflicts), so no gap between "in the way" and "touching".
          const touching = Math.abs(other.x - me.x) < REACH_X && Math.abs(other.y - me.y) < REACH_Y;
          // ...only moving away from it, never further into it.
          const away = Math.hypot(CELLS[cell].x - other.x, CELLS[cell].y - other.y) >= Math.hypot(me.x - other.x, me.y - other.y) - 0.5;
          if (touching && away && !who.startsWith('crane:') && this.standing.get(o) === c) continue;
        }
        return false;
      }
    }
    return true;
  }

  /**
   * Claims cells for every moving crate and returns how far each may move this frame. A crate takes every cell up
   * to the next safe cell (or the end of its trip) at once, or none; it keeps the cells it already holds ahead of
   * it and gives up the rest. Crates that have waited longest go first.
   */
  private claimCells(budget: number): Map<string, number> {
    // Crates at rest, on a crane, or off the floor hold nothing: only where they stand counts.
    for (const id of [...this.claims.keys()]) {
      const s = this.sprites.get(id);
      if (id.startsWith('crane:')) {
        if (!this.sprites.has(id.slice(6))) this.claims.delete(id);
      } else if (!s || (!s.path.length && !s.next) || away(s) || this.heldBy(id)) this.claims.delete(id);
    }
    const owners = this.owners();
    const allowed = new Map<string, number>();
    this.lastBlockers = new Map();
    const moving = [...this.sprites.entries()].filter(([id, s]) => (s.path.length || s.next) && !away(s) && !this.heldBy(id));
    moving.sort((a, b) => (b[1].waited ?? 0) - (a[1].waited ?? 0) || a[0].localeCompare(b[0]));
    for (const [id, s] of moving) {
      const cells = routeCells(s, s.path, s.next?.path, (c) => c.dist > budget && SAFE[c.cell]);
      const held = this.claims.get(id) ?? new Set<number>();
      if (!cells.length) {
        // Nothing on a belt ahead (a crane hop): it waits for the crane.
        this.release(id, owners);
        continue;
      }
      let t = cells.findIndex((c, k) => k > 0 && c.dist > budget && SAFE[c.cell]);
      if (t < 0) t = cells.length - 1;
      const need = cells.slice(0, t + 1);
      const blockers = new Set<string>();
      // Cells it already holds are checked again too: one it took to land on a pile stops being free for it once
      // the pile starts to leave, or once it is sent on to another spot.
      for (const [i, { cell }] of need.entries()) {
        if ((i === 0 && held.has(cell)) || this.cellFree(cell, id, owners)) continue;
        for (const c of CONFLICTS[cell]) for (const o of owners.get(c) ?? []) if (o !== id) blockers.add(o);
        break;
      }
      let keep: { cell: number; dist: number }[];
      if (!blockers.size) {
        keep = need;
        allowed.set(id, t === cells.length - 1 ? Infinity : need[need.length - 1].dist);
      } else {
        this.lastBlockers.set(id, blockers);
        // Only what it already holds, in order from where it stands (the cell under it counts as held; a crate not
        // on the belt yet holds nothing until it is granted the way on).
        const mine = (cell: number, i: number) => (i === 0 && this.standing.get(id) === cell) || (held.has(cell) && this.cellFree(cell, id, owners));
        const k = need.findIndex(({ cell }, i) => !mine(cell, i));
        keep = k < 0 ? need : need.slice(0, k);
        allowed.set(id, keep.length > 1 ? keep[keep.length - 1].dist : 0);
      }
      this.release(id, owners);
      const mine = new Set(keep.map((c) => c.cell));
      this.claims.set(id, mine);
      for (const c of mine) owners.set(c, (owners.get(c) ?? new Set()).add(id));
    }
    return allowed;
  }

  /** Drops every cell a crate (or crane job) has claimed. */
  private release(who: string, owners?: Map<number, Set<string>>): void {
    for (const c of this.claims.get(who) ?? []) owners?.get(c)?.delete(who);
    this.claims.delete(who);
  }

  /** On the dock queue's stretch of belt, from the front spot back, within the dock crane's reach (its bridge runs 8px past each rail). */
  private onQueue(s: Point): boolean {
    const front = NET.dock.slots[0].pos;
    return Math.abs(s.y - front.y) < 1 && s.x >= front.x - 1 && s.x <= DOCK_CRANE.rails.right + 8;
  }

  /**
   * The dock queue only moves up its one-lane belt, so a crate can find crates that belong behind it already resting
   * between it and its spot (it reached the dock after them, or came back from the warehouse), or be told to leave
   * while still riding up behind crates that stay. Once it stands stuck behind them, within the dock crane's reach,
   * the crane lifts it over them into its spot, or out onto the exit lane.
   */
  private liftOver(): void {
    const dockBelt = NET.dock.track;
    for (const [id, s] of this.sprites) {
      if ((s.phase !== 'floor' && s.phase !== 'toFreight') || s.currentTo.zone !== 'dock' || !s.path.length || s.path.some((w) => w.crane)) continue;
      const leaving = s.at.zone !== 'dock';
      if (!leaving && s.next) continue;
      if (!this.onQueue(s)) continue;
      const cell = this.occupiedCell(id, s);
      if (cell === undefined || CELLS[cell].track !== dockBelt) continue;
      // Held up by a crate resting in the queue that belongs behind it (or by any, when it is leaving the dock).
      const inTheWay = [...(this.lastBlockers.get(id) ?? [])].some((o) => {
        const os = this.sprites.get(o);
        return !!os && !os.path.length && !os.next && os.phase === 'floor' && os.at.zone === 'dock' && (leaving || os.at.slot > s.at.slot);
      });
      if (!inTheWay) continue;
      s.path = leaving ? liftOutOfDock(s.x, s.at) : [{ ...NET.dock.slots[s.at.slot].pos, crane: 'dock' }];
      s.next = undefined;
      s.currentTo = s.at;
    }
  }

  update(dt: number): void {
    this.liftOver();
    const allowed = this.claimCells(BELT_SPEED * dt);
    const blocked = new Set([...allowed].filter(([, d]) => d <= 0).map(([id]) => id));
    for (const [id, s] of this.sprites) {
      if (!blocked.has(id)) s.waited = 0;
      else s.waited = (s.waited ?? 0) + dt;
    }
    // Belt sections advance exactly as far as the crates they carry (see belts.ts SECTION).
    const carried = new Map<string, number>();

    for (const [id, s] of this.sprites) {
      const was = { x: s.x, y: s.y };
      const cellBefore = this.heldBy(id) || away(s) ? undefined : this.occupiedCell(id, s);
      let budget = Math.min(BELT_SPEED * dt, allowed.get(id) ?? Infinity);
      while (budget > 0 && (s.path.length || s.next)) {
        if (!s.path.length && s.next) {
          s.path = s.next.path;
          s.currentTo = s.next.to;
          s.next = undefined;
        }
        const p = s.path[0];
        if (p.crane) {
          // Wait (belt stopped) until the crane comes over, picks the crate up and sets it down. Crates for the
          // wagon also wait for the train to be at the freight station.
          const intoWagon = p.crane === 'freight' && p.x === FREIGHT.wagon.x && p.y === FREIGHT.wagon.y;
          if (!intoWagon || this.train.atFactory) this.craneFor(p.crane).request(id, this.dropPoint(id, s, p, intoWagon));
          break;
        }
        const dx = p.x - s.x;
        const dy = p.y - s.y;
        const d = Math.hypot(dx, dy);
        if (d <= budget) {
          s.x = p.x;
          s.y = p.y;
          s.path.shift();
          budget -= d;
        } else {
          s.x += (dx / d) * budget;
          s.y += (dy / d) * budget;
          budget = 0;
        }
      }
      const moved = Math.hypot(s.x - was.x, s.y - was.y);
      const cellAfter = moved > 0 && !this.heldBy(id) && !away(s) ? this.occupiedCell(id, s) : undefined;
      // The belt it rode carries it, both where it started and where it ended up (it may have crossed onto another).
      for (const cell of moved > 0 && cellAfter !== undefined ? new Set([cellBefore, cellAfter]) : []) {
        if (cell === undefined) continue;
        const { track, s: at } = CELLS[cell];
        // The stretch of belt under the crate: sections whose middle lies under it (round a corner, too).
        const here = track.at(at);
        track.sections().forEach(([a, b], i) => {
          if (b < at - CRATE_W || a > at + CRATE_W) return;
          const mid = track.at((a + b) / 2);
          const under = (a <= at && at <= b) || (Math.abs(mid.x - here.x) < CRATE_W / 2 && Math.abs(mid.y - here.y) < CRATE_H / 2);
          if (!under) return;
          const k = sectionKey(track, i);
          carried.set(k, Math.max(carried.get(k) ?? 0, moved));
        });
      }
      const level = this.pileLevel(s);
      const lift = s.lift ?? level;
      s.lift = Math.abs(level - lift) <= dt * 8 ? level : lift + Math.sign(level - lift) * dt * 8;
      const resting = !s.path.length && !s.next && !this.heldBy(id);
      if (this.heldBy(id) || s.x !== was.x || s.y !== was.y) s.settled = undefined;
      else if (resting && s.settled === undefined) {
        s.settled = ++this.arrivals;
      }
      if (s.phase === 'toFreight' && !s.path.length && !s.next && !this.heldBy(id) && this.train.atFactory) {
        // Lowered into the wagon: it is cargo now (and no longer part of any factory pile).
        s.phase = 'cargo';
        s.pileRank = 0;
        s.pileSize = 1;
        this.train.cargo.push(id);
        this.train.idle = 0;
      }
    }
    for (const [k, d] of carried) this.beltOffset.set(k, (this.beltOffset.get(k) ?? 0) + d);
    const crates = {
      get: (id: string) => this.sprites.get(id),
      move: (id: string, p: Point) => {
        const s = this.sprites.get(id);
        if (s) Object.assign(s, { x: p.x, y: p.y });
      },
      done: (id: string) => {
        this.release(`crane:${id}`);
        const s = this.sprites.get(id);
        // Lifted out of the wagon: its place there is free again.
        if (s && s.phase === 'floor' && s.wagonSlot !== undefined) s.wagonSlot = undefined;
        if (s?.dropLift !== undefined && s.path[0]) {
          // Set down on top of a pile: it rests at the pile's spot, drawn at the height it was lowered to.
          Object.assign(s, { x: s.path[0].x, y: s.path[0].y, lift: s.dropLift, dropLift: undefined });
        }
        if (s?.path[0]?.crane) s.path.shift();
      },
      free: (to: Point, except: string) => {
        // Setting a crate down on a belt: the crane claims that belt cell first, like a crate riding onto it would.
        const cell = cellNear(to);
        if (cell !== undefined) {
          const who = `crane:${except}`;
          if (this.claims.get(who)?.has(cell)) return true;
          const owners = this.owners();
          if (!this.cellFree(cell, who, owners)) return false;
          this.claims.set(who, new Set([cell]));
          return true;
        }
        const me = this.sprites.get(except);
        const mine = me?.at;
        // A crate lowered onto a pile aims at the pile's top; what has to be clear is the pile's own spot.
        const at = me?.dropLift !== undefined && me.path[0] ? me.path[0] : to;
        return ![...this.sprites.entries()].some(([oid, o]) => {
          if (oid === except || this.heldBy(oid) || away(o)) return false;
          // (Belt spots are claimed above.) A crate passing by on a belt is not in the way; only one sitting there is.
          if ((o.path.length || o.next) && !o.path[0]?.crane) return false;
          // Crates already stacked in the same pile spot (or the wagon) don't stop the crane adding another.
          const intoWagon = me?.wagonSlot !== undefined && me.phase === 'toFreight';
          // Anything standing in the wagon is part of its pile, including a crate waiting there to be lifted out.
          const inWagon = o.wagonSlot !== undefined || (Math.abs(o.x - FREIGHT.wagon.x) < TRAIN.wagonW / 2 && Math.abs(o.y - FREIGHT.wagon.y) < CRATE_H / 2);
          const pileMate = (mine && !o.path.length && !o.next && o.at.zone === mine.zone && o.at.slot === mine.slot) || (intoWagon && inWagon);
          return !pileMate && Math.abs(o.x - at.x) < CRATE_W - 6 && Math.abs(o.y - at.y) < CRATE_H - 6;
        });
      },
    };
    for (const crane of Object.values(this.cranes)) crane.update(dt, crates);
    this.updateWarehouse(dt);
    const gap = this.camTarget - this.camX;
    this.camX = Math.abs(gap) < 0.5 ? this.camTarget : this.camX + gap * Math.min(1, dt * 5);
  }

  private idOf(sprite: Sprite): string {
    for (const [id, s] of this.sprites) if (s === sprite) return id;
    return '';
  }

  private craneFor(zone: Area): Crane {
    return zone === 'freight' ? this.cranes.freight : zone === 'dock' ? this.cranes.dock : this.cranes.storage;
  }

  /** The crane currently holding this crate, if any. */
  private heldBy(id: string): Crane | undefined {
    const { storage, freight, dock } = this.cranes;
    for (const crane of [storage, freight, dock, this.gantry]) if (crane.holding === id) return crane;
    return undefined;
  }

  /**
   * The train and the warehouse gantry. At the freight station the train unloads crates coming home and takes on
   * archived ones; once loading stops it runs to the warehouse, where the gantry stacks its cargo and loads any
   * crates being brought back; then it returns.
   */
  private updateWarehouse(dt: number): void {
    const train = this.train;
    train.update(dt);
    train.cargo = train.cargo.filter((id) => this.sprites.has(id));
    const taken = new Set(train.cargo.map((id) => this.sprites.get(id)!.wagonSlot).filter((n) => n !== undefined));
    for (const id of train.cargo) {
      const s = this.sprites.get(id)!;
      if (s.wagonSlot === undefined) {
        let n = 0;
        while (taken.has(n)) n++;
        s.wagonSlot = n;
        taken.add(n);
      }
      if (!this.heldBy(id)) Object.assign(s, train.wagonSpot(s.wagonSlot));
    }
    for (const [id, s] of this.sprites) {
      if (s.phase !== 'yard' || this.heldBy(id)) continue;
      const spot = this.stacks.spotOf(id);
      if (spot) Object.assign(s, spot);
    }

    const onTheWay = [...this.sprites.values()].some((s) => s.phase === 'toFreight');
    if (train.atFactory) {
      // Unload from the top of the wagon's pile, one crate at a time: the next comes off once the last one has been
      // lifted out (its crane hop is done).
      const lifting = [...this.sprites.values()].some((s) => !away(s) && s.path[0]?.crane === 'freight' && Math.hypot(s.x - FREIGHT.wagon.x, s.y - FREIGHT.wagon.y) < 30);
      const top = [...train.cargo].reverse().find((cid) => this.sprites.get(cid)?.homeward);
      // It comes out over the transfer point, so a crate waiting there to go into the wagon goes in first. Deciding to
      // unload claims the transfer point for the crane straight away, so nothing rides onto it meanwhile.
      const transferBusy = [...this.sprites.values()].some((s) => !away(s) && Math.hypot(s.x - FREIGHT.transfer.x, s.y - FREIGHT.transfer.y) < CRATE_H);
      const claimTransfer = (id: string) => {
        const cell = cellNear(FREIGHT.transfer)!;
        if (!this.cellFree(cell, `crane:${id}`, this.owners())) return false;
        this.claims.set(`crane:${id}`, new Set([cell]));
        return true;
      };
      for (const id of lifting || transferBusy || !top || !claimTransfer(top) ? [] : [top]) {
        // Home: the freight crane lifts it out of the wagon onto the belt, and it heads for its spot.
        const s = this.sprites.get(id)!;
        // It keeps its wagon place until the crane has lifted it out, so nothing is set down on it meanwhile.
        Object.assign(s, { phase: 'floor', homeward: false });
        // The freight crane lifts it from where it sits in the wagon.
        s.path = [{ x: s.x, y: s.y }, ...travel({ zone: 'freight', slot: 0 }, s.at).slice(1)];
        s.next = undefined;
        s.currentTo = s.at;
        train.cargo = train.cargo.filter((cid) => cid !== id);
      }
      const wagonBusy = [...this.sprites.entries()].some(([id, s]) => !away(s) && (this.heldBy(id) === this.cranes.freight || Math.hypot(s.x - FREIGHT.wagon.x, s.y - FREIGHT.wagon.y) < 12));
      const fetchWaiting = [...this.sprites.values()].some((s) => s.phase === 'yard' && s.homeward);
      const work = train.cargo.length > 0 || fetchWaiting;
      const stillUnloading = train.cargo.some((cid) => this.sprites.get(cid)?.homeward);
      if (!onTheWay && !wagonBusy && !stillUnloading && ((work && train.idle > TRAIN_DWELL) || (!work && this.onWarehouse))) train.goTo('warehouse');
    }

    if (train.atWarehouse) {
      // Unload from the top of the wagon's pile: last loaded, first off.
      for (const id of [...train.cargo].reverse()) {
        const s = this.sprites.get(id)!;
        if (s.homeward || this.gantryJobs.has(id)) continue;
        this.stacks.place(id, this.warehouseSpot(id));
        this.gantryJobs.set(id, 'store');
        this.gantry.request(id, this.stacks.spotOf(id)!);
      }
      for (const [id, s] of this.sprites) {
        if (s.phase !== 'yard' || !s.homeward || this.gantryJobs.has(id)) continue;
        this.gantryJobs.set(id, 'fetch');
        if (s.wagonSlot === undefined) s.wagonSlot = this.nextWagonSlot(id);
        this.gantry.request(id, train.wagonSpot(s.wagonSlot));
      }
      if (!this.gantry.busy && !this.gantryJobs.size) {
        // Crates coming home, or archived crates waiting at the freight station, call it back; otherwise an idle
        // train simply follows you to whichever page you're looking at.
        const bringingBack = train.cargo.some((id) => this.sprites.get(id)?.homeward);
        const needed = bringingBack || onTheWay;
        if ((needed && train.idle > TRAIN_DWELL) || (!train.cargo.length && !this.onWarehouse)) {
          train.goTo('factory');
          // Recalls are usually one at a time: follow the crate home (once the train is mostly off this page).
          this.followHome = bringingBack && this.onWarehouse;
        }
      }
    }
    if (this.followHome && (!this.onWarehouse || train.heading >= 0)) this.followHome = false;
    if (this.followHome && train.x < WAREHOUSE_X) {
      this.followHome = false;
      this.onFollowTrain?.('factory');
    }

    this.gantry.update(dt, {
      get: (id) => this.sprites.get(id),
      move: (id, p) => {
        const s = this.sprites.get(id);
        if (s) Object.assign(s, { x: p.x, y: p.y });
      },
      done: (id) => {
        const job = this.gantryJobs.get(id);
        this.gantryJobs.delete(id);
        const s = this.sprites.get(id);
        if (!s) return;
        if (job === 'store') {
          s.phase = 'yard';
          s.wagonSlot = undefined;
          train.cargo = train.cargo.filter((cid) => cid !== id);
          // Brought back while it was being stacked: it waits for the next fetch.
        } else if (job === 'fetch') {
          this.stacks.remove(id);
          s.phase = 'cargo';
          train.cargo.push(id);
        }
        train.idle = 0;
      },
      free: () => true,
    });
  }

  hit(p: Point): string | null {
    for (const [id, s] of this.drawOrder().reverse()) {
      if (s.phase === 'toFreight' || s.phase === 'cargo') continue;
      const { x, y } = this.pileOffset(s);
      if (Math.abs(p.x - x) <= CRATE_W / 2 + 3 && Math.abs(p.y - y) <= CRATE_H / 2 + 3) return id;
    }
    return null;
  }

  private drawOrder(): [string, Sprite][] {
    // Warehouse stacks draw bottom crate first, so higher crates sit on top of lower ones.
    const key = ([id, s]: [string, Sprite]) => {
      const w = s.phase === 'yard' && !this.heldBy(id) ? this.stacks.where(id) : undefined;
      if (w) return stackSpot(w.index, 0).y + w.level * 0.01;
      // Crates in the wagon pile up too: the floor of the wagon, then loading order (last loaded in front).
      if (s.phase === 'cargo' && !this.heldBy(id)) return TRAIN.wagonY + (s.wagonSlot ?? 0) * 0.01;
      // Crates resting in a factory pile share its spot's depth, so the pile's own order (last placed in front) decides.
      const resting = s.phase === 'floor' && !s.path.length && !s.next && !this.heldBy(id);
      return resting ? NET[s.at.zone].slots[s.at.slot].pos.y : s.y;
    };
    // Crates on a crane are in the air: they always draw above the crates they pass over.
    const lifted = ([id]: [string, Sprite]) => (this.heldBy(id) ? 1 : 0);
    return [...this.sprites.entries()].sort((a, b) => lifted(a) - lifted(b) || key(a) - key(b) || b[1].pileRank - a[1].pileRank);
  }

  /** The other crates actually resting in this crate's pile spot (not ones still on their way to it). */
  private restingPileMates(s: Sprite): Sprite[] {
    return [...this.sprites.values()].filter(
      (o) => o !== s && o.phase === 'floor' && o.at.zone === s.at.zone && o.at.slot === s.at.slot && !o.path.length && !o.next,
    );
  }

  /** Buried: another crate already rests on top of it (a crate merely on its way to the pile doesn't count yet). */
  private covered(s: Sprite): boolean {
    return s.pileRank > 0 && this.restingPileMates(s).some((o) => o.pileRank < s.pileRank);
  }

  /** How high in its pile a crate should sit, in levels (0 = on the floor). */
  private pileLevel(s: Sprite): number {
    const moving = s.path.length > 0 || !!s.next;
    // Only crates parked in a factory pile spot stack up; archived crates (train, warehouse) never do.
    // Rank 0 is the crate placed last, on top: the pile rises from the first one placed (shown up to 4 high).
    return moving || away(s) ? 0 : Math.max(0, Math.min(s.pileSize - 1, 3) - s.pileRank);
  }

  private pileOffset(s: Sprite): Point {
    const k = s.lift ?? this.pileLevel(s);
    return { x: s.x - k * 6, y: s.y - k * 6 };
  }

  private now(): number {
    return this.serverNow + (Date.now() - this.clientAtSync);
  }

  draw(ctx: CanvasRenderingContext2D, t: number, opts: { hover: string | null; selected: string | null; terminals: boolean; pixelRatio: number }): void {
    this.drawStatic(ctx, opts.pixelRatio);
    ctx.save();
    ctx.translate(-this.camX, 0);
    for (const track of ALL_TRACKS) drawBelt(ctx, track, (i) => this.beltOffset.get(sectionKey(track, i)) ?? 0);
    for (const j of JUNCTIONS) junction(ctx, j);
    this.drawHopper(ctx, opts.terminals);
    this.drawTrain(ctx, t);
    drawOperator(ctx, t);

    const machines = this.machineStates();
    machines.forEach((m) => machineBack(ctx, m.pos, t, m.index, m.crate));
    for (const m of machines) {
      const stack = { x: m.pos.x + MACHINE_W / 2 - 18, y: m.pos.y - MACHINE_H / 2 - 16 };
      const mode = m.crate ? (m.crate.zone === 'alert' ? 'jammed' : 'working') : 'idle';
      this.smoke.source(`stack-${m.index}`, stack, mode === 'working', 'stack');
      // Blocked machines belch; one simply awaiting your reply sits quiet.
      this.smoke.source(`belch-${m.index}`, stack, mode === 'jammed' && m.crate?.alertReason !== 'asked a question', 'belch');
    }

    const q = this.highlight.trim().toLowerCase();
    for (const [id, s] of this.drawOrder()) {
      const c = this.crates.get(id);
      if (!c) continue;
      this.drawCrate(ctx, c, s, id === opts.hover, id === opts.selected);
      // Warehouse search: crates that don't match fade back.
      if (q && s.phase === 'yard' && ![c.label, c.jiraKey].some((f) => f?.toLowerCase().includes(q))) {
        fillSquircle(ctx, s.x - CRATE_W / 2 - 1, s.y - CRATE_H / 2 - 1, CRATE_W + 2, CRATE_H + 2, RADIUS.crate, 'rgba(18,16,14,0.78)');
      }
    }

    machines.forEach((m) => machineFront(ctx, m.pos, t, m.crate));
    this.drawJamTag(ctx);
    const dt = this.lastDraw ? Math.min(0.1, (t - this.lastDraw) / 1000) : 0;
    this.lastDraw = t;
    this.smoke.update(dt);
    this.smoke.draw(ctx, (x, y, size) => squirclePath(ctx, x, y, size, size, size * 0.3));
    drawCrane(ctx, this.cranes.storage, YARD.rails);
    drawCrane(ctx, this.cranes.freight, FREIGHT.rails);
    drawCrane(ctx, this.cranes.dock, DOCK_CRANE.rails);
    drawCrane(ctx, this.gantry, STACKS.rails);
    this.drawBadges(ctx);
    ctx.restore();
  }

  /**
   * Live tags beside the assembly hall title while machines wait on you: red for sessions blocked on a prompt
   * (permission, the question tool), yellow for ones whose last message asked you something in plain text.
   */
  private drawJamTag(ctx: CanvasRenderingContext2D): void {
    const waiting = [...this.crates.values()].filter((c) => !c.archived && c.zone === 'alert');
    const asked = waiting.filter((c) => c.alertReason === 'asked a question').length;
    const blocked = waiting.length - asked;
    const tags = [
      ...(blocked ? [{ label: `${blocked} jammed · blocked on you`, fill: C.alert, ink: '#fff' }] : []),
      ...(asked ? [{ label: `${asked} awaiting your reply`, fill: C.awaiting, ink: '#1c1917' }] : []),
    ];
    if (!tags.length) return;
    const a = AREAS.working;
    ctx.font = '800 13px system-ui, sans-serif';
    let left = a.x + 16 + ctx.measureText(a.title).width + 30;
    ctx.font = '800 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (const tag of tags) {
      const w = ctx.measureText(tag.label).width + 16;
      fillSquircle(ctx, left, a.y + 13, w, 22, RADIUS.small, tag.fill);
      ctx.fillStyle = tag.ink;
      ctx.fillText(tag.label, left + 8, a.y + 28);
      left += w + 8;
    }
  }

  private machineStates(): { pos: Point; index: number; crate?: CrateView }[] {
    return NET.working.slots.map((slot, index) => {
      const entry = [...this.sprites.entries()].find(([, s]) => s.phase === 'floor' && s.at.zone === 'working' && s.at.slot === index && s.pileRank === 0 && !s.path.length && !s.next);
      return { pos: slot.pos, index, crate: entry ? this.crates.get(entry[0]) : undefined };
    });
  }

  /** Scenery that never changes is painted once into an offscreen canvas per size. */
  private drawStatic(ctx: CanvasRenderingContext2D, ratio: number): void {
    const key = `${ctx.canvas.width}x${ctx.canvas.height}`;
    if (!this.staticLayer || this.staticKey !== key) {
      const layer = document.createElement('canvas');
      layer.width = Math.round(ctx.canvas.width * (WORLD_W / W));
      layer.height = ctx.canvas.height;
      const g = layer.getContext('2d')!;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintScenery(g);
      paintWarehouse(g);
      this.staticLayer = layer;
      this.staticKey = key;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticLayer, -Math.round(this.camX * ratio), 0);
    ctx.restore();
  }

  private drawHopper(ctx: CanvasRenderingContext2D, clickable: boolean): void {
    const { x, y, w, h } = HOPPER;
    const cx = x + w / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 5;
    ctx.beginPath();
    ctx.moveTo(x, y + 5);
    ctx.bezierCurveTo(x, y + 1, x + 1, y, x + 5, y);
    ctx.lineTo(x + w - 5, y);
    ctx.bezierCurveTo(x + w - 1, y, x + w, y + 1, x + w, y + 5);
    ctx.bezierCurveTo(x + w, y + h * 0.55, cx + 34, y + h * 0.6, cx + 32, y + h);
    ctx.lineTo(cx - 32, y + h);
    ctx.bezierCurveTo(cx - 34, y + h * 0.6, x, y + h * 0.55, x, y + 5);
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, C.machineTop);
    grad.addColorStop(1, C.machineBottom);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    fillSquircle(ctx, x - 3, y - 4, w + 6, 10, RADIUS.small, C.orange);
    ctx.fillStyle = C.text;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HOPPER', cx, y + 36);
    if (clickable) {
      ctx.fillStyle = C.amber;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText('click for a new session', cx, y + 52);
    }
  }

  /** The freight train: one wagon with an engine at each end, since it shuttles both ways. */
  private drawTrain(ctx: CanvasRenderingContext2D, t: number): void {
    const a = AREAS.freight;
    const cx = this.train.x;
    const wagonX = cx - TRAIN.wagonW / 2;
    const engines = [cx - TRAIN.half, cx + TRAIN.half - 40];
    const body = ctx.createLinearGradient(0, TRAIN_Y - 22, 0, TRAIN_Y + 14);
    body.addColorStop(0, '#f6a24a');
    body.addColorStop(1, C.orangeDark);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    fillSquircle(ctx, wagonX, TRAIN_Y - 10, TRAIN.wagonW, 24, RADIUS.small, '#4a4e55');
    for (const ex of engines) fillSquircle(ctx, ex, TRAIN_Y - 18, 40, 32, RADIUS.medium, body);
    ctx.restore();
    // Cab windows face outwards; stacks sit towards the wagon.
    fillSquircle(ctx, engines[0] + 4, TRAIN_Y - 12, 13, 10, RADIUS.small, '#16181b');
    fillSquircle(ctx, engines[1] + 23, TRAIN_Y - 12, 13, 10, RADIUS.small, '#16181b');
    fillSquircle(ctx, engines[0] + 26, TRAIN_Y - 27, 8, 10, RADIUS.small, '#6b6f76');
    fillSquircle(ctx, engines[1] + 6, TRAIN_Y - 27, 8, 10, RADIUS.small, '#6b6f76');
    for (const wx of [wagonX + 16, wagonX + TRAIN.wagonW - 16, engines[0] + 10, engines[0] + 30, engines[1] + 10, engines[1] + 30]) {
      squircleAt(ctx, wx, TRAIN_Y + 15, 11);
      ctx.fillStyle = '#121315';
      ctx.fill();
    }
    // Only the engine in front, the one doing the pulling, smokes.
    this.smoke.source('engine-east', { x: engines[1] + 10, y: TRAIN_Y - 31 }, this.train.heading > 0, 'engine');
    this.smoke.source('engine-west', { x: engines[0] + 30, y: TRAIN_Y - 31 }, this.train.heading < 0, 'engine');
    ctx.fillStyle = C.dim;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${this.archivedCount} archived · click to browse`, a.x + a.w / 2, a.y + a.h - 12);
  }

  private drawCrate(ctx: CanvasRenderingContext2D, c: CrateView, s: Sprite, hover: boolean, selected: boolean): void {
    const moving = s.path.length > 0 || !!s.next;
    const off = this.pileOffset(s);
    const x = Math.round(off.x - CRATE_W / 2);
    const y = Math.round(off.y - CRATE_H / 2);
    const cx = x + CRATE_W / 2;
    // Ended sessions look dimmed wherever their crate is: parked, on a belt, on a crane or on the train.
    const parked = c.zone === 'storage';
    const buried = !moving && !away(s) && this.covered(s);

    const holder = this.heldBy(c.id);
    const lifted = holder ? holder.lift : 0;
    ctx.save();
    if (lifted) {
      // Top-down: a lifted crate is closer to the camera (bigger) and its shadow falls further away.
      const k = 1 + 0.08 * lifted;
      ctx.translate(cx, y + CRATE_H / 2);
      ctx.scale(k, k);
      ctx.translate(-cx, -(y + CRATE_H / 2));
    }
    ctx.save();
    ctx.globalAlpha = parked ? 0.62 : 1;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8 + 12 * lifted;
    ctx.shadowOffsetY = 4 + 16 * lifted;
    const body = ctx.createLinearGradient(0, y, 0, y + CRATE_H);
    body.addColorStop(0, crateColor(c.id, 58));
    body.addColorStop(1, crateColor(c.id, 38));
    fillSquircle(ctx, x, y, CRATE_W, CRATE_H, RADIUS.crate, body);
    ctx.restore();
    if (buried) {
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.globalAlpha = parked ? 0.62 : 1;
    ctx.strokeStyle = crateColor(c.id, 26);
    ctx.lineWidth = 2.5;
    squirclePath(ctx, x + 1.5, y + 1.5, CRATE_W - 3, CRATE_H - 3, RADIUS.crate - 1);
    ctx.stroke();
    fillSquircle(ctx, x + 6, y + 7, CRATE_W - 12, CRATE_H - 14, RADIUS.medium, 'rgba(14,12,10,0.8)');
    ctx.fillStyle = '#fff';
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const lines = wrap(ctx, c.label, CRATE_W - 22, 2);
    const top = y + CRATE_H / 2 - (lines.length - 1) * 7 + 4;
    lines.forEach((l, i) => ctx.fillText(l, cx, top + i * 14));
    ctx.restore();
    if (holder) {
      ctx.save();
      ctx.strokeStyle = 'rgba(147,197,253,0.6)';
      ctx.shadowColor = '#60a5fa';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2;
      squirclePath(ctx, x - 2, y - 2, CRATE_W + 4, CRATE_H + 4, RADIUS.crate + 1);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    if (selected || hover) {
      ctx.strokeStyle = selected ? C.amber : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      squirclePath(ctx, x - 5, y - 5, CRATE_W + 10, CRATE_H + 10, RADIUS.crate + 3);
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    if (c.jiraKey && c.jiraKey !== c.label && (!moving || hover)) {
      ctx.font = '700 10px ui-monospace, monospace';
      const w = ctx.measureText(c.jiraKey).width + 12;
      fillSquircle(ctx, cx - w / 2, y + CRATE_H + 3, w, 15, RADIUS.small, 'rgba(14,12,10,0.75)');
      ctx.fillStyle = C.text;
      ctx.fillText(c.jiraKey, cx, y + CRATE_H + 14);
    }
  }

  /** Crate badges (SHIP? everywhere; pile count and wait time when parked), drawn last so nothing covers them. */
  private drawBadges(ctx: CanvasRenderingContext2D): void {
    for (const [id, s] of this.drawOrder()) {
      const c = this.crates.get(id);
      const parked = !s.path.length && !s.next && !this.heldBy(id);
      if (!c || s.phase !== 'floor' || (parked && this.covered(s))) continue;
      const top = this.pileOffset(s);
      const x = Math.round(top.x - CRATE_W / 2);
      const y = Math.round(top.y - CRATE_H / 2);
      const cx = x + CRATE_W / 2;
      ctx.textAlign = 'center';
      const under = parked ? this.restingPileMates(s).filter((o) => o.pileRank > s.pileRank).length : 0;
      if (under > 0) {
        const label = `+${under}`;
        ctx.font = '800 10px system-ui, sans-serif';
        const w = ctx.measureText(label).width + 10;
        fillSquircle(ctx, x - 8, y - 8, w, 16, RADIUS.small, '#e5e7eb');
        ctx.fillStyle = '#111';
        ctx.fillText(label, x - 8 + w / 2, y + 4);
      }
      if (parked && c.zone === 'dock') {
        ctx.fillStyle = C.dim;
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(`waiting ${minutes(this.now() - c.zoneSince)}`, cx, y - 6);
      }
      // "Ready to ship" belongs to the session, so it travels with the crate.
      if (c.readyToShip) {
        fillSquircle(ctx, x + CRATE_W - 26, y - 9, 36, 15, RADIUS.small, C.ship);
        ctx.fillStyle = '#052e22';
        ctx.font = '800 9px system-ui, sans-serif';
        ctx.fillText('SHIP?', x + CRATE_W - 8, y + 2);
      }
    }
  }
}

/**
 * A rerouted path must carry on from exactly where the kept part ends (or from the crate itself): crates never
 * jump. Rerouting that would break that is refused and the crate finishes its current trip instead.
 */
function joins(s: Point, kept: Point[], next: Point[]): boolean {
  const from = kept.length ? kept[kept.length - 1] : s;
  return next.length > 0 && Math.hypot(next[0].x - from.x, next[0].y - from.y) < 3;
}