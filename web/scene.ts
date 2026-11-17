import type { CrateView, Zone } from '../src/shared/types';
import { ALL_TRACKS, BELT_SPEED, LOOP, route, type Track } from './belts';
import { AREAS, type Area, CRATE_H, CRATE_W, H, HOPPER, inRect, machineRects, OPERATOR, type Point, type Rect, slotPosition, TRAIN_Y, W } from './layout';
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
  beltSurface: '#141517',
  section: '#34363c',
  machineTop: '#565c66',
  machineBottom: '#30343a',
  window: '#0e0f11',
  alert: '#ef4444',
  ship: '#34d399',
  plant: '#2f7466',
  plantTip: '#62d1b2',
  rock: '#2c2723',
};

interface Sprite {
  x: number;
  y: number;
  zone: Area;
  path: Point[];
  target: Point;
  leaving: boolean;
}

/** Stable colour per crate (sessions roam across repos, so the directory is no use for this). */
export function crateColor(id: string, light = 52): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 50%, ${light}%)`;
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

export class Scene {
  private sprites = new Map<string, Sprite>();
  private crates = new Map<string, CrateView>();
  private workingCount = 0;
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
    for (const c of crates) {
      if (!c.archived) byZone.set(c.zone, [...(byZone.get(c.zone) ?? []), c]);
    }
    this.workingCount = byZone.get('working')?.length ?? 0;
    for (const [zone, list] of byZone) {
      list.sort((a, b) => (zone === 'dock' ? a.zoneSince - b.zoneSince : a.startedAt - b.startedAt));
      list.forEach((c, i) => this.place(c, slotPosition(zone, i, list.length), first));
    }

    for (const [id, s] of this.sprites) {
      const c = this.crates.get(id);
      if (!c) this.sprites.delete(id);
      else if (c.archived && !s.leaving) {
        s.path = route(s.zone, 'freight', { x: AREAS.freight.x + 160, y: TRAIN_Y - 34 });
        s.leaving = true;
        s.zone = 'freight';
      }
    }
  }

  private place(c: CrateView, target: Point, instant: boolean): void {
    let s = this.sprites.get(c.id);
    if (!s) {
      const start = instant ? target : { x: HOPPER.x + HOPPER.w / 2, y: HOPPER.y + HOPPER.h };
      s = { ...start, zone: instant ? c.zone : 'intake', path: [], target, leaving: false };
      this.sprites.set(c.id, s);
    }
    if (s.leaving) {
      s.leaving = false;
      s.path = [];
      s.x = AREAS.freight.x + 160;
      s.y = TRAIN_Y - 34;
      s.zone = 'freight';
    }
    if (s.zone !== c.zone) {
      s.path = route(s.zone, c.zone, target);
      s.zone = c.zone;
    } else if (s.target.x !== target.x || s.target.y !== target.y) {
      s.path = [...s.path.slice(0, -1), target];
    }
    s.target = target;
  }

  update(dt: number): void {
    for (const [id, s] of this.sprites) {
      let budget = BELT_SPEED * dt;
      while (budget > 0 && s.path.length) {
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
      if (s.leaving && !s.path.length) this.sprites.delete(id);
    }
  }

  hit(p: Point): string | null {
    for (const id of [...this.sprites.keys()].reverse()) {
      const s = this.sprites.get(id)!;
      if (!s.leaving && Math.abs(p.x - s.x) <= CRATE_W / 2 + 3 && Math.abs(p.y - s.y) <= CRATE_H / 2 + 3) return id;
    }
    return null;
  }

  isOverHopper(p: Point): boolean {
    return inRect(p, HOPPER);
  }

  private now(): number {
    return this.serverNow + (Date.now() - this.clientAtSync);
  }

  draw(ctx: CanvasRenderingContext2D, t: number, opts: { hover: string | null; selected: string | null; terminals: boolean; pixelRatio: number }): void {
    this.drawStatic(ctx, opts.pixelRatio);
    for (const track of ALL_TRACKS) beltSections(ctx, track, t);
    this.drawHopper(ctx, opts.terminals);
    this.drawMachines(ctx, t);
    this.drawAlertPads(ctx);
    drawOperator(ctx);
    this.drawTrain(ctx, t);

    const order = [...this.sprites.entries()].sort((a, b) => a[1].y - b[1].y);
    for (const [id, s] of order) {
      const c = this.crates.get(id);
      if (c) this.drawCrate(ctx, c, s, id === opts.hover, id === opts.selected);
    }
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
    ctx.moveTo(x, y + 8);
    ctx.bezierCurveTo(x, y + 1, x + 1, y, x + 10, y);
    ctx.lineTo(x + w - 10, y);
    ctx.bezierCurveTo(x + w - 1, y, x + w, y + 1, x + w, y + 8);
    ctx.bezierCurveTo(x + w, y + h * 0.55, cx + 22, y + h * 0.6, cx + 20, y + h);
    ctx.lineTo(cx - 20, y + h);
    ctx.bezierCurveTo(cx - 22, y + h * 0.6, x, y + h * 0.55, x, y + 8);
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, C.machineTop);
    grad.addColorStop(1, C.machineBottom);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    fillSquircle(ctx, x - 3, y - 4, w + 6, 12, 6, C.orange);
    ctx.fillStyle = C.text;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HOPPER', cx, y + 40);
    if (clickable) {
      ctx.fillStyle = C.amber;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText('click for a new session', cx, y + 56);
    }
  }

  private drawMachines(ctx: CanvasRenderingContext2D, t: number): void {
    const working = [...this.crates.values()].filter((c) => !c.archived && c.zone === 'working').sort((a, b) => a.startedAt - b.startedAt);
    machineRects(this.workingCount).forEach((m, i) => {
      const crate = working[i];
      const s = crate ? this.sprites.get(crate.id) : undefined;
      drawMachine(ctx, m, t, i, s && !s.path.length ? crate : undefined);
    });
  }

  private drawAlertPads(ctx: CanvasRenderingContext2D): void {
    const alerts = [...this.crates.values()].filter((c) => !c.archived && c.zone === 'alert').length;
    for (let i = 0; i < Math.max(8, alerts); i++) {
      const p = slotPosition('alert', i, alerts);
      const lit = i < alerts;
      squirclePath(ctx, p.x - 64, p.y - 36, 128, 84, 26);
      ctx.fillStyle = lit ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.03)';
      ctx.fill();
      ctx.strokeStyle = lit ? 'rgba(239,68,68,0.6)' : 'rgba(250,204,21,0.18)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawTrain(ctx: CanvasRenderingContext2D, t: number): void {
    const a = AREAS.freight;
    const x0 = a.x + 22;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    const loco = ctx.createLinearGradient(0, TRAIN_Y - 24, 0, TRAIN_Y + 18);
    loco.addColorStop(0, '#f6a24a');
    loco.addColorStop(1, C.orangeDark);
    fillSquircle(ctx, x0, TRAIN_Y - 20, 70, 38, 14, loco);
    fillSquircle(ctx, x0 + 82, TRAIN_Y - 8, 116, 26, 8, '#4a4e55');
    ctx.restore();
    fillSquircle(ctx, x0 + 10, TRAIN_Y - 13, 20, 12, 5, '#16181b');
    fillSquircle(ctx, x0 + 48, TRAIN_Y - 32, 10, 14, 4, '#6b6f76');
    for (let i = 0; i < Math.min(this.archivedCount, 8); i++) {
      fillSquircle(ctx, x0 + 88 + (i % 4) * 27, TRAIN_Y - 26 - Math.floor(i / 4) * 17, 23, 16, 5, i % 2 ? '#8a6f52' : '#7a614a');
    }
    for (const wx of [x0 + 16, x0 + 54, x0 + 100, x0 + 180]) {
      squircleAt(ctx, wx, TRAIN_Y + 20, 14);
      ctx.fillStyle = '#121315';
      ctx.fill();
    }
    smoke(ctx, x0 + 53, TRAIN_Y - 36, t, 0);
    ctx.fillStyle = C.text;
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Warehouse  ·  ${this.archivedCount} archived`, a.x + a.w / 2, a.y + 76);
    ctx.fillStyle = C.dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('click to browse or bring back', a.x + a.w / 2, a.y + 94);
  }

  private drawCrate(ctx: CanvasRenderingContext2D, c: CrateView, s: Sprite, hover: boolean, selected: boolean): void {
    const moving = s.path.length > 0;
    const x = Math.round(s.x - CRATE_W / 2);
    const y = Math.round(s.y - CRATE_H / 2);
    const cx = x + CRATE_W / 2;
    const parked = c.zone === 'storage' && !moving;

    ctx.save();
    ctx.globalAlpha = parked ? 0.62 : 1;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
    const body = ctx.createLinearGradient(0, y, 0, y + CRATE_H);
    body.addColorStop(0, crateColor(c.id, 58));
    body.addColorStop(1, crateColor(c.id, 38));
    fillSquircle(ctx, x, y, CRATE_W, CRATE_H, 14, body);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = parked ? 0.62 : 1;
    ctx.strokeStyle = crateColor(c.id, 26);
    ctx.lineWidth = 2.5;
    squirclePath(ctx, x + 1.5, y + 1.5, CRATE_W - 3, CRATE_H - 3, 13);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    for (const [bx, by] of [[4, CRATE_H / 2], [CRATE_W - 4, CRATE_H / 2]]) {
      squircleAt(ctx, x + bx, y + by, 3.5);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fill();
    }
    fillSquircle(ctx, x + 6, y + 7, CRATE_W - 12, CRATE_H - 14, 9, 'rgba(14,12,10,0.8)');
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
      squirclePath(ctx, x - 5, y - 5, CRATE_W + 10, CRATE_H + 10, 15);
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    if (c.jiraKey && c.jiraKey !== c.label && (!moving || hover)) {
      ctx.font = '700 10px ui-monospace, monospace';
      const w = ctx.measureText(c.jiraKey).width + 14;
      fillSquircle(ctx, cx - w / 2, y + CRATE_H + 4, w, 16, 6, 'rgba(14,12,10,0.7)');
      ctx.fillStyle = C.text;
      ctx.fillText(c.jiraKey, cx, y + CRATE_H + 15);
    }
    if (moving) return;

    if (c.zone === 'alert') {
      ctx.save();
      ctx.shadowColor = C.alert;
      ctx.shadowBlur = 12;
      fillSquircle(ctx, cx - 12, y - 30, 24, 24, 10, C.alert);
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.font = '900 16px system-ui, sans-serif';
      ctx.fillText('!', cx, y - 12);
      if (c.alertReason) {
        ctx.fillStyle = '#fca5a5';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(c.alertReason, cx, y + CRATE_H + (c.jiraKey && c.jiraKey !== c.label ? 32 : 16));
      }
    }
    if (c.zone === 'dock') {
      ctx.fillStyle = C.dim;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`waiting ${minutes(this.now() - c.zoneSince)}`, cx, y - 7);
    }
    if (c.readyToShip) {
      fillSquircle(ctx, x + CRATE_W - 24, y - 10, 34, 15, 6, C.ship);
      ctx.fillStyle = '#052e22';
      ctx.font = '800 9px system-ui, sans-serif';
      ctx.fillText('SHIP?', x + CRATE_W - 7, y + 1);
    }
  }
}

function strokeTrack(ctx: CanvasRenderingContext2D, track: Track): void {
  ctx.beginPath();
  track.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (track.closed) ctx.closePath();
  ctx.stroke();
}

function beltBase(ctx: CanvasRenderingContext2D, track: Track): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 34;
  ctx.save();
  ctx.translate(0, 4);
  strokeTrack(ctx, track);
  ctx.restore();
  ctx.strokeStyle = C.rail;
  ctx.lineWidth = 30;
  strokeTrack(ctx, track);
  ctx.strokeStyle = '#5f646c';
  ctx.lineWidth = 27;
  strokeTrack(ctx, track);
  ctx.strokeStyle = C.beltSurface;
  ctx.lineWidth = 22;
  strokeTrack(ctx, track);
}

/** The belt is drawn as plates with seams that travel in the belt's own direction. */
function beltSections(ctx: CanvasRenderingContext2D, track: Track, t: number): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.section;
  ctx.lineWidth = 20;
  ctx.setLineDash([26, 4]);
  ctx.lineDashOffset = -Math.round((t / 1000) * BELT_SPEED);
  strokeTrack(ctx, track);
  ctx.restore();
}

function smoke(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, seed: number): void {
  for (let k = 0; k < 3; k++) {
    const phase = (t / 3200 + k / 3 + seed * 0.17) % 1;
    const size = 8 + phase * 14;
    squircleAt(ctx, x + phase * 12, y - phase * 36, size);
    ctx.fillStyle = `rgba(205,200,192,${0.26 * (1 - phase)})`;
    ctx.fill();
  }
}

function drawOperator(ctx: CanvasRenderingContext2D): void {
  const { x, y } = OPERATOR;
  fillSquircle(ctx, x - 30, y + 18, 60, 22, 9, '#3a3026');
  fillSquircle(ctx, x - 22, y + 20, 22, 10, 4, '#5bc0eb');
  fillSquircle(ctx, x - 13, y - 6, 26, 28, 11, '#2563eb');
  fillSquircle(ctx, x - 10, y - 26, 20, 20, 9, '#f1c27d');
  fillSquircle(ctx, x - 13, y - 31, 26, 11, 5, C.orange);
  fillSquircle(ctx, x - 16, y - 23, 32, 5, 2.5, C.orange);
  ctx.fillStyle = C.text;
  ctx.font = '800 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('YOU', x, y + 56);
}

function drawMachine(ctx: CanvasRenderingContext2D, m: Rect, t: number, i: number, crate: CrateView | undefined): void {
  const active = !!crate;
  const cx = m.x + m.w / 2;
  ctx.save();
  ctx.shadowColor = active ? 'rgba(246,181,69,0.35)' : 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = active ? 22 : 12;
  ctx.shadowOffsetY = active ? 0 : 5;
  const body = ctx.createLinearGradient(0, m.y, 0, m.y + m.h);
  body.addColorStop(0, C.machineTop);
  body.addColorStop(1, C.machineBottom);
  fillSquircle(ctx, m.x, m.y, m.w, m.h, 26, body);
  ctx.restore();

  ctx.save();
  squirclePath(ctx, m.x, m.y, m.w, m.h, 26);
  ctx.clip();
  ctx.fillStyle = active ? C.orange : '#6b6258';
  ctx.fillRect(m.x, m.y, m.w, 16);
  ctx.restore();

  fillSquircle(ctx, m.x + m.w - 31, m.y - 14, 16, 22, 6, '#4a4e55');
  if (active) smoke(ctx, m.x + m.w - 23, m.y - 18, t, i);

  squircleAt(ctx, m.x + 18, m.y + 28, 10);
  ctx.fillStyle = active ? '#4ade80' : '#3b3f45';
  ctx.fill();

  const wy = m.y + m.h / 2 + 10;
  fillSquircle(ctx, cx - 68, wy - 36, 136, 72, 22, C.window);
  if (active) {
    const glow = ctx.createLinearGradient(0, wy - 36, 0, wy + 36);
    glow.addColorStop(0, 'rgba(246,181,69,0.05)');
    glow.addColorStop(1, 'rgba(246,181,69,0.28)');
    fillSquircle(ctx, cx - 68, wy - 36, 136, 72, 22, glow);
  }

  if (crate) {
    const sign = crate.waitingOn ? `⏳ ${crate.waitingOn}` : crate.lastTool;
    if (sign) {
      ctx.font = '600 10px ui-monospace, monospace';
      const label = short(sign, 24);
      const tw = ctx.measureText(label).width + 16;
      fillSquircle(ctx, cx - tw / 2, m.y + 20, tw, 18, 7, '#121315');
      ctx.fillStyle = crate.waitingOn ? '#93c5fd' : C.amber;
      ctx.textAlign = 'center';
      ctx.fillText(label, cx, m.y + 33);
    }
  }
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
      squirclePath(g, p.x - w / 2, p.y - h / 2, w, h, Math.min(w, h) / 2);
      g.fillStyle = C.rock;
      g.fill();
    } else {
      plant(g, p.x, p.y, rnd);
    }
  }

  for (const [key, a] of Object.entries(AREAS) as [Area, (typeof AREAS)[Area]][]) foundation(g, key, a);

  const rail = AREAS.freight;
  g.fillStyle = '#3d3226';
  for (let x = rail.x + 16; x < rail.x + rail.w - 10; x += 13) {
    squirclePath(g, x - 2.5, TRAIN_Y + 14, 5, 20, 2);
    g.fill();
  }
  g.strokeStyle = '#8a8f96';
  g.lineWidth = 3;
  for (const ry of [TRAIN_Y + 18, TRAIN_Y + 30]) {
    g.beginPath();
    g.moveTo(rail.x + 10, ry);
    g.lineTo(rail.x + rail.w - 10, ry);
    g.stroke();
  }

  const dock = AREAS.dock;
  g.strokeStyle = 'rgba(250,204,21,0.35)';
  g.lineWidth = 2;
  g.setLineDash([10, 8]);
  squirclePath(g, OPERATOR.x + 50, OPERATOR.y - 36, dock.x + dock.w - OPERATOR.x - 70, 76, 34);
  g.stroke();
  g.setLineDash([]);

  for (let i = 0; i < 9; i++) {
    const p = slotPosition('storage', i, 9);
    g.strokeStyle = 'rgba(160,140,110,0.25)';
    g.lineWidth = 3;
    squirclePath(g, p.x - 63, p.y - 33, 126, 66, 20);
    g.stroke();
  }

  for (const track of ALL_TRACKS) if (track !== LOOP) beltBase(g, track);
  beltBase(g, LOOP);
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
    squircleAt(g, ex, ey, 4);
    g.fillStyle = C.plantTip;
    g.fill();
    g.globalAlpha = 1;
  }
}

function foundation(g: CanvasRenderingContext2D, key: Area, a: (typeof AREAS)[Area]): void {
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 22;
  g.shadowOffsetY = 8;
  fillSquircle(g, a.x, a.y, a.w, a.h, 40, C.concrete);
  g.restore();

  g.save();
  squirclePath(g, a.x, a.y, a.w, a.h, 40);
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
    squirclePath(g, a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3, 39);
    g.stroke();
  }

  g.font = '800 13px system-ui, sans-serif';
  const tw = g.measureText(a.title).width;
  fillSquircle(g, a.x + 18, a.y + 12, tw + 24, 24, 9, key === 'alert' ? C.alert : C.orange);
  g.fillStyle = '#1a1208';
  g.textAlign = 'left';
  g.fillText(a.title, a.x + 30, a.y + 29);
  g.fillStyle = C.dim;
  g.font = '12px system-ui, sans-serif';
  g.fillText(a.subtitle, a.x + tw + 52, a.y + 29);
}

function hazardRim(g: CanvasRenderingContext2D, a: Rect): void {
  const rim = new Path2D();
  addSquircle(rim, a.x, a.y, a.w, a.h, 40);
  addSquircle(rim, a.x + 7, a.y + 7, a.w - 14, a.h - 14, 33);
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
