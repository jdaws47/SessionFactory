import type { CrateView } from '../src/shared/types';
import { ALL_TRACKS, BELT_SPEED, FREIGHT, fromHopper, fromLoop, onwardFrom, HOPPER_DROP, JUNCTIONS, LOOP, NET, type SlotRef, type Track, travel, type Waypoint, YARD } from './belts';
import { AREAS, type Area, CRATE_H, CRATE_W, floorArea, H, HOPPER, MACHINE_H, MACHINE_W, OPERATOR, type Point, TRAIN_Y, W } from './layout';
import { Crane } from './crane';
import { Smoke } from './smoke';
import { STACKS, Stacks, stackSpot, Train, TRAIN, WAREHOUSE_X, WORLD_W } from './warehouse';
import { squircleAt, squirclePath } from './shapes';

const C = {
  floorTop: '#1d1915',
  floorBottom: '#120f0d',
  concrete: '#2b2d31',
  concreteSeam: '#25272b',
  concreteEdge: '#3d4047',
  orange: '#f28c28',
  orangeDark: '#b45f13',
  amber: '#f6b545',
  text: '#ece4d8',
  dim: '#9b9286',
  rail: '#4a4e55',
  railLight: '#5f646c',
  beltSurface: '#141517',
  section: '#34363c',
  machineTop: '#565c66',
  machineBottom: '#30343a',
  alert: '#ef4444',
  awaiting: '#facc15',
  ship: '#34d399',
  plant: '#2f7466',
  plantTip: '#62d1b2',
  rock: '#2c2723',
};

/** Squircle radii: crates stay soft; everything else is only gently rounded. */
const RADIUS = { crate: 14, small: 4, medium: 7, large: 12 };

interface Leg {
  path: Waypoint[];
  to: SlotRef;
}

interface Sprite {
  x: number;
  y: number;
  /** Where the crate is heading (or sits); used to keep slots sticky. */
  at: SlotRef;
  /** Where the trip it is on right now ends. */
  currentTo: SlotRef;
  path: Waypoint[];
  /** At most one trip is queued behind the current one, so rapid state changes never pile up detours. */
  next?: Leg;
  leaving: boolean;
  /** Seconds into being lowered into the freight wagon (archived crates only). */
  loading?: number;
  /** Archived crates: riding the train ('cargo') or parked on a warehouse stack ('yard'). */
  stage?: 'cargo' | 'yard';
  /** Brought back from the warehouse: rides the train home, then heads for `at`. */
  returning?: boolean;
  /** Fixed place in the wagon while riding the train, so crates don't shuffle when another is unloaded. */
  wagonSlot?: number;
  pileRank: number;
  pileSize: number;
  /** Order in which it came to rest where it is (undefined while moving): piles stack by it, last in on top. */
  settled?: number;
  /** Pile level a crate lowered by crane onto a factory pile lands at (set while the crane carries it). */
  dropLift?: number;
  /** Height in its pile as drawn (levels), easing towards its place so a crate is lifted onto the pile, not teleported. */
  lift?: number;
  /** Seconds spent waiting for the way to clear; past PATIENCE the crate eases through rather than gridlock. */
  waited?: number;
}

const LOAD_SECONDS = 0.8;
/** Seconds the train waits after its last crate is loaded (or unloaded) before setting off. */
const TRAIN_DWELL = 1;
const PATIENCE = 2.5;
const LOAD_DROP = 6;

/** Stable colour per crate (sessions roam across repos, so the directory is no use for this). */
export function crateColor(id: string, light = 52): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 50%, ${light}%)`;
}

function minutes(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60 ? `${m % 60}m` : ''}` : `${Math.floor(h / 24)}d`;
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Splits text into at most `lines` lines that fit `width`, ellipsising the last. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= width) {
      line = next;
      continue;
    }
    if (line) out.push(line);
    line = words[i];
    if (out.length === lines - 1) {
      line = words.slice(i).join(' ');
      break;
    }
  }
  if (line) out.push(line);
  return out.slice(0, lines).map((l, i, arr) => {
    if (i < arr.length - 1 || ctx.measureText(l).width <= width) return l;
    let cut = l;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
    return `${cut}…`;
  });
}

/** Deterministic pseudo-random numbers so scenery stays put between reloads. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

function fillSquircle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient): void {
  squirclePath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

const QUEUE_ZONES = new Set<Area>(['dock', 'intake']);

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
  private running = new Set<string>([sectionKey(LOOP, 0)]);
  /** The storage yard's crane; it carries crates between the belt and the yard and parks at home. */
  /** Physical order of crates on the dock belt, front first. */
  private dockQueue: string[] = [];
  /** Crates going round the dock recycle loop: 'out' until they reach the recycle belt, then 'round'. */
  private recycling = new Map<string, 'out' | 'round'>();
  /** Crates told to leave while still riding the dock belt in: they settle first, then depart. */
  private pendingLeave = new Set<string>();
  private lastCrates: CrateView[] = [];
  private cranes = { storage: new Crane(YARD.home), freight: new Crane(FREIGHT.home) };
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

  setCrates(crates: CrateView[], now: number): void {
    const first = this.crates.size === 0 && this.sprites.size === 0;
    this.serverNow = now;
    this.clientAtSync = Date.now();
    this.crates = new Map(crates.map((c) => [c.id, c]));
    this.lastCrates = crates;
    this.archivedCount = crates.filter((c) => c.archived).length;
    const dockBelt = NET.dock.track;

    const byZone = new Map<Area, CrateView[]>();
    for (const c of crates) {
      if (c.archived) continue;
      let area = floorArea(c.zone, c.turns);
      const existing = this.sprites.get(c.id);
      if (area === 'intake' && existing && !existing.leaving && existing.at.zone !== 'intake') area = 'dock';
      // Already riding the dock belt in: it keeps its place until it has settled, then leaves (see update()).
      const ridingIn = existing && !existing.leaving && existing.at.zone === 'dock' && existing.path[0]?.track === dockBelt;
      if (area !== 'dock' && ridingIn) {
        this.pendingLeave.add(c.id);
        area = 'dock';
      } else this.pendingLeave.delete(c.id);
      byZone.set(area, [...(byZone.get(area) ?? []), c]);
    }

    const docked = [...(byZone.get('dock') ?? [])].sort((a, b) => a.zoneSince - b.zoneSince);
    // A crate joins the dock queue when it physically rolls onto the dock belt (see update()), so the queue
    // always matches the order crates sit on the belt. Crates still on their way are not in it yet.
    const stillDocked = new Set(docked.map((c) => c.id));
    this.dockQueue = this.dockQueue.filter((id) => {
      if (stillDocked.has(id)) return true;
      const s = this.sprites.get(id);
      return !(s && s.path.findIndex((w) => w.track === dockBelt) > 0);
    });
    const onDock = (id: string) => {
      const s = this.sprites.get(id);
      if (!s) return first;
      return !s.leaving && s.at.zone === 'dock' && (s.path[0]?.track === dockBelt || s.path[0]?.track === NET.dock.recycle?.track || (!s.path.length && !s.next));
    };
    // On the very first layout every docked crate is already in place; after that, crates join the queue only
    // as they roll onto the dock belt (update()), and crates going round the recycle loop are out of it.
    const joining = first ? docked.map((c) => c.id).filter((id) => !this.dockQueue.includes(id) && onDock(id)) : [];
    // Everything in the queue sits on the main dock belt, so its order is simply belt position, front first.
    const along = (id: string) => {
      const sp = this.sprites.get(id);
      return sp ? NET.dock.track.project(sp) : 0;
    };
    this.dockQueue.sort((a, b) => along(b) - along(a));
    // The belt only exits past the front, so crates physically ahead of the rearmost departing crate must make
    // way round the recycle loop. To keep the queue's order, the crates behind it follow them round too.
    // Crates stacked in the same pile spot are not ahead of it; if nobody is ahead, the rest just move up.
    const departing = this.dockQueue.filter((id) => !stillDocked.has(id));
    const rearmost = departing.length ? Math.min(...departing.map(along)) : Infinity;
    const ahead = this.dockQueue.some((id) => stillDocked.has(id) && along(id) > rearmost + 6);
    const makeWay = ahead ? this.dockQueue.filter((id) => stillDocked.has(id)) : [];
    const reordered = { loopers: makeWay };
    this.dockQueue = [...this.dockQueue.filter((id) => stillDocked.has(id) && !makeWay.includes(id)), ...joining.filter((id) => !this.dockQueue.includes(id))];
    for (const id of makeWay) this.recycling.set(id, 'out');
    const loopers = new Set(reordered.loopers);

    for (const [zone, list] of byZone) {
      const assigned = QUEUE_ZONES.has(zone) ? this.queueSlots(zone, list) : this.stickySlots(zone, list);
      const piles = new Map<number, CrateView[]>();
      for (const c of list) piles.set(assigned.get(c.id)!, [...(piles.get(assigned.get(c.id)!) ?? []), c]);
      for (const [slot, pile] of piles) {
        pile.sort((a, b) => this.stackingOrder(b, { zone, slot }) - this.stackingOrder(a, { zone, slot }) || b.zoneSince - a.zoneSince);
        pile.forEach((c, rank) => this.place(c, { zone, slot }, first, rank, pile.length, loopers.has(c.id)));
        // On the first layout everything is already in place: the pile's arrival order is its stacking order.
        if (first) for (const c of [...pile].reverse()) this.sprites.get(c.id)!.settled = ++this.arrivals;
      }
    }

    for (const [id, s] of this.sprites) {
      const c = this.crates.get(id);
      if (!c) {
        this.sprites.delete(id);
        this.stacks.remove(id);
      } else if (c.archived && !s.leaving && !s.stage) {
        this.go(s, { zone: 'freight', slot: 0 });
        s.leaving = true;
        s.pileRank = 0;
        s.pileSize = 1;
      } else if (c.archived && s.returning) {
        s.returning = false;
      }
    }
    // Archived crates the floor has never seen (first load, history import) are already in the warehouse.
    for (const c of crates) {
      if (!c.archived || this.sprites.has(c.id)) continue;
      const spot = this.stacks.place(c.id);
      const pos = stackSpot(spot.index, spot.level);
      this.sprites.set(c.id, { ...pos, at: { zone: 'freight', slot: 0 }, currentTo: { zone: 'freight', slot: 0 }, path: [], leaving: true, stage: 'yard', pileRank: 0, pileSize: 1 });
    }
  }

  /** Called when the view should follow the train (set by main so the UI updates too). */
  onFollowTrain?: (where: 'factory' | 'warehouse') => void;
  /** A recalled crate's train has left the warehouse while you watched; follow it once it crosses the page edge. */
  private followHome = false;
  /** Counts crates coming to rest, to order piles by arrival. */
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

  /**
   * Dock and intake are queues on the belt itself: order decides position, the back of the queue piles up.
   * The dock keeps its physical order, so crates that looped round to let one out stay at the back.
   */
  private queueSlots(zone: Area, list: CrateView[]): Map<string, number> {
    const cap = NET[zone].slots.length;
    if (zone !== 'dock') {
      const ordered = [...list].sort((a, b) => a.startedAt - b.startedAt);
      return new Map(ordered.map((c, i) => [c.id, Math.min(i, cap - 1)]));
    }
    // Crates in the queue take their place in it; crates still on their way head for the back for now.
    const rank = new Map(this.dockQueue.map((id, i) => [id, i]));
    const back = Math.min(this.dockQueue.length, cap - 1);
    return new Map(list.map((c) => [c.id, rank.has(c.id) ? Math.min(rank.get(c.id)!, cap - 1) : back]));
  }

  /** Machines, alert spots and storage spots keep their crate until it leaves; extras pile on the last spot. */
  private stickySlots(zone: Area, list: CrateView[]): Map<string, number> {
    const cap = NET[zone].slots.length;
    const used = new Set<number>();
    const out = new Map<string, number>();
    const rest: CrateView[] = [];
    for (const c of [...list].sort((a, b) => a.zoneSince - b.zoneSince)) {
      const s = this.sprites.get(c.id);
      // The bottom of each pile (or a crate alone in its spot) keeps it; crates piled on top are what move.
      if (s && !s.leaving && s.at.zone === zone && !used.has(s.at.slot) && s.pileRank === s.pileSize - 1) {
        used.add(s.at.slot);
        out.set(c.id, s.at.slot);
      } else rest.push(c);
    }
    // Last in, first out: crates already piled here take free spots newest (top) first; arrivals follow in order.
    const piled = (c: CrateView) => this.sprites.get(c.id)?.at.zone === zone && !this.sprites.get(c.id)!.leaving;
    for (const c of [...rest.filter(piled).reverse(), ...rest.filter((c) => !piled(c))]) {
      let slot = 0;
      while (slot < cap && used.has(slot)) slot++;
      if (slot >= cap) slot = cap - 1;
      used.add(slot);
      out.set(c.id, slot);
    }
    return out;
  }

  private place(c: CrateView, to: SlotRef, instant: boolean, pileRank: number, pileSize: number, lap = false): void {
    let s = this.sprites.get(c.id);
    if (!s) {
      const pos = NET[to.zone].slots[to.slot].pos;
      if (instant) {
        s = { ...pos, at: to, currentTo: to, path: [], leaving: false, pileRank, pileSize };
      } else if (c.reactivationCount > 0) {
        s = { x: FREIGHT.wagon.x, y: FREIGHT.wagon.y, at: to, currentTo: to, path: travel({ zone: 'freight', slot: 0 }, to), leaving: false, pileRank, pileSize };
      } else {
        s = { x: HOPPER_DROP.x, y: HOPPER.y + HOPPER.h - CRATE_H / 2, at: to, currentTo: to, path: fromHopper(to), leaving: false, pileRank, pileSize };
      }
      this.sprites.set(c.id, s);
      return;
    }
    if (s.stage) {
      // In the warehouse or on the train: it comes home by train first (see updateWarehouse()).
      s.at = to;
      s.returning = true;
      s.pileRank = pileRank;
      s.pileSize = pileSize;
      return;
    }
    if (s.leaving) {
      // Still on its way to freight: just turn it round.
      s.leaving = false;
      s.loading = undefined;
    }
    s.pileRank = pileRank;
    s.pileSize = pileSize;
    if (lap || s.at.zone !== to.zone || s.at.slot !== to.slot) this.go(s, to, lap);
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
    const below = [...this.sprites.entries()].filter(([oid, o]) => oid !== id && !o.stage && !o.leaving && !o.path.length && !o.next && o.at.zone === s.at.zone && o.at.slot === s.at.slot).length;
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

  /** Where a crate goes in its pile: crates at rest by when they arrived, anything still on its way on top. */
  private stackingOrder(c: CrateView, pile: SlotRef): number {
    const s = this.sprites.get(c.id);
    const here = s && s.at.zone === pile.zone && s.at.slot === pile.slot;
    return !here || s.path.length || s.next || this.heldBy(c.id) ? Infinity : (s.settled ?? Infinity);
  }

  /** Re-stacks the pile at a spot after a crate comes to rest in it, so the newest arrival is on top. */
  private restack(at: SlotRef): void {
    const pile = [...this.sprites.values()].filter((s) => !s.leaving && !s.stage && s.at.zone === at.zone && s.at.slot === at.slot);
    pile.sort((a, b) => (b.settled ?? Infinity) - (a.settled ?? Infinity));
    pile.forEach((s, rank) => Object.assign(s, { pileRank: rank, pileSize: pile.length }));
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

  private go(s: Sprite, to: SlotRef, lap = false): void {
    const same = (a: SlotRef, b: SlotRef) => a.zone === b.zone && a.slot === b.slot;
    // Riding along the dock belt and given a different spot further along it: just stop there instead.
    const dockBelt = NET.dock.track;
    const here = dockBelt.project(s);
    const onDockBelt = Math.hypot(dockBelt.at(here).x - s.x, dockBelt.at(here).y - s.y) < 2 && s.path[0]?.track !== NET.dock.recycle?.track;
    if (s.currentTo.zone === 'dock' && to.zone === 'dock' && !lap && onDockBelt && (s.path.length || s.next)) {
      const spot = NET.dock.slots[to.slot];
      if (spot.kind === 'track' && spot.s >= here) {
        s.path = [...dockBelt.between(here, spot.s).map((p) => ({ x: p.x, y: p.y, track: dockBelt })), spot.pos];
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
    if (hop && into.kind === 'crane' && hop.x === into.pos.x && hop.y === into.pos.y && joins(s, s.path.slice(0, craneAt), onward) && this.craneFor(s.currentTo.zone).cancel(this.idOf(s))) {
      s.path = [...s.path.slice(0, craneAt), ...onward];
      s.dropLift = undefined;
      if (!s.stage) s.wagonSlot = undefined;
      s.next = undefined;
      s.currentTo = to;
      s.at = to;
      return;
    }
    // Still riding the loop towards another zone, and the new zone's turn-off is coming up first: take it.
    const early = s.currentTo.zone !== to.zone ? this.turnOffAhead(s, to) : undefined;
    if (early) {
      s.path = early;
      s.next = undefined;
      s.currentTo = to;
      s.at = to;
      return;
    }
    // Heading for the dock from the main loop and not in yet: carry on round the loop instead of entering. (A crate
    // already in the dock, e.g. going round its recycle loop, never qualifies: it finishes its trip first.)
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
      s.path = travel(s.currentTo, to, lap);
      s.currentTo = to;
    } else {
      s.next = same(s.currentTo, to) && !lap ? undefined : { path: travel(s.currentTo, to, lap), to };
    }
    s.at = to;
  }

  /**
   * Crates that must wait this frame because another crate is in the way a short distance along their route
   * (merges, catching up, joining a queue). Crates in the same pile and crates on a crane never block. When two
   * crates block each other, a fixed order lets exactly one go, so nothing waits forever.
   */
  /** Crates held back by a crane's reserved set-down spot: those never ease through (see update()). */
  private craneBlocked = new Set<string>();

  private blockedCrates(): Set<string> {
    const LOOK = 30;
    const STEP = 6;
    const held = new Set(Object.values(this.cranes).map((c) => c.holding));
    const moving = (s: Sprite) => s.path.length > 0 || !!s.next;
    const rect = (x: number, y: number) => ({ x: x - CRATE_W / 2 + 3, y: y - CRATE_H / 2 + 3, w: CRATE_W - 6, h: CRATE_H - 6 });
    const hits = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const solid = [...this.sprites.entries()].filter(([id, s]) => !held.has(id) && s.loading === undefined && !s.stage);
    // Spots a crane is going to set a crate down on count as occupied for everyone else.
    const reserved = Object.values(this.cranes).flatMap((c) => c.reserved);
    const blockers = new Map<string, Set<string>>();
    for (const [id, s] of solid) {
      if (!moving(s)) continue;
      const path = s.path.length ? s.path : s.next!.path;
      if (path[0]?.crane) continue;
      // Points a little way along the route, never past where this trip ends.
      const probes: { x: number; y: number }[] = [];
      let from = { x: s.x, y: s.y };
      let left = LOOK;
      for (const p of path) {
        const d = Math.hypot(p.x - from.x, p.y - from.y);
        for (let t = STEP; t <= Math.min(d, left); t += STEP) probes.push({ x: from.x + ((p.x - from.x) * t) / d, y: from.y + ((p.y - from.y) * t) / d });
        left -= d;
        if (left <= 0 || p.crane) break;
        from = p;
      }
      const here = rect(s.x, s.y);
      for (const [oid, o] of solid) {
        if (oid === id) continue;
        const other = rect(o.x, o.y);
        // Stationary crates already touching this one are its pile-mates (or the spot it is leaving).
        if (!moving(o) && hits(here, other)) continue;
        if (!moving(o) && o.at.zone === s.at.zone && o.at.slot === s.at.slot) continue;
        if (probes.some((q) => hits(rect(q.x, q.y), other))) blockers.set(id, (blockers.get(id) ?? new Set()).add(oid));
      }
      for (const r of reserved) {
        if (r.id === id) continue;
        const spot = rect(r.to.x, r.to.y);
        // Held back if it would move (further) onto the spot; a crate already on it and moving away is let go.
        const gap = (p: Point) => Math.hypot(p.x - r.to.x, p.y - r.to.y);
        if (probes.some((q) => hits(rect(q.x, q.y), spot) && gap(q) < gap(s))) blockers.set(id, (blockers.get(id) ?? new Set()).add(`crane:${r.id}`));
      }
    }
    const blocked = new Set<string>();
    this.craneBlocked = new Set([...blockers].filter(([, by]) => [...by].some((b) => b.startsWith('crane:'))).map(([id]) => id));
    for (const [id, by] of blockers) {
      if ([...by].some((oid) => !(blockers.get(oid)?.has(id) && id < oid))) blocked.add(id);
    }
    return blocked;
  }

  /** A crate riding the dock belt towards a stale spot is pointed at its current spot, if that is ahead of it. */
  private retargetOnDockBelt(id: string, s: Sprite): void {
    if (s.at.zone !== 'dock' || s.currentTo.zone !== 'dock' || (s.currentTo.slot === s.at.slot && !s.next) || this.recycling.has(id)) return;
    const belt = NET.dock.track;
    const here = belt.project(s);
    const q = belt.at(here);
    const spot = NET.dock.slots[s.at.slot];
    if (Math.hypot(q.x - s.x, q.y - s.y) > 2 || spot.kind !== 'track' || spot.s < here || (!s.path.length && !s.next)) return;
    s.path = [...belt.between(here, spot.s).map((p) => ({ x: p.x, y: p.y, track: belt })), spot.pos];
    s.next = undefined;
    s.currentTo = s.at;
  }

  update(dt: number): void {
    for (const [id, s] of this.sprites) this.retargetOnDockBelt(id, s);
    const blocked = this.blockedCrates();
    for (const [id, s] of this.sprites) {
      if (!blocked.has(id)) s.waited = 0;
      // Patience settles stand-offs between crates; a spot a crane is about to set a crate on is never eased into,
      // or the crane would hover over it forever while the crate waits for that same crane.
      else if ((s.waited = (s.waited ?? 0) + dt) > PATIENCE && !this.craneBlocked.has(id)) blocked.delete(id);
    }
    this.running = new Set([sectionKey(LOOP, 0)]);
    for (const [id, s] of this.sprites) {
      if ((!s.path.length && !s.next) || blocked.has(id)) continue;
      const target = s.path[0] ?? s.next?.path[0];
      const belt = target?.track;
      if (belt && !target?.crane) this.running.add(sectionKey(belt, belt.sectionOf(belt.project(s))));
    }
    for (const k of this.running) this.beltOffset.set(k, (this.beltOffset.get(k) ?? 0) + BELT_SPEED * dt);

    for (const [id, s] of this.sprites) {
      let budget = blocked.has(id) ? 0 : BELT_SPEED * dt;
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
      const level = this.pileLevel(s);
      const lift = s.lift ?? level;
      s.lift = Math.abs(level - lift) <= dt * 8 ? level : lift + Math.sign(level - lift) * dt * 8;
      const resting = !s.path.length && !s.next && !this.heldBy(id);
      if (!resting) s.settled = undefined;
      else if (s.settled === undefined) {
        s.settled = ++this.arrivals;
        if (!s.leaving && !s.stage) this.restack(s.at);
      }
      if (s.leaving && !s.stage && !s.path.length && !s.next && !this.heldBy(id) && this.train.atFactory) {
        // Lowered into the wagon: it is cargo now (and no longer part of any factory pile).
        s.stage = 'cargo';
        s.pileRank = 0;
        s.pileSize = 1;
        this.train.cargo.push(id);
        this.train.idle = 0;
      }
    }
    const crates = {
      get: (id: string) => this.sprites.get(id),
      move: (id: string, p: Point) => {
        const s = this.sprites.get(id);
        if (s) Object.assign(s, { x: p.x, y: p.y });
      },
      done: (id: string) => {
        const s = this.sprites.get(id);
        // Lifted out of the wagon: its place there is free again.
        if (s && !s.leaving && !s.stage && s.wagonSlot !== undefined) s.wagonSlot = undefined;
        if (s?.dropLift !== undefined && s.path[0]) {
          // Set down on top of a pile: it rests at the pile's spot, drawn at the height it was lowered to.
          Object.assign(s, { x: s.path[0].x, y: s.path[0].y, lift: s.dropLift, dropLift: undefined });
        }
        if (s?.path[0]?.crane) s.path.shift();
      },
      free: (to: Point, except: string) => {
        const me = this.sprites.get(except);
        const mine = me?.at;
        // A crate lowered onto a pile aims at the pile's top; what has to be clear is the pile's own spot.
        const at = me?.dropLift !== undefined && me.path[0] ? me.path[0] : to;
        return ![...this.sprites.entries()].some(([oid, o]) => {
          if (oid === except || this.heldBy(oid) || o.loading !== undefined || o.stage) return false;
          // A crate on its way along a belt is held back from a reserved spot; only one sitting there is in the way.
          if ((o.path.length || o.next) && !o.path[0]?.crane) return false;
          // Crates already stacked in the same pile spot (or the wagon) don't stop the crane adding another.
          const intoWagon = me?.wagonSlot !== undefined && me.leaving;
          const pileMate = (mine && !o.path.length && !o.next && o.at.zone === mine.zone && o.at.slot === mine.slot) || (intoWagon && o.wagonSlot !== undefined);
          return !pileMate && Math.abs(o.x - at.x) < CRATE_W - 6 && Math.abs(o.y - at.y) < CRATE_H - 6;
        });
      },
    };
    for (const crane of Object.values(this.cranes)) crane.update(dt, crates);
    this.updateWarehouse(dt);
    const gap = this.camTarget - this.camX;
    this.camX = Math.abs(gap) < 0.5 ? this.camTarget : this.camX + gap * Math.min(1, dt * 5);

    // Crates rolling onto the dock belt join the back of the queue now, in the order they physically arrive.
    let joined = false;
    for (const [id, s] of this.sprites) {
      const belt = s.path[0]?.track;
      const lap = this.recycling.get(id);
      if (lap === 'out' && belt === NET.dock.recycle?.track) this.recycling.set(id, 'round');
      const settledHere = !s.path.length && !s.next;
      if (lap === 'out' || s.leaving || s.at.zone !== 'dock' || !(belt === NET.dock.track || settledHere) || this.dockQueue.includes(id)) continue;
      this.recycling.delete(id);
      this.dockQueue.push(id);
      joined = true;
    }
    const settled = joined || [...this.pendingLeave].some((id) => {
      const s = this.sprites.get(id);
      return !s || (!s.path.length && !s.next);
    });
    if (settled) this.setCrates(this.lastCrates, this.now());
  }

  private idOf(sprite: Sprite): string {
    for (const [id, s] of this.sprites) if (s === sprite) return id;
    return '';
  }

  private craneFor(zone: Area): Crane {
    return zone === 'freight' ? this.cranes.freight : this.cranes.storage;
  }

  /** The crane currently holding this crate, if any. */
  private heldBy(id: string): Crane | undefined {
    return [...Object.values(this.cranes), this.gantry].find((c) => c.holding === id);
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
      if (s.stage !== 'yard' || this.heldBy(id)) continue;
      const spot = this.stacks.spotOf(id);
      if (spot) Object.assign(s, spot);
    }

    const onTheWay = [...this.sprites.values()].some((s) => s.leaving && !s.stage);
    if (train.atFactory) {
      // Unload from the top of the wagon's pile, one crate at a time: the next comes off once the last one has been
      // lifted out (its crane hop is done).
      const lifting = [...this.sprites.values()].some((s) => !s.stage && s.path[0]?.crane === 'freight' && Math.hypot(s.x - FREIGHT.wagon.x, s.y - FREIGHT.wagon.y) < 30);
      const top = [...train.cargo].reverse().find((cid) => this.sprites.get(cid)?.returning);
      // It comes out over the transfer point, so a crate waiting there to go into the wagon goes in first.
      const transferBusy = [...this.sprites.values()].some((s) => !s.stage && Math.hypot(s.x - FREIGHT.transfer.x, s.y - FREIGHT.transfer.y) < CRATE_H);
      for (const id of lifting || transferBusy || !top ? [] : [top]) {
        // Home: the freight crane lifts it out of the wagon onto the belt, and it heads for its spot.
        const s = this.sprites.get(id)!;
        // It keeps its wagon place until the crane has lifted it out, so nothing is set down on it meanwhile.
        Object.assign(s, { stage: undefined, returning: false, leaving: false });
        // The freight crane lifts it from where it sits in the wagon.
        s.path = [{ x: s.x, y: s.y }, ...travel({ zone: 'freight', slot: 0 }, s.at).slice(1)];
        s.next = undefined;
        s.currentTo = s.at;
        train.cargo = train.cargo.filter((cid) => cid !== id);
      }
      const wagonBusy = [...this.sprites.entries()].some(([id, s]) => !s.stage && (this.heldBy(id) === this.cranes.freight || Math.hypot(s.x - FREIGHT.wagon.x, s.y - FREIGHT.wagon.y) < 12));
      const fetchWaiting = [...this.sprites.values()].some((s) => s.stage === 'yard' && s.returning);
      const work = train.cargo.length > 0 || fetchWaiting;
      const stillUnloading = train.cargo.some((cid) => this.sprites.get(cid)?.returning);
      if (!onTheWay && !wagonBusy && !stillUnloading && ((work && train.idle > TRAIN_DWELL) || (!work && this.onWarehouse))) train.goTo('warehouse');
    }

    if (train.atWarehouse) {
      // Unload from the top of the wagon's pile: last loaded, first off.
      for (const id of [...train.cargo].reverse()) {
        const s = this.sprites.get(id)!;
        if (s.returning || this.gantryJobs.has(id)) continue;
        this.stacks.place(id);
        this.gantryJobs.set(id, 'store');
        this.gantry.request(id, this.stacks.spotOf(id)!);
      }
      for (const [id, s] of this.sprites) {
        if (s.stage !== 'yard' || !s.returning || this.gantryJobs.has(id)) continue;
        this.gantryJobs.set(id, 'fetch');
        if (s.wagonSlot === undefined) s.wagonSlot = this.nextWagonSlot(id);
        this.gantry.request(id, train.wagonSpot(s.wagonSlot));
      }
      if (!this.gantry.busy && !this.gantryJobs.size) {
        // Crates coming home, or archived crates waiting at the freight station, call it back; otherwise an idle
        // train simply follows you to whichever page you're looking at.
        const bringingBack = train.cargo.some((id) => this.sprites.get(id)?.returning);
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
          s.stage = 'yard';
          s.wagonSlot = undefined;
          train.cargo = train.cargo.filter((cid) => cid !== id);
          // Brought back while it was being stacked: it waits for the next fetch.
        } else if (job === 'fetch') {
          this.stacks.remove(id);
          s.stage = 'cargo';
          train.cargo.push(id);
        }
        train.idle = 0;
      },
      free: () => true,
    });
  }

  hit(p: Point): string | null {
    for (const [id, s] of this.drawOrder().reverse()) {
      if ((s.leaving && s.stage !== 'yard') || s.stage === 'cargo') continue;
      const { x, y } = this.pileOffset(s);
      if (Math.abs(p.x - x) <= CRATE_W / 2 + 3 && Math.abs(p.y - y) <= CRATE_H / 2 + 3) return id;
    }
    return null;
  }

  private drawOrder(): [string, Sprite][] {
    // Warehouse stacks draw bottom crate first, so higher crates sit on top of lower ones.
    const key = ([id, s]: [string, Sprite]) => {
      const w = s.stage === 'yard' && !this.heldBy(id) ? this.stacks.where(id) : undefined;
      if (w) return stackSpot(w.index, 0).y + w.level * 0.01;
      // Crates in the wagon pile up too: the floor of the wagon, then loading order (last loaded in front).
      if (s.stage === 'cargo' && !this.heldBy(id)) return TRAIN.wagonY + (s.wagonSlot ?? 0) * 0.01;
      // Crates resting in a factory pile share its spot's depth, so the pile's own order (last placed in front) decides.
      const resting = !s.stage && !s.leaving && !s.path.length && !s.next && !this.heldBy(id);
      return resting ? NET[s.at.zone].slots[s.at.slot].pos.y : s.y;
    };
    // Crates on a crane are in the air: they always draw above the crates they pass over.
    const lifted = ([id]: [string, Sprite]) => (this.heldBy(id) ? 1 : 0);
    return [...this.sprites.entries()].sort((a, b) => lifted(a) - lifted(b) || key(a) - key(b) || b[1].pileRank - a[1].pileRank);
  }

  /** How high in its pile a crate should sit, in levels (0 = on the floor). */
  private pileLevel(s: Sprite): number {
    const moving = s.path.length > 0 || !!s.next;
    // Only crates parked in a factory pile spot stack up; archived crates (train, warehouse) never do.
    // Rank 0 is the crate placed last, on top: the pile rises from the first one placed (shown up to 4 high).
    return moving || s.stage ? 0 : Math.max(0, Math.min(s.pileSize - 1, 3) - s.pileRank);
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
      if (q && s.stage === 'yard' && ![c.label, c.jiraKey].some((f) => f?.toLowerCase().includes(q))) {
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
      const entry = [...this.sprites.entries()].find(([, s]) => !s.leaving && s.at.zone === 'working' && s.at.slot === index && s.pileRank === 0 && !s.path.length && !s.next);
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
    if (s.loading !== undefined) {
      const load = Math.min(1, s.loading / LOAD_SECONDS);
      ctx.save();
      ctx.globalAlpha = 1 - load;
      fillSquircle(ctx, x + load * 10, y + load * LOAD_DROP, CRATE_W - load * 20, CRATE_H - load * 14, RADIUS.crate, crateColor(c.id, 45));
      ctx.restore();
      return;
    }
    const cx = x + CRATE_W / 2;
    // Ended sessions look dimmed wherever their crate is: parked, on a belt, on a crane or on the train.
    const parked = c.zone === 'storage';
    const buried = !moving && !s.stage && s.pileRank > 0;

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
      if (!c || s.leaving || s.loading !== undefined || (parked && s.pileRank > 0)) continue;
      const top = this.pileOffset(s);
      const x = Math.round(top.x - CRATE_W / 2);
      const y = Math.round(top.y - CRATE_H / 2);
      const cx = x + CRATE_W / 2;
      ctx.textAlign = 'center';
      if (parked && s.pileSize > 1) {
        const label = `+${s.pileSize - 1}`;
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

function strokeTrack(ctx: CanvasRenderingContext2D, track: Track): void {
  ctx.beginPath();
  track.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (track.closed) ctx.closePath();
  ctx.stroke();
}

const trackIds = new Map<Track, number>(ALL_TRACKS.map((t, i) => [t, i]));

function sectionKey(track: Track, section: number): string {
  return `${trackIds.get(track)}:${section}`;
}

const sectionPaths = new Map<Track, Point[][]>();

function sectionPoints(track: Track): Point[][] {
  let paths = sectionPaths.get(track);
  if (!paths) {
    paths = track.splits.length ? track.sections().map(([a, b]) => track.between(a, b)) : [track.closed ? [...track.pts, track.pts[0]] : track.pts];
    sectionPaths.set(track, paths);
  }
  return paths;
}

function strokePoints(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
}

/**
 * Belt body, then plates with seams travelling in the belt's own direction, section by section.
 * Section joints are drawn as dark rollers across the belt. Later belts cover earlier ones at joins.
 */
function drawBelt(ctx: CanvasRenderingContext2D, track: Track, travelled: (section: number) => number): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 32;
  ctx.translate(0, 3);
  strokeTrack(ctx, track);
  ctx.restore();
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = C.rail;
  ctx.lineWidth = 30;
  strokeTrack(ctx, track);
  ctx.strokeStyle = C.railLight;
  ctx.lineWidth = 27;
  strokeTrack(ctx, track);
  ctx.strokeStyle = C.beltSurface;
  ctx.lineWidth = 22;
  strokeTrack(ctx, track);
  ctx.strokeStyle = C.section;
  ctx.lineWidth = 20;
  ctx.setLineDash([26, 4]);
  sectionPoints(track).forEach((pts, i) => {
    ctx.lineDashOffset = -travelled(i);
    strokePoints(ctx, pts);
  });
  ctx.setLineDash([]);
  for (const split of track.splits) {
    const p = track.at(split);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    squirclePath(ctx, -3, -14, 6, 28, 2);
    ctx.fillStyle = '#0b0c0d';
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Splitter/merger block where a zone belt meets the main loop. */
function junction(ctx: CanvasRenderingContext2D, p: Point): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  fillSquircle(ctx, p.x - 17, p.y - 17, 34, 34, RADIUS.medium, '#3a3e45');
  ctx.restore();
  fillSquircle(ctx, p.x - 17, p.y - 17, 34, 6, RADIUS.small, C.orange);
  fillSquircle(ctx, p.x - 9, p.y - 6, 18, 14, RADIUS.small, '#1d1f23');
}

function drawOperator(ctx: CanvasRenderingContext2D, t: number): void {
  const { x, y } = OPERATOR;
  // Workbench beside the operator, light metal so it reads against the floor.
  const bx = x + 20;
  const by = y - 10;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  fillSquircle(ctx, bx, by, 78, 32, RADIUS.small, '#8b939e');
  ctx.restore();
  fillSquircle(ctx, bx, by, 78, 4, 2, C.orange);
  // Retro beige CRT monitor standing on the bench.
  const beige = '#d9cfb4';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 3;
  fillSquircle(ctx, bx + 8, by - 16, 38, 32, 5, beige);
  ctx.restore();
  fillSquircle(ctx, bx + 8, by + 11, 38, 5, 2, '#b9ad8f');
  fillSquircle(ctx, bx + 12, by - 12, 30, 21, 5, '#0b120d');
  ctx.fillStyle = '#4ade80';
  for (const [w, row] of [[18, 0], [12, 1], [20, 2]] as const) ctx.fillRect(bx + 16, by - 8 + row * 5, w, 2);
  if (Math.floor(t / 530) % 2 === 0) ctx.fillRect(bx + 16, by + 6, 3, 2);
  // Coffee mug: white with an orange band, coffee inside, a handle, and a little steam.
  const mx = bx + 62;
  const my = by + 16;
  fillSquircle(ctx, mx + 7, my - 3, 6, 6, 2, '#e7e5e4');
  fillSquircle(ctx, mx - 7, my - 7, 14, 14, 5, '#f5f5f4');
  fillSquircle(ctx, mx - 7, my - 1, 14, 4, 1.5, C.orange);
  fillSquircle(ctx, mx - 4.5, my - 4.5, 9, 6, 3, '#5b3418');
  for (let k = 0; k < 2; k++) {
    const phase = (t / 2600 + k / 2) % 1;
    const size = 4 + phase * 5;
    squirclePath(ctx, mx - size / 2 + Math.sin(phase * 6 + k) * 2, my - 10 - phase * 16, size, size, size * 0.4);
    ctx.fillStyle = `rgba(230,230,230,${0.35 * (1 - phase)})`;
    ctx.fill();
  }
  fillSquircle(ctx, x - 12, y - 10, 24, 26, RADIUS.medium, '#2563eb');
  fillSquircle(ctx, x - 9, y - 26, 18, 18, RADIUS.medium, '#f1c27d');
  // Hard hat: a domed shell (curved crown, flat base) over the head, a centre ridge, and a slim brim.
  const brimY = y - 20;
  ctx.beginPath();
  ctx.moveTo(x - 11, brimY);
  ctx.bezierCurveTo(x - 11, brimY - 17, x + 11, brimY - 17, x + 11, brimY);
  ctx.closePath();
  ctx.fillStyle = '#f59e0b';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 2, brimY);
  ctx.bezierCurveTo(x - 2, brimY - 13, x + 2, brimY - 13, x + 2, brimY);
  ctx.closePath();
  ctx.fillStyle = '#fbbf24';
  ctx.fill();
  fillSquircle(ctx, x - 13, brimY - 1, 26, 3, 1.5, '#d97706');
}

const TOP_ROW_Y = 148;

type MachineMode = 'idle' | 'working' | 'jammed';

function modeOf(crate: CrateView | undefined): MachineMode {
  if (!crate) return 'idle';
  return crate.zone === 'alert' ? 'jammed' : 'working';
}

/** Jam colours: red when blocked on a prompt, yellow when its last message asked you something. */
function jamColors(crate: CrateView | undefined): { fill: string; glow: string; cog: string; ink: string } {
  return crate?.alertReason === 'asked a question'
    ? { fill: C.awaiting, glow: 'rgba(250,204,21,0.5)', cog: '#fde047', ink: '#1c1917' }
    : { fill: C.alert, glow: 'rgba(239,68,68,0.5)', cog: '#f87171', ink: '#fff' };
}

/** Machine housing behind the crate: snug around it, with stack, lamp and status band. */
function machineBack(ctx: CanvasRenderingContext2D, pos: Point, t: number, index: number, crate: CrateView | undefined): void {
  const mode = modeOf(crate);
  const jam = jamColors(crate);
  const x = pos.x - MACHINE_W / 2;
  const y = pos.y - MACHINE_H / 2;
  ctx.save();
  ctx.shadowColor = mode === 'jammed' ? jam.glow : mode === 'working' ? 'rgba(246,181,69,0.35)' : 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = mode === 'idle' ? 10 : 20;
  ctx.shadowOffsetY = mode === 'idle' ? 4 : 0;
  const body = ctx.createLinearGradient(0, y, 0, y + MACHINE_H);
  body.addColorStop(0, C.machineTop);
  body.addColorStop(1, C.machineBottom);
  fillSquircle(ctx, x, y, MACHINE_W, MACHINE_H, RADIUS.large, body);
  ctx.restore();
  ctx.save();
  squirclePath(ctx, x, y, MACHINE_W, MACHINE_H, RADIUS.large);
  ctx.clip();
  ctx.fillStyle = mode === 'jammed' ? jam.fill : mode === 'working' ? C.orange : '#6b6258';
  ctx.fillRect(x, y, MACHINE_W, 7);
  ctx.restore();
  fillSquircle(ctx, x + MACHINE_W - 24, y - 12, 13, 16, RADIUS.small, '#4a4e55');
  fillSquircle(ctx, x + 6, y + 11, 7, 7, 2, mode === 'jammed' ? jam.fill : mode === 'working' ? '#4ade80' : '#3b3f45');
}

/**
 * Jammed gears strain forward, stop, and settle back: a quick nudge, a slower return, then a pause.
 * Returns the rotation in radians for time t.
 */
function strain(t: number, offset: number): number {
  const phase = ((t + offset) % 1600) / 1600;
  if (phase < 0.12) return 0.32 * Math.sin((phase / 0.12) * (Math.PI / 2));
  if (phase < 0.45) return 0.32 * (1 - (phase - 0.12) / 0.33);
  return 0;
}

/**
 * Cogs overlap the crate's sides: turning while Claude works, straining against a jam while it waits on you.
 * A jammed machine gets a big alert badge. Signs sit on the side away from the bus.
 */
function machineFront(ctx: CanvasRenderingContext2D, pos: Point, t: number, crate: CrateView | undefined): void {
  const mode = modeOf(crate);
  const jam = jamColors(crate);
  const color = mode === 'working' ? C.amber : mode === 'jammed' ? jam.cog : '#5b5f66';
  const awaiting = crate?.alertReason === 'asked a question';
  const spin = mode === 'working' ? t / 750 : mode === 'jammed' && !awaiting ? strain(t, pos.x) : 0;
  cog(ctx, pos.x - MACHINE_W / 2 + 10, pos.y + 6, 22, spin, color);
  cog(ctx, pos.x + MACHINE_W / 2 - 10, pos.y + 6, 22, -spin, color);
  if (!crate) return;

  const topRow = pos.y < TOP_ROW_Y + 1;
  if (mode === 'jammed') {
    const by = topRow ? pos.y - MACHINE_H / 2 - 22 : pos.y + MACHINE_H / 2 - 14;
    ctx.save();
    ctx.shadowColor = jam.fill;
    ctx.shadowBlur = 16;
    fillSquircle(ctx, pos.x - 18, by, 36, 36, RADIUS.medium, jam.fill);
    ctx.restore();
    ctx.fillStyle = jam.ink;
    ctx.font = '900 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('!', pos.x, by + 27);
  }

  if (mode === 'jammed') return;
  const sign = crate.waitingOn ? `⏳ ${crate.waitingOn}` : crate.lastTool;
  if (!sign) return;
  ctx.font = '700 10px ui-monospace, monospace';
  const label = short(sign, 22);
  const tw = ctx.measureText(label).width + 14;
  const sx = pos.x - tw / 2;
  const sy = topRow ? pos.y - MACHINE_H / 2 - 20 : pos.y + MACHINE_H / 2 + 4;
  fillSquircle(ctx, sx, sy, tw, 16, RADIUS.small, '#121315');
  ctx.fillStyle = crate.waitingOn ? '#93c5fd' : C.amber;
  ctx.textAlign = 'center';
  ctx.fillText(label, sx + tw / 2, sy + 12);
}

/** A squircle cog: rounded-square body with four teeth. */
function cog(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, angle: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  const tooth = size * 0.3;
  for (let k = 0; k < 4; k++) {
    ctx.rotate(Math.PI / 2);
    squirclePath(ctx, -tooth / 2, -size / 2 - tooth * 0.5, tooth, tooth, 1.5);
    ctx.fill();
  }
  squirclePath(ctx, -size / 2, -size / 2, size, size, RADIUS.medium);
  ctx.fill();
  squirclePath(ctx, -size * 0.17, -size * 0.17, size * 0.34, size * 0.34, 2);
  ctx.fillStyle = '#2a2d33';
  ctx.fill();
  ctx.restore();
}

function paintScenery(g: CanvasRenderingContext2D): void {
  const floor = g.createLinearGradient(0, 0, 0, H);
  floor.addColorStop(0, C.floorTop);
  floor.addColorStop(1, C.floorBottom);
  g.fillStyle = floor;
  g.fillRect(0, 0, W, H);

  const rnd = seeded(7);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(255,240,220,${rnd() * 0.035})`;
    g.fillRect(rnd() * W, rnd() * H, 2, 2);
  }

  const areas = Object.values(AREAS);
  const offBelts = (p: Point) =>
    ALL_TRACKS.every((t) => {
      const q = t.at(t.project(p));
      return Math.hypot(q.x - p.x, q.y - p.y) > 22;
    });
  // Plants root this far from any platform; deeper below one, since fronds grow upward into it.
  const SIDE = 12;
  const BELOW = 24;
  const nearPlatform = (p: Point) => areas.some((a) => p.x > a.x - SIDE && p.x < a.x + a.w + SIDE && p.y > a.y - SIDE && p.y < a.y + a.h + BELOW);
  const clear = (p: Point) => p.y > 8 && !nearPlatform(p) && offBelts(p);
  const plants: Point[] = [];
  for (let i = 0; i < 2400; i++) {
    const p = { x: rnd() * W, y: rnd() * H };
    const plantNext = rnd() < 0.55;
    if (!clear(p)) continue;
    if (plantNext) {
      plants.push(p);
      continue;
    }
    const w = 5 + rnd() * 9;
    const h = 4 + rnd() * 5;
    squirclePath(g, p.x - w / 2, p.y - h / 2, w, h, Math.min(w, h) * 0.3);
    g.fillStyle = C.rock;
    g.fill();
  }

  // Ground level first (rocks, platforms), then plants, which stand taller than the platforms they overhang.
  // Belts are drawn later, above everything here.
  for (const [key, a] of Object.entries(AREAS) as [Area, (typeof AREAS)[Area]][]) foundation(g, key, a);
  const plantRnd = seeded(11);
  for (const p of plants) plant(g, p.x, p.y, plantRnd);

}

/** The warehouse page: ground with rocks and plants, and a walled building with a doorway for the rail. */
function paintWarehouse(g: CanvasRenderingContext2D): void {
  const floor = g.createLinearGradient(0, 0, 0, H);
  floor.addColorStop(0, C.floorTop);
  floor.addColorStop(1, C.floorBottom);
  g.fillStyle = floor;
  g.fillRect(WAREHOUSE_X, 0, W, H);
  const rnd = seeded(23);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(255,240,220,${rnd() * 0.035})`;
    g.fillRect(WAREHOUSE_X + rnd() * W, rnd() * H, 2, 2);
  }

  const p = STACKS.platform;
  const WALL = 14;
  const outer = { x: p.x - WALL, y: p.y - WALL, w: p.w + WALL * 2, h: p.h + WALL * 2 };
  // Ground cover outside the building, kept off the rail.
  const plants: Point[] = [];
  for (let i = 0; i < 1400; i++) {
    const q = { x: WAREHOUSE_X + rnd() * W, y: rnd() * H };
    const isPlant = rnd() < 0.55;
    const nearBuilding = q.x > outer.x - 12 && q.x < outer.x + outer.w + 12 && q.y > outer.y - 12 && q.y < outer.y + outer.h + 24;
    const onRail = q.y > TRAIN_Y - 10 && q.y < TRAIN_Y + 54;
    if (nearBuilding || onRail || q.y < 8) continue;
    if (isPlant) plants.push(q);
    else {
      const w = 5 + rnd() * 9;
      const h = 4 + rnd() * 5;
      squirclePath(g, q.x - w / 2, q.y - h / 2, w, h, Math.min(w, h) * 0.3);
      g.fillStyle = C.rock;
      g.fill();
    }
  }

  // Walls: a thick steel band around the floor, with a lighter cap, pillars, and a doorway for the rail.
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 24;
  g.shadowOffsetY = 10;
  fillSquircle(g, outer.x, outer.y, outer.w, outer.h, RADIUS.large + 4, '#33373d');
  g.restore();
  foundation(g, 'warehouse', { ...p, title: 'WAREHOUSE', subtitle: '' });
  g.strokeStyle = '#5a606a';
  g.lineWidth = 2;
  squirclePath(g, outer.x + 1, outer.y + 1, outer.w - 2, outer.h - 2, RADIUS.large + 3);
  g.stroke();
  const door = { y: TRAIN_Y - 6, h: 52 };
  g.fillStyle = C.floorBottom;
  g.fillRect(outer.x - 1, door.y, WALL + 3, door.h);
  fillSquircle(g, outer.x - 4, door.y - 8, WALL + 8, 8, 2, C.orange);
  fillSquircle(g, outer.x - 4, door.y + door.h, WALL + 8, 8, 2, C.orange);
  const pillar = (x: number, y: number) => {
    fillSquircle(g, x - 11, y - 11, 22, 22, 4, '#4a4f57');
    fillSquircle(g, x - 11, y - 11, 22, 5, 2, C.orange);
  };
  const half = WALL / 2;
  for (let x = outer.x + half; x <= outer.x + outer.w - half + 1; x += (outer.w - WALL) / 6) {
    pillar(x, outer.y + half);
    pillar(x, outer.y + outer.h - half);
  }
  for (let y = outer.y + half; y <= outer.y + outer.h - half + 1; y += (outer.h - WALL) / 4) {
    pillar(outer.x + outer.w - half, y);
    if (y < door.y - 12 || y > door.y + door.h + 12) pillar(outer.x + half, y);
  }

  const plantRnd = seeded(29);
  for (const q of plants) plant(g, q.x, q.y, plantRnd);
  paintRail(g);
}

/** Rail from the freight station across into the warehouse, drawn over both floors. */
function paintRail(g: CanvasRenderingContext2D): void {
  const from = AREAS.freight.x + 10;
  // Ends just past the far engine when the train is at the warehouse.
  const to = TRAIN.warehouseX + 100;
  // Ballast bed under the track so it reads against both floors.
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 6;
  g.shadowOffsetY = 2;
  fillSquircle(g, from - 8, TRAIN_Y + 4, to - from + 16, 36, 6, '#2e2a26');
  g.restore();
  const rnd = seeded(31);
  for (let i = 0; i < (to - from) * 0.6; i++) {
    g.fillStyle = `rgba(200,190,175,${0.05 + rnd() * 0.08})`;
    g.fillRect(from + rnd() * (to - from), TRAIN_Y + 7 + rnd() * 30, 2, 2);
  }
  g.strokeStyle = 'rgba(255,255,255,0.06)';
  g.lineWidth = 1;
  squirclePath(g, from - 8, TRAIN_Y + 4, to - from + 16, 36, 6);
  g.stroke();
  g.fillStyle = '#3d3226';
  for (let x = from + 6; x < to; x += 13) {
    squirclePath(g, x - 2.5, TRAIN_Y + 10, 5, 20, 1.5);
    g.fill();
  }
  g.strokeStyle = '#8a8f96';
  g.lineWidth = 3;
  for (const ry of [TRAIN_Y + 14, TRAIN_Y + 26]) {
    g.beginPath();
    g.moveTo(from, ry);
    g.lineTo(to, ry);
    g.stroke();
  }
  fillSquircle(g, to - 6, TRAIN_Y + 6, 12, 28, 3, '#b45f13');
}

function plant(g: CanvasRenderingContext2D, x: number, y: number, rnd: () => number): void {
  const fronds = 3 + Math.floor(rnd() * 3);
  g.lineCap = 'round';
  for (let k = 0; k < fronds; k++) {
    const ang = -Math.PI / 2 + (rnd() - 0.5) * 1.6;
    const len = 8 + rnd() * 12;
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len;
    g.strokeStyle = C.plant;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(ang + 0.6) * len * 0.6, y + Math.sin(ang + 0.6) * len * 0.6, ex, ey);
    g.stroke();
    g.globalAlpha = 0.7;
    squirclePath(g, ex - 2, ey - 2, 4, 4, 1);
    g.fillStyle = C.plantTip;
    g.fill();
    g.globalAlpha = 1;
  }
}

/** Title plates sit clear of the belts that enter each foundation. */
const TITLE_INSET: Partial<Record<Area | 'warehouse', number>> = { dock: 52, storage: 104 };

function foundation(g: CanvasRenderingContext2D, key: Area | 'warehouse', a: (typeof AREAS)[Area]): void {
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 22;
  g.shadowOffsetY = 8;
  fillSquircle(g, a.x, a.y, a.w, a.h, RADIUS.large, C.concrete);
  g.restore();

  g.save();
  squirclePath(g, a.x, a.y, a.w, a.h, RADIUS.large);
  g.clip();
  g.strokeStyle = C.concreteSeam;
  g.lineWidth = 2;
  for (let x = a.x + 40; x < a.x + a.w; x += 40) {
    g.beginPath();
    g.moveTo(x, a.y);
    g.lineTo(x, a.y + a.h);
    g.stroke();
  }
  for (let y = a.y + 40; y < a.y + a.h; y += 40) {
    g.beginPath();
    g.moveTo(a.x, y);
    g.lineTo(a.x + a.w, y);
    g.stroke();
  }
  const sheen = g.createLinearGradient(a.x, a.y, a.x, a.y + a.h);
  sheen.addColorStop(0, 'rgba(255,255,255,0.05)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = sheen;
  g.fillRect(a.x, a.y, a.w, a.h);
  g.restore();

  g.strokeStyle = C.concreteEdge;
  g.lineWidth = 3;
  squirclePath(g, a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3, RADIUS.large - 1);
  g.stroke();

  g.font = '800 13px system-ui, sans-serif';
  const tw = g.measureText(a.title).width;
  // Narrow platforms with belt legs at both sides (intake, freight) centre their title between them.
  const centred = a.w < 250 || key === 'freight';
  const left = centred ? a.x + (a.w - tw - 20) / 2 : a.x + (TITLE_INSET[key] ?? 16);
  fillSquircle(g, left, a.y + 12, tw + 20, 24, RADIUS.small, C.orange);
  g.fillStyle = '#1a1208';
  g.textAlign = 'left';
  g.fillText(a.title, left + 10, a.y + 29);
  if (a.w > 300 && a.subtitle) {
    g.fillStyle = C.dim;
    g.font = '12px system-ui, sans-serif';
    g.fillText(a.subtitle, left + tw + 30, a.y + 29);
  }
}


/** Overhead bridge crane: rails, a bridge at the trolley's row, and the magnetic lifter on the trolley. */
function drawCrane(ctx: CanvasRenderingContext2D, crane: Crane, r: { left: number; right: number; top: number; bottom: number }): void {
  for (const x of [r.left, r.right]) fillSquircle(ctx, x - 4, r.top - 6, 8, r.bottom - r.top + 12, 2, '#5b5f66');
  const by = crane.pos.y;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 6;
  fillSquircle(ctx, r.left - 8, by - 6, r.right - r.left + 16, 12, RADIUS.small, C.orangeDark);
  ctx.restore();
  fillSquircle(ctx, r.left - 8, by - 6, r.right - r.left + 16, 4, 2, C.orange);
  const tx = crane.pos.x;
  const ty = crane.pos.y;
  // Magnetic lifter: a plate under the trolley that glows as it engages.
  const charge = crane.grip;
  if (charge > 0) {
    ctx.save();
    ctx.shadowColor = '#60a5fa';
    ctx.shadowBlur = 18 * charge;
    fillSquircle(ctx, tx - 26, ty - 18, 52, 36, RADIUS.medium, `rgba(96,165,250,${0.25 * charge})`);
    ctx.restore();
  }
  fillSquircle(ctx, tx - 22, ty - 15, 44, 30, RADIUS.medium, '#2a2d33');
  fillSquircle(ctx, tx - 16, ty - 10, 32, 20, RADIUS.small, charge > 0 ? `rgba(147,197,253,${0.35 + 0.5 * charge})` : '#3f444c');
  fillSquircle(ctx, tx - 22, ty - 15, 44, 4, 2, crane.busy ? '#4ade80' : '#57534e');
}
