import type { CrateView, Zone } from '../src/shared/types';
import { ALL_TRACKS, BELT_SPEED, FREIGHT_LOAD, fromHopper, HOPPER_DROP, JUNCTIONS, NET, type SlotRef, type Track, travel } from './belts';
import { AREAS, type Area, CRATE_H, CRATE_W, H, HOPPER, OPERATOR, type Point, TRAIN_Y, W } from './layout';
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
  path: Point[];
  to: SlotRef;
}

interface Sprite {
  x: number;
  y: number;
  /** Where the crate is heading (or sits); used to keep slots sticky. */
  at: SlotRef;
  /** Where the trip it is on right now ends. */
  currentTo: SlotRef;
  path: Point[];
  /** At most one trip is queued behind the current one, so rapid state changes never pile up detours. */
  next?: Leg;
  leaving: boolean;
  pileRank: number;
  pileSize: number;
}

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

const QUEUE_ZONES = new Set<Zone>(['dock', 'intake']);

export class Scene {
  private sprites = new Map<string, Sprite>();
  private crates = new Map<string, CrateView>();
  private archivedCount = 0;
  private serverNow = Date.now();
  private clientAtSync = Date.now();
  private staticLayer: HTMLCanvasElement | null = null;
  private staticKey = '';

  setCrates(crates: CrateView[], now: number): void {
    const first = this.crates.size === 0 && this.sprites.size === 0;
    this.serverNow = now;
    this.clientAtSync = Date.now();
    this.crates = new Map(crates.map((c) => [c.id, c]));
    this.archivedCount = crates.filter((c) => c.archived).length;

    const byZone = new Map<Zone, CrateView[]>();
    for (const c of crates) if (!c.archived) byZone.set(c.zone, [...(byZone.get(c.zone) ?? []), c]);

    for (const [zone, list] of byZone) {
      const assigned = QUEUE_ZONES.has(zone) ? this.queueSlots(zone, list) : this.stickySlots(zone, list);
      const piles = new Map<number, CrateView[]>();
      for (const c of list) piles.set(assigned.get(c.id)!, [...(piles.get(assigned.get(c.id)!) ?? []), c]);
      for (const [slot, pile] of piles) {
        pile.sort((a, b) => b.zoneSince - a.zoneSince);
        pile.forEach((c, rank) => this.place(c, { zone, slot }, first, rank, pile.length));
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

  /** Dock and intake are queues on the belt itself: order decides position, the back of the queue piles up. */
  private queueSlots(zone: Zone, list: CrateView[]): Map<string, number> {
    const cap = NET[zone].slots.length;
    const ordered = [...list].sort((a, b) => (zone === 'dock' ? a.zoneSince - b.zoneSince : a.startedAt - b.startedAt));
    return new Map(ordered.map((c, i) => [c.id, Math.min(i, cap - 1)]));
  }

  /** Machines, alert spots and storage spots keep their crate until it leaves; extras pile on the last spot. */
  private stickySlots(zone: Zone, list: CrateView[]): Map<string, number> {
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

  private place(c: CrateView, to: SlotRef, instant: boolean, pileRank: number, pileSize: number): void {
    let s = this.sprites.get(c.id);
    if (!s) {
      const pos = NET[to.zone].slots[to.slot].pos;
      if (instant) {
        s = { ...pos, at: to, currentTo: to, path: [], leaving: false, pileRank, pileSize };
      } else if (c.reactivationCount > 0) {
        s = { ...FREIGHT_LOAD, at: to, currentTo: to, path: travel({ zone: 'freight', slot: 0 }, to), leaving: false, pileRank, pileSize };
      } else {
        s = { x: HOPPER_DROP.x, y: HOPPER.y + HOPPER.h - CRATE_H / 2, at: to, currentTo: to, path: fromHopper(to), leaving: false, pileRank, pileSize };
      }
      this.sprites.set(c.id, s);
      return;
    }
    if (s.leaving) {
      s.leaving = false;
      s.path = [];
      s.next = undefined;
      s.x = FREIGHT_LOAD.x;
      s.y = FREIGHT_LOAD.y;
      s.at = { zone: 'freight', slot: 0 };
      s.currentTo = s.at;
    }
    s.pileRank = pileRank;
    s.pileSize = pileSize;
    if (s.at.zone !== to.zone || s.at.slot !== to.slot) this.go(s, to);
  }

  /** Sends a sprite to a slot along the belts, after finishing the trip it is already on. */
  private go(s: Sprite, to: SlotRef): void {
    const same = (a: SlotRef, b: SlotRef) => a.zone === b.zone && a.slot === b.slot;
    if (!s.path.length && !s.next) {
      s.path = travel(s.currentTo, to);
      s.currentTo = to;
    } else {
      s.next = same(s.currentTo, to) ? undefined : { path: travel(s.currentTo, to), to };
    }
    s.at = to;
  }

  update(dt: number): void {
    for (const [id, s] of this.sprites) {
      let budget = BELT_SPEED * dt;
      while (budget > 0 && (s.path.length || s.next)) {
        if (!s.path.length && s.next) {
          s.path = s.next.path;
          s.currentTo = s.next.to;
          s.next = undefined;
        }
        const p = s.path[0];
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
      if (s.leaving && !s.path.length && !s.next) this.sprites.delete(id);
    }
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
    for (const track of ALL_TRACKS) drawBelt(ctx, track, t);
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
    const x0 = a.x + 24;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    const loco = ctx.createLinearGradient(0, TRAIN_Y - 22, 0, TRAIN_Y + 16);
    loco.addColorStop(0, '#f6a24a');
    loco.addColorStop(1, C.orangeDark);
    fillSquircle(ctx, x0, TRAIN_Y - 20, 66, 34, RADIUS.medium, loco);
    fillSquircle(ctx, x0 + 76, TRAIN_Y - 8, 106, 22, RADIUS.small, '#4a4e55');
    ctx.restore();
    fillSquircle(ctx, x0 + 10, TRAIN_Y - 14, 20, 11, RADIUS.small, '#16181b');
    fillSquircle(ctx, x0 + 46, TRAIN_Y - 30, 10, 12, RADIUS.small, '#6b6f76');
    for (let i = 0; i < Math.min(this.archivedCount, 8); i++) {
      fillSquircle(ctx, x0 + 80 + (i % 4) * 25, TRAIN_Y - 24 - Math.floor(i / 4) * 15, 22, 14, RADIUS.small, i % 2 ? '#8a6f52' : '#7a614a');
    }
    for (const wx of [x0 + 14, x0 + 50, x0 + 92, x0 + 166]) {
      squircleAt(ctx, wx, TRAIN_Y + 16, 12);
      ctx.fillStyle = '#121315';
      ctx.fill();
    }
    smoke(ctx, x0 + 51, TRAIN_Y - 34, t, 0);
    ctx.fillStyle = C.text;
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('WAREHOUSE', a.x + 115, a.y + 120);
    ctx.fillStyle = C.dim;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${this.archivedCount} archived`, a.x + 115, a.y + 138);
    ctx.fillText('click to browse', a.x + 115, a.y + 156);
  }

  private drawCrate(ctx: CanvasRenderingContext2D, c: CrateView, s: Sprite, hover: boolean, selected: boolean): void {
    const moving = s.path.length > 0 || !!s.next;
    const off = this.pileOffset(s);
    const x = Math.round(off.x - CRATE_W / 2);
    const y = Math.round(off.y - CRATE_H / 2);
    const cx = x + CRATE_W / 2;
    const parked = c.zone === 'storage' && !moving;
    const buried = !moving && s.pileRank > 0;

    ctx.save();
    ctx.globalAlpha = parked ? 0.62 : 1;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
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
    if (c.zone === 'alert') {
      ctx.save();
      ctx.shadowColor = C.alert;
      ctx.shadowBlur = 10;
      fillSquircle(ctx, cx - 11, y - 28, 22, 22, RADIUS.medium, C.alert);
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.font = '900 15px system-ui, sans-serif';
      ctx.fillText('!', cx, y - 11);
      if (c.alertReason) {
        ctx.fillStyle = '#fca5a5';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(c.alertReason, cx, y + CRATE_H + (c.jiraKey && c.jiraKey !== c.label ? 30 : 14));
      }
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

/** Belt body, then plates with seams travelling in the belt's own direction. Later belts cover earlier ones at joins. */
function drawBelt(ctx: CanvasRenderingContext2D, track: Track, t: number): void {
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
  ctx.lineDashOffset = -Math.round((t / 1000) * BELT_SPEED);
  strokeTrack(ctx, track);
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

/** Machine housing behind the crate: snug around it, with stack, lamp and status band. */
function machineBack(ctx: CanvasRenderingContext2D, pos: Point, t: number, index: number, crate: CrateView | undefined): void {
  const active = !!crate;
  const x = pos.x - MACHINE_W / 2;
  const y = pos.y - MACHINE_H / 2;
  ctx.save();
  ctx.shadowColor = active ? 'rgba(246,181,69,0.35)' : 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = active ? 18 : 10;
  ctx.shadowOffsetY = active ? 0 : 4;
  const body = ctx.createLinearGradient(0, y, 0, y + MACHINE_H);
  body.addColorStop(0, C.machineTop);
  body.addColorStop(1, C.machineBottom);
  fillSquircle(ctx, x, y, MACHINE_W, MACHINE_H, RADIUS.large, body);
  ctx.restore();
  ctx.save();
  squirclePath(ctx, x, y, MACHINE_W, MACHINE_H, RADIUS.large);
  ctx.clip();
  ctx.fillStyle = active ? C.orange : '#6b6258';
  ctx.fillRect(x, y, MACHINE_W, 7);
  ctx.restore();
  fillSquircle(ctx, x + MACHINE_W - 24, y - 12, 13, 16, RADIUS.small, '#4a4e55');
  if (active) smoke(ctx, x + MACHINE_W - 18, y - 16, t, index);
  fillSquircle(ctx, x + 6, y + 11, 7, 7, 2, active ? '#4ade80' : '#3b3f45');
}

/** Cogs overlap the crate's sides, turning slowly while Claude works; the tool sign sits on the far side from the bus. */
function machineFront(ctx: CanvasRenderingContext2D, pos: Point, t: number, crate: CrateView | undefined): void {
  const active = !!crate;
  const color = active ? C.amber : '#5b5f66';
  cog(ctx, pos.x - MACHINE_W / 2 + 10, pos.y + 6, 22, active ? t / 2400 : 0, color);
  cog(ctx, pos.x + MACHINE_W / 2 - 10, pos.y + 6, 22, active ? -t / 2400 : 0, color);
  if (!crate) return;
  const sign = crate.waitingOn ? `⏳ ${crate.waitingOn}` : crate.lastTool;
  if (!sign) return;
  ctx.font = '600 10px ui-monospace, monospace';
  const label = short(sign, 22);
  const tw = ctx.measureText(label).width + 14;
  const sy = pos.y < TOP_ROW_Y + 1 ? pos.y - MACHINE_H / 2 - 20 : pos.y + MACHINE_H / 2 + 4;
  fillSquircle(ctx, pos.x - tw / 2, sy, tw, 16, RADIUS.small, '#121315');
  ctx.fillStyle = crate.waitingOn ? '#93c5fd' : C.amber;
  ctx.textAlign = 'center';
  ctx.fillText(label, pos.x, sy + 12);
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
  const clear = (p: Point) => !areas.some((a) => p.x > a.x - 26 && p.x < a.x + a.w + 26 && p.y > a.y - 26 && p.y < a.y + a.h + 26) && !(p.y > 380 && p.y < 500);
  for (let i = 0; i < 260; i++) {
    const p = { x: rnd() * W, y: rnd() * H };
    if (!clear(p)) continue;
    if (rnd() < 0.5) {
      const w = 6 + rnd() * 12;
      const h = 4 + rnd() * 7;
      squirclePath(g, p.x - w / 2, p.y - h / 2, w, h, Math.min(w, h) * 0.3);
      g.fillStyle = C.rock;
      g.fill();
    } else {
      plant(g, p.x, p.y, rnd);
    }
  }

  for (const [key, a] of Object.entries(AREAS) as [Area, (typeof AREAS)[Area]][]) foundation(g, key, a);

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
const TITLE_INSET: Partial<Record<Area, number>> = { freight: 52, dock: 62, storage: 48 };

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

  if (key === 'alert') hazardRim(g, a);
  else {
    g.strokeStyle = C.concreteEdge;
    g.lineWidth = 3;
    squirclePath(g, a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3, RADIUS.large - 1);
    g.stroke();
  }

  const left = a.x + (TITLE_INSET[key] ?? 16);
  g.font = '800 13px system-ui, sans-serif';
  const tw = g.measureText(a.title).width;
  fillSquircle(g, left, a.y + 12, tw + 20, 24, RADIUS.small, key === 'alert' ? C.alert : C.orange);
  g.fillStyle = '#1a1208';
  g.textAlign = 'left';
  g.fillText(a.title, left + 10, a.y + 29);
  if (a.w > 300) {
    g.fillStyle = C.dim;
    g.font = '12px system-ui, sans-serif';
    g.fillText(a.subtitle, left + tw + 30, a.y + 29);
  }
}

function hazardRim(g: CanvasRenderingContext2D, a: { x: number; y: number; w: number; h: number }): void {
  const rim = new Path2D();
  addSquircle(rim, a.x, a.y, a.w, a.h, RADIUS.large);
  addSquircle(rim, a.x + 7, a.y + 7, a.w - 14, a.h - 14, RADIUS.large - 5);
  g.save();
  g.clip(rim, 'evenodd');
  g.fillStyle = '#facc15';
  g.fillRect(a.x, a.y, a.w, a.h);
  g.fillStyle = '#18140c';
  for (let i = -a.h; i < a.w; i += 18) {
    g.beginPath();
    g.moveTo(a.x + i, a.y + a.h);
    g.lineTo(a.x + i + 9, a.y + a.h);
    g.lineTo(a.x + i + 9 + a.h, a.y);
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
