import type { CrateView } from '../src/shared/types';
import { ALL_TRACKS, BELT_SPEED, FREIGHT_LOAD, fromHopper, HOPPER_DROP, JUNCTIONS, LOOP, NET, type SlotRef, type Track, travel, type Waypoint, YARD } from './belts';
import { AREAS, type Area, CRATE_H, CRATE_W, floorArea, H, HOPPER, OPERATOR, type Point, TRAIN_Y, W } from './layout';
import { Crane } from './crane';
import { reorderQueue } from './queue';
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
  pileRank: number;
  pileSize: number;
}

const LOAD_SECONDS = 0.8;
const LOAD_DROP = 40;

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
  private crane = new Crane(YARD.home);

  setCrates(crates: CrateView[], now: number): void {
    const first = this.crates.size === 0 && this.sprites.size === 0;
    this.serverNow = now;
    this.clientAtSync = Date.now();
    this.crates = new Map(crates.map((c) => [c.id, c]));
    this.archivedCount = crates.filter((c) => c.archived).length;

    const byZone = new Map<Area, CrateView[]>();
    for (const c of crates) {
      if (c.archived) continue;
      let area = floorArea(c.zone, c.turns);
      const existing = this.sprites.get(c.id);
      if (area === 'intake' && existing && !existing.leaving && existing.at.zone !== 'intake') area = 'dock';
      byZone.set(area, [...(byZone.get(area) ?? []), c]);
    }

    const docked = [...(byZone.get('dock') ?? [])].sort((a, b) => a.zoneSince - b.zoneSince);
    const reordered = reorderQueue(this.dockQueue, new Set(docked.map((c) => c.id)), docked.map((c) => c.id));
    this.dockQueue = reordered.queue;
    const loopers = new Set(reordered.loopers);

    for (const [zone, list] of byZone) {
      const assigned = QUEUE_ZONES.has(zone) ? this.queueSlots(zone, list) : this.stickySlots(zone, list);
      const piles = new Map<number, CrateView[]>();
      for (const c of list) piles.set(assigned.get(c.id)!, [...(piles.get(assigned.get(c.id)!) ?? []), c]);
      for (const [slot, pile] of piles) {
        pile.sort((a, b) => b.zoneSince - a.zoneSince);
        pile.forEach((c, rank) => this.place(c, { zone, slot }, first, rank, pile.length, loopers.has(c.id)));
      }
    }

    for (const [id, s] of this.sprites) {
      const c = this.crates.get(id);
      if (!c) this.sprites.delete(id);
      else if (c.archived && !s.leaving) {
        this.go(s, { zone: 'freight', slot: 0 });
        s.leaving = true;
        s.pileRank = 0;
        s.pileSize = 1;
      }
    }
  }

  /**
   * Dock and intake are queues on the belt itself: order decides position, the back of the queue piles up.
   * The dock keeps its physical order, so crates that looped round to let one out stay at the back.
   */
  private queueSlots(zone: Area, list: CrateView[]): Map<string, number> {
    const cap = NET[zone].slots.length;
    const rank = new Map(this.dockQueue.map((id, i) => [id, i]));
    const ordered = [...list].sort((a, b) => (zone === 'dock' ? (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) : a.startedAt - b.startedAt));
    return new Map(ordered.map((c, i) => [c.id, Math.min(i, cap - 1)]));
  }

  /** Machines, alert spots and storage spots keep their crate until it leaves; extras pile on the last spot. */
  private stickySlots(zone: Area, list: CrateView[]): Map<string, number> {
    const cap = NET[zone].slots.length;
    const used = new Set<number>();
    const out = new Map<string, number>();
    const rest: CrateView[] = [];
    for (const c of [...list].sort((a, b) => a.zoneSince - b.zoneSince)) {
      const s = this.sprites.get(c.id);
      if (s && !s.leaving && s.at.zone === zone && !used.has(s.at.slot) && s.pileRank === 0) {
        used.add(s.at.slot);
        out.set(c.id, s.at.slot);
      } else rest.push(c);
    }
    for (const c of rest) {
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
        s = { x: FREIGHT_LOAD.x, y: FREIGHT_LOAD.y + LOAD_DROP, at: to, currentTo: to, path: travel({ zone: 'freight', slot: 0 }, to), leaving: false, pileRank, pileSize };
      } else {
        s = { x: HOPPER_DROP.x, y: HOPPER.y + HOPPER.h - CRATE_H / 2, at: to, currentTo: to, path: fromHopper(to), leaving: false, pileRank, pileSize };
      }
      this.sprites.set(c.id, s);
      return;
    }
    if (s.leaving) {
      s.leaving = false;
      s.loading = undefined;
      s.path = [];
      s.next = undefined;
      s.x = FREIGHT_LOAD.x;
      s.y = FREIGHT_LOAD.y;
      s.at = { zone: 'freight', slot: 0 };
      s.currentTo = s.at;
    }
    s.pileRank = pileRank;
    s.pileSize = pileSize;
    if (lap || s.at.zone !== to.zone || s.at.slot !== to.slot) this.go(s, to, lap);
  }

  /** Sends a sprite to a slot along the belts, after finishing the trip it is already on. */
  private go(s: Sprite, to: SlotRef, lap = false): void {
    const same = (a: SlotRef, b: SlotRef) => a.zone === b.zone && a.slot === b.slot;
    if (!s.path.length && !s.next) {
      s.path = travel(s.currentTo, to, lap);
      s.currentTo = to;
    } else {
      s.next = same(s.currentTo, to) && !lap ? undefined : { path: travel(s.currentTo, to, lap), to };
    }
    s.at = to;
  }

  update(dt: number): void {
    this.running = new Set([sectionKey(LOOP, 0)]);
    for (const s of this.sprites.values()) {
      if (!s.path.length && !s.next) continue;
      const target = s.path[0] ?? s.next?.path[0];
      const belt = target?.track;
      if (belt && !target?.crane) this.running.add(sectionKey(belt, belt.sectionOf(belt.project(s))));
    }
    for (const k of this.running) this.beltOffset.set(k, (this.beltOffset.get(k) ?? 0) + BELT_SPEED * dt);

    for (const [id, s] of this.sprites) {
      let budget = BELT_SPEED * dt;
      while (budget > 0 && (s.path.length || s.next)) {
        if (!s.path.length && s.next) {
          s.path = s.next.path;
          s.currentTo = s.next.to;
          s.next = undefined;
        }
        const p = s.path[0];
        if (p.crane) {
          // Wait (belt stopped) until the crane comes over, picks the crate up and sets it down.
          this.crane.request(id, p);
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
      if (s.leaving && !s.path.length && !s.next && this.crane.holding !== id) {
        s.loading = (s.loading ?? 0) + dt;
        if (s.loading >= LOAD_SECONDS) this.sprites.delete(id);
      }
    }
    this.crane.update(dt, {
      get: (id) => this.sprites.get(id),
      move: (id, p) => {
        const s = this.sprites.get(id);
        if (s) Object.assign(s, { x: p.x, y: p.y });
      },
      done: (id) => {
        const s = this.sprites.get(id);
        if (s?.path[0]?.crane) s.path.shift();
      },
    });
  }

  hit(p: Point): string | null {
    for (const [id, s] of this.drawOrder().reverse()) {
      if (s.leaving) continue;
      const { x, y } = this.pileOffset(s);
      if (Math.abs(p.x - x) <= CRATE_W / 2 + 3 && Math.abs(p.y - y) <= CRATE_H / 2 + 3) return id;
    }
    return null;
  }

  private drawOrder(): [string, Sprite][] {
    return [...this.sprites.entries()].sort((a, b) => a[1].y - b[1].y || b[1].pileRank - a[1].pileRank);
  }

  private pileOffset(s: Sprite): Point {
    const moving = s.path.length > 0 || !!s.next;
    const k = moving ? 0 : Math.min(s.pileRank, 3);
    return { x: s.x - k * 6, y: s.y - k * 6 };
  }

  private now(): number {
    return this.serverNow + (Date.now() - this.clientAtSync);
  }

  draw(ctx: CanvasRenderingContext2D, t: number, opts: { hover: string | null; selected: string | null; terminals: boolean; pixelRatio: number }): void {
    this.drawStatic(ctx, opts.pixelRatio);
    for (const track of ALL_TRACKS) drawBelt(ctx, track, (i) => this.beltOffset.get(sectionKey(track, i)) ?? 0);
    for (const j of JUNCTIONS) junction(ctx, j);
    this.drawHopper(ctx, opts.terminals);
    this.drawTrain(ctx, t);
    drawOperator(ctx);

    const machines = this.machineStates();
    machines.forEach((m) => machineBack(ctx, m.pos, t, m.index, m.crate));

    for (const [id, s] of this.drawOrder()) {
      const c = this.crates.get(id);
      if (c) this.drawCrate(ctx, c, s, id === opts.hover, id === opts.selected);
    }

    machines.forEach((m) => machineFront(ctx, m.pos, t, m.crate));
    drawGantry(ctx, this.loadingNow());
    this.drawCrane(ctx);
  }

  private loadingNow(): boolean {
    return [...this.sprites.values()].some((s) => s.loading !== undefined || (!s.leaving && Math.hypot(s.x - FREIGHT_LOAD.x, s.y - FREIGHT_LOAD.y) < LOAD_DROP + 1 && s.path.length > 0));
  }

  /** Overhead bridge crane over the storage yard: rails, a bridge at the trolley's row, trolley and claw. */
  private drawCrane(ctx: CanvasRenderingContext2D): void {
    const r = YARD.rails;
    const crane = this.crane;
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
    // Claw jaws reach out over the crate's ends as the claw lowers.
    const reach = 18 + crane.claw * (CRATE_W / 2 - 14);
    for (const dx of [-reach, reach - 4]) fillSquircle(ctx, tx + dx, by - 6, 4, 12 + crane.claw * 10, 1.5, '#9ca3af');
    fillSquircle(ctx, tx - 18, by - 13, 36, 26, RADIUS.small, '#3a3e45');
    fillSquircle(ctx, tx - 18, by - 13, 36, 5, 2, crane.busy ? '#4ade80' : '#57534e');
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
      layer.width = ctx.canvas.width;
      layer.height = ctx.canvas.height;
      const g = layer.getContext('2d')!;
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintScenery(g);
      this.staticLayer = layer;
      this.staticKey = key;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticLayer, 0, 0);
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

  private drawTrain(ctx: CanvasRenderingContext2D, t: number): void {
    const a = AREAS.freight;
    const wagonX = FREIGHT_LOAD.x - 46;
    const locoX = wagonX + 100;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    fillSquircle(ctx, wagonX, TRAIN_Y - 10, 92, 24, RADIUS.small, '#4a4e55');
    const loco = ctx.createLinearGradient(0, TRAIN_Y - 22, 0, TRAIN_Y + 14);
    loco.addColorStop(0, '#f6a24a');
    loco.addColorStop(1, C.orangeDark);
    fillSquircle(ctx, locoX, TRAIN_Y - 18, 52, 32, RADIUS.medium, loco);
    ctx.restore();
    fillSquircle(ctx, locoX + 30, TRAIN_Y - 12, 16, 10, RADIUS.small, '#16181b');
    fillSquircle(ctx, locoX + 8, TRAIN_Y - 28, 9, 11, RADIUS.small, '#6b6f76');
    for (let i = 0; i < Math.min(this.archivedCount, 6); i++) {
      fillSquircle(ctx, wagonX + 4 + (i % 3) * 29, TRAIN_Y - 24 - Math.floor(i / 3) * 14, 26, 13, RADIUS.small, i % 2 ? '#8a6f52' : '#7a614a');
    }
    for (const wx of [wagonX + 14, wagonX + 78, locoX + 12, locoX + 40]) {
      squircleAt(ctx, wx, TRAIN_Y + 15, 12);
      ctx.fillStyle = '#121315';
      ctx.fill();
    }
    smoke(ctx, locoX + 12, TRAIN_Y - 32, t, 0);
    ctx.fillStyle = C.text;
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('WAREHOUSE', a.x + a.w / 2, a.y + 120);
    ctx.fillStyle = C.dim;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${this.archivedCount} archived`, a.x + a.w / 2, a.y + 138);
    ctx.fillText('click to browse', a.x + a.w / 2, a.y + 156);
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
    const parked = c.zone === 'storage' && !moving;
    const buried = !moving && s.pileRank > 0;

    const lifted = this.crane.holding === c.id;
    ctx.save();
    ctx.globalAlpha = parked && !lifted ? 0.62 : 1;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = lifted ? 18 : 8;
    ctx.shadowOffsetY = lifted ? 16 : 4;
    const body = ctx.createLinearGradient(0, y, 0, y + CRATE_H);
    body.addColorStop(0, crateColor(c.id, 58));
    body.addColorStop(1, crateColor(c.id, 38));
    fillSquircle(ctx, x, y, CRATE_W, CRATE_H, RADIUS.crate, body);
    ctx.restore();
    if (buried) return;

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
    if (moving) return;

    if (s.pileSize > 1) {
      const label = `+${s.pileSize - 1}`;
      ctx.font = '800 10px system-ui, sans-serif';
      const w = ctx.measureText(label).width + 10;
      fillSquircle(ctx, x - 8, y - 8, w, 16, RADIUS.small, '#e5e7eb');
      ctx.fillStyle = '#111';
      ctx.fillText(label, x - 8 + w / 2, y + 4);
    }
    if (c.zone === 'dock') {
      ctx.fillStyle = C.dim;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`waiting ${minutes(this.now() - c.zoneSince)}`, cx, y - 6);
    }
    if (c.readyToShip) {
      fillSquircle(ctx, x + CRATE_W - 26, y - 9, 36, 15, RADIUS.small, C.ship);
      ctx.fillStyle = '#052e22';
      ctx.font = '800 9px system-ui, sans-serif';
      ctx.fillText('SHIP?', x + CRATE_W - 8, y + 2);
    }
  }
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

function smoke(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, seed: number): void {
  for (let k = 0; k < 3; k++) {
    const phase = (t / 3200 + k / 3 + seed * 0.17) % 1;
    const size = 7 + phase * 12;
    squirclePath(ctx, x + phase * 10 - size / 2, y - phase * 30 - size / 2, size, size, size * 0.3);
    ctx.fillStyle = `rgba(205,200,192,${0.24 * (1 - phase)})`;
    ctx.fill();
  }
}

function drawOperator(ctx: CanvasRenderingContext2D): void {
  const { x, y } = OPERATOR;
  fillSquircle(ctx, x - 34, y + 14, 68, 22, RADIUS.small, '#3a3026');
  fillSquircle(ctx, x - 26, y + 17, 24, 10, RADIUS.small, '#5bc0eb');
  fillSquircle(ctx, x - 12, y - 10, 24, 26, RADIUS.medium, '#2563eb');
  fillSquircle(ctx, x - 9, y - 28, 18, 18, RADIUS.medium, '#f1c27d');
  fillSquircle(ctx, x - 12, y - 32, 24, 9, RADIUS.small, C.orange);
  fillSquircle(ctx, x - 15, y - 25, 30, 4, 2, C.orange);
  ctx.fillStyle = C.text;
  ctx.font = '800 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('YOU', x, y + 52);
}

const MACHINE_W = 148;
const MACHINE_H = 76;
const TOP_ROW_Y = 148;

type MachineMode = 'idle' | 'working' | 'jammed';

function modeOf(crate: CrateView | undefined): MachineMode {
  if (!crate) return 'idle';
  return crate.zone === 'alert' ? 'jammed' : 'working';
}

/** Machine housing behind the crate: snug around it, with stack, lamp and status band. */
function machineBack(ctx: CanvasRenderingContext2D, pos: Point, t: number, index: number, crate: CrateView | undefined): void {
  const mode = modeOf(crate);
  const x = pos.x - MACHINE_W / 2;
  const y = pos.y - MACHINE_H / 2;
  ctx.save();
  ctx.shadowColor = mode === 'jammed' ? 'rgba(239,68,68,0.5)' : mode === 'working' ? 'rgba(246,181,69,0.35)' : 'rgba(0,0,0,0.5)';
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
  ctx.fillStyle = mode === 'jammed' ? C.alert : mode === 'working' ? C.orange : '#6b6258';
  ctx.fillRect(x, y, MACHINE_W, 7);
  ctx.restore();
  fillSquircle(ctx, x + MACHINE_W - 24, y - 12, 13, 16, RADIUS.small, '#4a4e55');
  if (mode === 'working') smoke(ctx, x + MACHINE_W - 18, y - 16, t, index);
  fillSquircle(ctx, x + 6, y + 11, 7, 7, 2, mode === 'jammed' ? C.alert : mode === 'working' ? '#4ade80' : '#3b3f45');
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
 * A jammed machine gets a hazard frame and a big alert badge. Signs sit on the side away from the bus.
 */
function machineFront(ctx: CanvasRenderingContext2D, pos: Point, t: number, crate: CrateView | undefined): void {
  const mode = modeOf(crate);
  const color = mode === 'working' ? C.amber : mode === 'jammed' ? '#f87171' : '#5b5f66';
  const spin = mode === 'working' ? t / 750 : mode === 'jammed' ? strain(t, pos.x) : 0;
  cog(ctx, pos.x - MACHINE_W / 2 + 10, pos.y + 6, 22, spin, color);
  cog(ctx, pos.x + MACHINE_W / 2 - 10, pos.y + 6, 22, -spin, color);
  if (!crate) return;

  const topRow = pos.y < TOP_ROW_Y + 1;
  if (mode === 'jammed') {
    hazardRim(ctx, { x: pos.x - MACHINE_W / 2 - 6, y: pos.y - MACHINE_H / 2 - 6, w: MACHINE_W + 12, h: MACHINE_H + 12 }, 6);
    const by = topRow ? pos.y - MACHINE_H / 2 - 22 : pos.y + MACHINE_H / 2 - 14;
    ctx.save();
    ctx.shadowColor = C.alert;
    ctx.shadowBlur = 16;
    fillSquircle(ctx, pos.x - 18, by, 36, 36, RADIUS.medium, C.alert);
    ctx.restore();
    ctx.fillStyle = '#fff';
    ctx.font = '900 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('!', pos.x, by + 27);
  }

  const sign = mode === 'jammed' ? (crate.alertReason ?? 'needs you') : crate.waitingOn ? `⏳ ${crate.waitingOn}` : crate.lastTool;
  if (!sign) return;
  ctx.font = '700 10px ui-monospace, monospace';
  const label = short(sign, 22);
  const tw = ctx.measureText(label).width + 14;
  const sx = mode === 'jammed' ? pos.x + 24 : pos.x - tw / 2;
  const sy = topRow ? pos.y - MACHINE_H / 2 - 20 : pos.y + MACHINE_H / 2 + 4;
  fillSquircle(ctx, sx, sy, tw, 16, RADIUS.small, mode === 'jammed' ? '#450a0a' : '#121315');
  ctx.fillStyle = mode === 'jammed' ? '#fecaca' : crate.waitingOn ? '#93c5fd' : C.amber;
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
  const clear = (p: Point) => p.y > 8 && !areas.some((a) => p.x > a.x && p.x < a.x + a.w && p.y > a.y && p.y < a.y + a.h) && offBelts(p);
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

  g.fillStyle = '#3d3226';
  const rail = AREAS.freight;
  for (let x = rail.x + 16; x < rail.x + rail.w - 10; x += 13) {
    squirclePath(g, x - 2.5, TRAIN_Y + 10, 5, 20, 1.5);
    g.fill();
  }
  g.strokeStyle = '#8a8f96';
  g.lineWidth = 3;
  for (const ry of [TRAIN_Y + 14, TRAIN_Y + 26]) {
    g.beginPath();
    g.moveTo(rail.x + 10, ry);
    g.lineTo(rail.x + rail.w - 10, ry);
    g.stroke();
  }
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
const TITLE_INSET: Partial<Record<Area, number>> = { dock: 62, storage: 48 };

function foundation(g: CanvasRenderingContext2D, key: Area, a: (typeof AREAS)[Area]): void {
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
  const left = a.w < 250 ? a.x + (a.w - tw - 20) / 2 : a.x + (TITLE_INSET[key] ?? 16);
  fillSquircle(g, left, a.y + 12, tw + 20, 24, RADIUS.small, C.orange);
  g.fillStyle = '#1a1208';
  g.textAlign = 'left';
  g.fillText(a.title, left + 10, a.y + 29);
  if (a.w > 300) {
    g.fillStyle = C.dim;
    g.font = '12px system-ui, sans-serif';
    g.fillText(a.subtitle, left + tw + 30, a.y + 29);
  }
}

/** Yellow/black hazard-striped frame of the given thickness around a rectangle. */
function hazardRim(g: CanvasRenderingContext2D, a: { x: number; y: number; w: number; h: number }, thickness: number): void {
  const rim = new Path2D();
  addSquircle(rim, a.x, a.y, a.w, a.h, RADIUS.large);
  addSquircle(rim, a.x + thickness, a.y + thickness, a.w - thickness * 2, a.h - thickness * 2, RADIUS.large - thickness / 2);
  g.save();
  g.clip(rim, 'evenodd');
  g.fillStyle = '#facc15';
  g.fillRect(a.x, a.y, a.w, a.h);
  g.fillStyle = '#18140c';
  for (let i = -a.h; i < a.w; i += 14) {
    g.beginPath();
    g.moveTo(a.x + i, a.y + a.h);
    g.lineTo(a.x + i + 7, a.y + a.h);
    g.lineTo(a.x + i + 7 + a.h, a.y);
    g.lineTo(a.x + i + a.h, a.y);
    g.closePath();
    g.fill();
  }
  g.restore();
}

/** Same squircle outline as squirclePath, but into a Path2D (needed for the even-odd hazard rim). */
function addSquircle(p: Path2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = r * 0.16;
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.bezierCurveTo(x + w - k, y, x + w, y + k, x + w, y + r);
  p.lineTo(x + w, y + h - r);
  p.bezierCurveTo(x + w, y + h - k, x + w - k, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h);
  p.bezierCurveTo(x + k, y + h, x, y + h - k, x, y + h - r);
  p.lineTo(x, y + r);
  p.bezierCurveTo(x, y + k, x + k, y, x + r, y);
  p.closePath();
}

/** Loading gantry straddling the freight belt and the wagon below it; the hook drops while a crate is loaded. */
function drawGantry(ctx: CanvasRenderingContext2D, busy: boolean): void {
  const { x, y } = FREIGHT_LOAD;
  const top = y - 30;
  const bottom = TRAIN_Y + 22;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 4;
  for (const px of [x - 56, x + 50]) fillSquircle(ctx, px, top, 6, bottom - top, 2, '#5b5f66');
  fillSquircle(ctx, x - 58, top - 6, 116, 10, RADIUS.small, C.orangeDark);
  ctx.restore();
  fillSquircle(ctx, x - 58, top - 6, 116, 3, 1.5, C.orange);
  fillSquircle(ctx, x - 12, top - 9, 24, 16, RADIUS.small, '#3a3e45');
  if (busy) {
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, top + 7);
    ctx.lineTo(x, y - CRATE_H / 2 + 2);
    ctx.stroke();
  }
  ctx.fillStyle = C.dim;
  ctx.font = '700 9px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('LOADING', x, top - 12);
}
