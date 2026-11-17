import type { CrateView, Zone } from '../src/shared/types';
import { ALL_TRACKS, BELT_SPEED, LOOP, route, type Track } from './belts';
import { AREAS, type Area, CRATE_H, CRATE_W, H, HOPPER, inRect, machineRects, OPERATOR, type Point, type Rect, slotPosition, TRAIN_Y, W } from './layout';

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
  beltSurface: '#1f2023',
  slat: '#383a40',
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
  wobble: number;
}

export function repoColor(repo: string, light = 52): string {
  let h = 0;
  for (const ch of repo) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 55%, ${light}%)`;
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
        s.path = [...this.exitFromSlot(s), ...route(s.zone, 'freight', { x: AREAS.freight.x + 160, y: TRAIN_Y - 34 })];
        s.leaving = true;
        s.zone = 'freight';
      }
    }
  }

  /** A crate first walks inside its building to the out-feeder before riding belts. */
  private exitFromSlot(s: Sprite): Point[] {
    return s.path.length ? [] : [{ x: s.x, y: s.y }];
  }

  private place(c: CrateView, target: Point, instant: boolean): void {
    let s = this.sprites.get(c.id);
    if (!s) {
      const start = instant ? target : { x: HOPPER.x + HOPPER.w / 2, y: HOPPER.y + HOPPER.h };
      s = { ...start, zone: instant ? c.zone : 'intake', path: [], target, leaving: false, wobble: Math.random() * 6 };
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
    for (const track of ALL_TRACKS) beltMotion(ctx, track, t);
    this.drawHopper(ctx, t, opts.terminals);
    this.drawMachines(ctx, t);
    this.drawAlertPads(ctx, t);
    this.drawOperator(ctx, t);
    this.drawTrain(ctx, t);

    const order = [...this.sprites.entries()].sort((a, b) => a[1].y - b[1].y);
    for (const [id, s] of order) {
      const c = this.crates.get(id);
      if (c) this.drawCrate(ctx, c, s, t, id === opts.hover, id === opts.selected);
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

  private drawHopper(ctx: CanvasRenderingContext2D, t: number, clickable: boolean): void {
    const { x, y, w, h } = HOPPER;
    const cx = x + w / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 5;
    ctx.beginPath();
    ctx.moveTo(x, y + 6);
    ctx.quadraticCurveTo(x, y, x + 8, y);
    ctx.lineTo(x + w - 8, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + 6);
    ctx.bezierCurveTo(x + w, y + h * 0.55, cx + 22, y + h * 0.6, cx + 20, y + h);
    ctx.lineTo(cx - 20, y + h);
    ctx.bezierCurveTo(cx - 22, y + h * 0.6, x, y + h * 0.55, x, y + 6);
    const grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, C.machineTop);
    grad.addColorStop(1, C.machineBottom);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = C.orange;
    ctx.beginPath();
    ctx.roundRect(x - 3, y - 4, w + 6, 12, 6);
    ctx.fill();
    ctx.fillStyle = C.text;
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HOPPER', cx, y + 40);
    if (clickable) {
      ctx.fillStyle = `rgba(246,181,69,${0.55 + 0.35 * Math.sin(t / 500)})`;
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText('click for a new session', cx, y + 56);
    }
  }

  private drawMachines(ctx: CanvasRenderingContext2D, t: number): void {
    const working = [...this.crates.values()].filter((c) => !c.archived && c.zone === 'working').sort((a, b) => a.startedAt - b.startedAt);
    machineRects(this.workingCount).forEach((m, i) => {
      const crate = working[i];
      const s = crate ? this.sprites.get(crate.id) : undefined;
      const arrived = !!s && !s.path.length;
      drawMachine(ctx, m, t, i, arrived ? crate : undefined);
    });
  }

  private drawAlertPads(ctx: CanvasRenderingContext2D, t: number): void {
    const alerts = [...this.crates.values()].filter((c) => !c.archived && c.zone === 'alert').length;
    for (let i = 0; i < Math.max(8, alerts); i++) {
      const p = slotPosition('alert', i, alerts);
      const lit = i < alerts;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 6, 42, 32, 0, 0, Math.PI * 2);
      ctx.fillStyle = lit ? `rgba(239,68,68,${0.16 + 0.1 * Math.sin(t / 200)})` : 'rgba(255,255,255,0.03)';
      ctx.fill();
      ctx.strokeStyle = lit ? 'rgba(239,68,68,0.6)' : 'rgba(250,204,21,0.18)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawOperator(ctx: CanvasRenderingContext2D, t: number): void {
    const { x, y } = OPERATOR;
    ctx.fillStyle = '#3a3026';
    ctx.beginPath();
    ctx.roundRect(x - 30, y + 18, 60, 22, 8);
    ctx.fill();
    ctx.fillStyle = '#5bc0eb';
    ctx.beginPath();
    ctx.roundRect(x - 22, y + 20, 22, 10, 3);
    ctx.fill();
    const bob = Math.sin(t / 700) * 1.5;
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.roundRect(x - 13, y - 6 + bob, 26, 28, 10);
    ctx.fill();
    ctx.fillStyle = '#f1c27d';
    ctx.beginPath();
    ctx.arc(x, y - 16 + bob, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.orange;
    ctx.beginPath();
    ctx.arc(x, y - 19 + bob, 11.5, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x, y - 19 + bob, 15, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.text;
    ctx.font = '800 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('YOU', x, y + 56);
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
    ctx.fillStyle = loco;
    ctx.beginPath();
    ctx.roundRect(x0, TRAIN_Y - 20, 70, 38, [16, 8, 6, 6]);
    ctx.fill();
    ctx.fillStyle = '#4a4e55';
    ctx.beginPath();
    ctx.roundRect(x0 + 82, TRAIN_Y - 8, 116, 26, 6);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#16181b';
    ctx.beginPath();
    ctx.roundRect(x0 + 10, TRAIN_Y - 13, 20, 12, 4);
    ctx.fill();
    ctx.fillStyle = '#6b6f76';
    ctx.beginPath();
    ctx.roundRect(x0 + 48, TRAIN_Y - 32, 10, 14, 3);
    ctx.fill();
    for (let i = 0; i < Math.min(this.archivedCount, 8); i++) {
      ctx.fillStyle = i % 2 ? '#8a6f52' : '#7a614a';
      ctx.beginPath();
      ctx.roundRect(x0 + 88 + (i % 4) * 27, TRAIN_Y - 26 - Math.floor(i / 4) * 17, 23, 16, 3);
      ctx.fill();
    }
    ctx.fillStyle = '#121315';
    for (const wx of [x0 + 16, x0 + 54, x0 + 100, x0 + 180]) {
      ctx.beginPath();
      ctx.arc(wx, TRAIN_Y + 20, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let k = 0; k < 3; k++) {
      const phase = ((t / 1800 + k / 3) % 1);
      ctx.fillStyle = `rgba(210,205,198,${0.35 * (1 - phase)})`;
      ctx.beginPath();
      ctx.arc(x0 + 53 + phase * 14, TRAIN_Y - 36 - phase * 40, 5 + phase * 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = C.text;
    ctx.font = '700 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Warehouse  ·  ${this.archivedCount} archived`, a.x + a.w / 2, a.y + 76);
    ctx.fillStyle = C.dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('click to browse or bring back', a.x + a.w / 2, a.y + 94);
  }

  private drawCrate(ctx: CanvasRenderingContext2D, c: CrateView, s: Sprite, t: number, hover: boolean, selected: boolean): void {
    const moving = s.path.length > 0;
    const bob = moving ? Math.sin(t / 120 + s.wobble) * 1.2 : 0;
    const x = s.x - CRATE_W / 2;
    const y = s.y - CRATE_H / 2 + bob;
    const parked = c.zone === 'storage' && !moving;

    ctx.save();
    ctx.globalAlpha = parked ? 0.62 : 1;
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
    const body = ctx.createLinearGradient(0, y, 0, y + CRATE_H);
    body.addColorStop(0, repoColor(c.repo, 60));
    body.addColorStop(1, repoColor(c.repo, 40));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.roundRect(x, y, CRATE_W, CRATE_H, 8);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = parked ? 0.62 : 1;
    ctx.strokeStyle = repoColor(c.repo, 28);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(x + 1.5, y + 1.5, CRATE_W - 3, CRATE_H - 3, 7);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    for (const fx of [0.3, 0.7]) {
      ctx.beginPath();
      ctx.moveTo(x + CRATE_W * fx, y + 4);
      ctx.lineTo(x + CRATE_W * fx, y + CRATE_H - 4);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const [bx, by] of [[5, 5], [CRATE_W - 5, 5], [5, CRATE_H - 5], [CRATE_W - 5, CRATE_H - 5]]) {
      ctx.beginPath();
      ctx.arc(x + bx, y + by, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(14,12,10,0.8)';
    ctx.beginPath();
    ctx.roundRect(x + 5, y + CRATE_H / 2 - 9, CRATE_W - 10, 18, 9);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(short(c.jiraKey ?? c.repo, 9), s.x, y + CRATE_H / 2 + 4);
    ctx.restore();

    if (selected || hover) {
      ctx.strokeStyle = selected ? C.amber : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x - 5, y - 5, CRATE_W + 10, CRATE_H + 10, 12);
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    if (!moving || hover) {
      const caption = short(c.label, 18);
      ctx.font = '600 11px system-ui, sans-serif';
      const w = ctx.measureText(caption).width + 12;
      ctx.fillStyle = 'rgba(14,12,10,0.7)';
      ctx.beginPath();
      ctx.roundRect(s.x - w / 2, y + CRATE_H + 4, w, 16, 8);
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.fillText(caption, s.x, y + CRATE_H + 16);
    }
    if (moving) return;

    if (c.zone === 'alert') {
      const pulse = 1 + 0.12 * Math.sin(t / 140);
      const by = y - 18 + Math.sin(t / 260) * 2;
      ctx.save();
      ctx.shadowColor = C.alert;
      ctx.shadowBlur = 14;
      ctx.fillStyle = C.alert;
      ctx.beginPath();
      ctx.arc(s.x, by, 12 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.font = '900 16px system-ui, sans-serif';
      ctx.fillText('!', s.x, by + 6);
      if (c.alertReason) {
        ctx.fillStyle = '#fca5a5';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(c.alertReason, s.x, y + CRATE_H + 32);
      }
    }
    if (c.zone === 'dock') {
      ctx.fillStyle = C.dim;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`waiting ${minutes(this.now() - c.zoneSince)}`, s.x, y - 7);
    }
    if (c.readyToShip) {
      ctx.fillStyle = C.ship;
      ctx.beginPath();
      ctx.roundRect(x + CRATE_W - 24, y - 10, 34, 15, 7);
      ctx.fill();
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
  ctx.lineCap = track === LOOP ? 'butt' : 'round';
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

/** Slats and chevrons travel along the track's own direction. */
function beltMotion(ctx: CanvasRenderingContext2D, track: Track, t: number): void {
  const travelled = (t / 1000) * BELT_SPEED;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.slat;
  ctx.lineWidth = 20;
  ctx.setLineDash([3, 7]);
  ctx.lineDashOffset = -travelled;
  strokeTrack(ctx, track);
  ctx.restore();

  const spacing = 70;
  ctx.strokeStyle = 'rgba(246,181,69,0.55)';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  for (let s = (travelled % spacing) + 10; s < track.total - 6; s += spacing) {
    const p = track.at(s);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.beginPath();
    ctx.moveTo(-4, -6);
    ctx.lineTo(3, 0);
    ctx.lineTo(-4, 6);
    ctx.stroke();
    ctx.restore();
  }
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
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.roundRect(m.x, m.y, m.w, m.h, 18);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = active ? C.orange : '#6b6258';
  ctx.beginPath();
  ctx.roundRect(m.x, m.y, m.w, 16, [18, 18, 4, 4]);
  ctx.fill();

  ctx.fillStyle = '#4a4e55';
  ctx.beginPath();
  ctx.roundRect(m.x + m.w - 30, m.y - 14, 14, 22, [6, 6, 0, 0]);
  ctx.fill();
  if (active) {
    for (let k = 0; k < 3; k++) {
      const phase = (t / 1600 + k / 3 + i * 0.17) % 1;
      ctx.fillStyle = `rgba(200,195,188,${0.3 * (1 - phase)})`;
      ctx.beginPath();
      ctx.arc(m.x + m.w - 23 + phase * 10, m.y - 18 - phase * 30, 4 + phase * 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const lampOn = active && Math.floor(t / 600 + i) % 2 === 0;
  ctx.fillStyle = lampOn ? '#4ade80' : active ? '#166534' : '#3b3f45';
  ctx.beginPath();
  ctx.arc(m.x + 16, m.y + 28, 5, 0, Math.PI * 2);
  ctx.fill();

  const wy = m.y + m.h / 2 + 10;
  ctx.fillStyle = C.window;
  ctx.beginPath();
  ctx.roundRect(cx - 44, wy - 30, 88, 60, 16);
  ctx.fill();
  if (active) {
    const glow = ctx.createRadialGradient(cx, wy, 6, cx, wy, 50);
    glow.addColorStop(0, `rgba(246,181,69,${0.25 + 0.1 * Math.sin(t / 180 + i)})`);
    glow.addColorStop(1, 'rgba(246,181,69,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.roundRect(cx - 44, wy - 30, 88, 60, 16);
    ctx.fill();
  }

  gear(ctx, m.x + 22, m.y + m.h - 22, 11, active ? t / 450 : 0, active ? C.amber : '#5b5f66');
  gear(ctx, m.x + m.w - 22, m.y + m.h - 24, 8, active ? -t / 320 : 0, active ? C.amber : '#5b5f66');

  if (crate) {
    const sign = crate.waitingOn ? `⏳ ${crate.waitingOn}` : crate.lastTool;
    if (sign) {
      ctx.font = '600 10px ui-monospace, monospace';
      const label = short(sign, 24);
      const tw = ctx.measureText(label).width + 14;
      ctx.fillStyle = '#121315';
      ctx.beginPath();
      ctx.roundRect(cx - tw / 2, m.y + 20, tw, 17, 8.5);
      ctx.fill();
      ctx.fillStyle = crate.waitingOn ? '#93c5fd' : C.amber;
      ctx.textAlign = 'center';
      ctx.fillText(label, cx, m.y + 32);
    }
  }
}

function gear(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, angle: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  for (let k = 0; k < 8; k++) {
    ctx.rotate(Math.PI / 4);
    ctx.beginPath();
    ctx.roundRect(-r * 0.24, -r - 3, r * 0.48, 6, 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.machineBottom;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintScenery(g: CanvasRenderingContext2D): void {
  const floor = g.createRadialGradient(W / 2, H / 2, 200, W / 2, H / 2, 950);
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
      g.fillStyle = C.rock;
      g.beginPath();
      g.ellipse(p.x, p.y, 3 + rnd() * 7, 2 + rnd() * 4, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    } else {
      plant(g, p.x, p.y, rnd);
    }
  }

  for (const [key, a] of Object.entries(AREAS) as [Area, (typeof AREAS)[Area]][]) foundation(g, key, a);

  const rail = AREAS.freight;
  g.strokeStyle = '#3d3226';
  g.lineWidth = 5;
  for (let x = rail.x + 16; x < rail.x + rail.w - 10; x += 13) {
    g.beginPath();
    g.moveTo(x, TRAIN_Y + 14);
    g.lineTo(x, TRAIN_Y + 34);
    g.stroke();
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
  g.beginPath();
  g.roundRect(OPERATOR.x + 50, OPERATOR.y - 36, dock.x + dock.w - OPERATOR.x - 70, 76, 30);
  g.stroke();
  g.setLineDash([]);

  for (let i = 0; i < 12; i++) {
    const p = slotPosition('storage', i, 12);
    g.strokeStyle = 'rgba(160,140,110,0.25)';
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(p.x - 40, p.y - 30, 80, 60, 10);
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
    g.fillStyle = C.plantTip;
    g.globalAlpha = 0.7;
    g.beginPath();
    g.arc(ex, ey, 2, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }
}

function foundation(g: CanvasRenderingContext2D, key: Area, a: (typeof AREAS)[Area]): void {
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 22;
  g.shadowOffsetY = 8;
  g.fillStyle = C.concrete;
  g.beginPath();
  g.roundRect(a.x, a.y, a.w, a.h, 22);
  g.fill();
  g.restore();

  g.save();
  g.beginPath();
  g.roundRect(a.x, a.y, a.w, a.h, 22);
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
    g.beginPath();
    g.roundRect(a.x + 1.5, a.y + 1.5, a.w - 3, a.h - 3, 21);
    g.stroke();
  }

  g.font = '800 13px system-ui, sans-serif';
  const tw = g.measureText(a.title).width;
  g.fillStyle = key === 'alert' ? C.alert : C.orange;
  g.beginPath();
  g.roundRect(a.x + 14, a.y + 10, tw + 22, 24, 12);
  g.fill();
  g.fillStyle = '#1a1208';
  g.textAlign = 'left';
  g.fillText(a.title, a.x + 25, a.y + 27);
  g.fillStyle = C.dim;
  g.font = '12px system-ui, sans-serif';
  g.fillText(a.subtitle, a.x + tw + 46, a.y + 27);
}

function hazardRim(g: CanvasRenderingContext2D, a: Rect): void {
  g.save();
  g.beginPath();
  g.roundRect(a.x, a.y, a.w, a.h, 22);
  g.roundRect(a.x + 7, a.y + 7, a.w - 14, a.h - 14, 16);
  g.clip('evenodd');
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
