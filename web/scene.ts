import type { CrateView, Zone } from '../src/shared/types';
import {
  AREAS,
  type Area,
  BELT_Y,
  beltPath,
  CRATE_H,
  CRATE_W,
  H,
  HOPPER,
  machineRects,
  OPERATOR,
  type Point,
  slotPosition,
  TRAIN_Y,
  W,
} from './layout';

const SPEED = 560;
const C = {
  floor: '#15171a',
  grid: '#1d2024',
  foundation: '#20242a',
  edge: '#3a4048',
  orange: '#f28c28',
  amber: '#f6b545',
  text: '#d9dde3',
  dim: '#8a929c',
  belt: '#2b2f35',
  beltEdge: '#555c66',
  machine: '#363c45',
  machineDark: '#272b31',
  alert: '#ef4444',
  ship: '#34d399',
};

interface Sprite {
  x: number;
  y: number;
  zone: Area;
  path: Point[];
  target: Point;
  leaving: boolean;
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

export class Scene {
  private sprites = new Map<string, Sprite>();
  private crates = new Map<string, CrateView>();
  private workingCount = 0;
  private archivedCount = 0;
  private serverNow = Date.now();
  private clientAtSync = Date.now();

  setCrates(crates: CrateView[], now: number): void {
    const first = this.crates.size === 0 && this.sprites.size === 0;
    this.serverNow = now;
    this.clientAtSync = Date.now();
    this.crates = new Map(crates.map((c) => [c.id, c]));
    this.archivedCount = crates.filter((c) => c.archived).length;

    const byZone = new Map<Zone, CrateView[]>();
    for (const c of crates) {
      if (c.archived) continue;
      byZone.set(c.zone, [...(byZone.get(c.zone) ?? []), c]);
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
        const dest = { x: AREAS.freight.x + 150, y: TRAIN_Y - 30 };
        s.path = beltPath(s, s.zone, 'freight', dest);
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
      s.x = AREAS.freight.x + 150;
      s.y = TRAIN_Y - 30;
      s.zone = 'freight';
    }
    if (s.zone !== c.zone) {
      s.path = beltPath(s, s.zone, c.zone, target);
      s.zone = c.zone;
    } else if (s.target.x !== target.x || s.target.y !== target.y) {
      s.path = [target];
    }
    s.target = target;
  }

  update(dt: number): void {
    for (const [id, s] of this.sprites) {
      let budget = SPEED * dt;
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
    const ids = [...this.sprites.keys()].reverse();
    for (const id of ids) {
      const s = this.sprites.get(id)!;
      if (s.leaving) continue;
      if (Math.abs(p.x - s.x) <= CRATE_W / 2 + 2 && Math.abs(p.y - s.y) <= CRATE_H / 2 + 2) return id;
    }
    return null;
  }

  private now(): number {
    return this.serverNow + (Date.now() - this.clientAtSync);
  }

  draw(ctx: CanvasRenderingContext2D, t: number, opts: { hover: string | null; selected: string | null; terminals: boolean }): void {
    ctx.fillStyle = C.floor;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) line(ctx, x, 0, x, H);
    for (let y = 0; y <= H; y += 40) line(ctx, 0, y, W, y);

    this.drawBelts(ctx, t);
    for (const [key, area] of Object.entries(AREAS) as [Area, (typeof AREAS)[Area]][]) this.drawFoundation(ctx, key, area, t);
    this.drawHopper(ctx, opts.terminals);
    this.drawMachines(ctx, t);
    this.drawOperator(ctx);
    this.drawTrain(ctx, t);

    for (const [id, s] of this.sprites) {
      const c = this.crates.get(id);
      if (c) this.drawCrate(ctx, c, s, t, id === opts.hover, id === opts.selected);
    }
  }

  private drawFoundation(ctx: CanvasRenderingContext2D, key: Area, a: (typeof AREAS)[Area], t: number): void {
    ctx.fillStyle = C.foundation;
    roundRect(ctx, a.x, a.y, a.w, a.h, 6);
    ctx.fill();
    if (key === 'alert') {
      const pulse = this.hasAlerts() ? 0.55 + 0.45 * Math.sin(t / 180) : 0.35;
      hazardBorder(ctx, a.x, a.y, a.w, a.h, pulse);
    } else {
      ctx.strokeStyle = C.edge;
      ctx.lineWidth = 2;
      roundRect(ctx, a.x, a.y, a.w, a.h, 6);
      ctx.stroke();
    }
    ctx.fillStyle = key === 'alert' ? C.alert : C.orange;
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(a.title, a.x + 14, a.y + 24);
    const titleWidth = ctx.measureText(a.title).width;
    ctx.fillStyle = C.dim;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(a.subtitle, a.x + 24 + titleWidth, a.y + 24);
  }

  private hasAlerts(): boolean {
    for (const c of this.crates.values()) if (!c.archived && c.zone === 'alert') return true;
    return false;
  }

  private drawBelts(ctx: CanvasRenderingContext2D, t: number): void {
    const left = AREAS.intake.port - 14;
    const right = AREAS.alert.port + 14;
    belt(ctx, left, BELT_Y - 14, right - left, 28, t, 'h');
    for (const a of Object.values(AREAS)) {
      const top = a.y < BELT_Y ? a.y + a.h - 4 : BELT_Y + 14;
      const bottom = a.y < BELT_Y ? BELT_Y - 14 : a.y + 4;
      belt(ctx, a.port - 12, top, 24, bottom - top, t, 'v');
    }
  }

  private drawHopper(ctx: CanvasRenderingContext2D, clickable: boolean): void {
    const { x, y, w, h } = HOPPER;
    ctx.fillStyle = C.machine;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w * 0.68, y + h);
    ctx.lineTo(x + w * 0.32, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = C.orange;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = C.orange;
    ctx.fillRect(x, y, w, 8);
    ctx.fillStyle = C.text;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HOPPER', x + w / 2, y + 36);
    if (clickable) {
      ctx.fillStyle = C.dim;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText('click: new session', x + w / 2, y + 52);
    }
  }

  private drawMachines(ctx: CanvasRenderingContext2D, t: number): void {
    const working = [...this.sprites.entries()]
      .filter(([id, s]) => !s.leaving && this.crates.get(id)?.zone === 'working')
      .map(([id]) => this.crates.get(id)!)
      .sort((a, b) => a.startedAt - b.startedAt);
    machineRects(this.workingCount).forEach((m, i) => {
      const crate = working[i];
      const active = !!crate;
      ctx.fillStyle = C.machineDark;
      roundRect(ctx, m.x, m.y, m.w, m.h, 8);
      ctx.fill();
      ctx.fillStyle = C.machine;
      roundRect(ctx, m.x + 4, m.y + 4, m.w - 8, m.h - 8, 6);
      ctx.fill();
      ctx.fillStyle = active ? C.orange : '#59606a';
      ctx.fillRect(m.x + 4, m.y + 4, m.w - 8, 6);
      gear(ctx, m.x + 20, m.y + 26, 10, active ? t / 300 : 0, active ? C.amber : '#59606a');
      gear(ctx, m.x + m.w - 20, m.y + 26, 7, active ? -t / 220 : 0, active ? C.amber : '#59606a');
      if (active) {
        ctx.fillStyle = 'rgba(246,181,69,0.08)';
        roundRect(ctx, m.x - 4, m.y - 4, m.w + 8, m.h + 8, 10);
        ctx.fill();
        if (crate.lastTool) {
          ctx.fillStyle = '#0f1113';
          ctx.font = '600 10px ui-monospace, monospace';
          const label = short(crate.lastTool, 18);
          const tw = ctx.measureText(label).width + 10;
          roundRect(ctx, m.x + m.w / 2 - tw / 2, m.y + 12, tw, 16, 3);
          ctx.fill();
          ctx.fillStyle = C.amber;
          ctx.textAlign = 'center';
          ctx.fillText(label, m.x + m.w / 2, m.y + 24);
        }
        if (Math.sin(t / 90 + i) > 0.7) {
          ctx.fillStyle = C.amber;
          for (let k = 0; k < 3; k++) ctx.fillRect(m.x + m.w / 2 - 24 + Math.random() * 48, m.y + m.h - 14 - Math.random() * 6, 2, 2);
        }
      }
    });
  }

  private drawOperator(ctx: CanvasRenderingContext2D): void {
    const { x, y } = OPERATOR;
    ctx.fillStyle = '#3b82f6';
    roundRect(ctx, x - 12, y - 4, 24, 30, 6);
    ctx.fill();
    ctx.fillStyle = '#f1c27d';
    ctx.beginPath();
    ctx.arc(x, y - 14, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = C.orange;
    ctx.beginPath();
    ctx.arc(x, y - 17, 11, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(x - 13, y - 18, 26, 3);
    ctx.fillStyle = C.text;
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('YOU', x, y + 42);
  }

  private drawTrain(ctx: CanvasRenderingContext2D, t: number): void {
    const a = AREAS.freight;
    ctx.strokeStyle = '#6b6f75';
    ctx.lineWidth = 3;
    line(ctx, a.x + 10, TRAIN_Y + 22, a.x + a.w - 10, TRAIN_Y + 22);
    line(ctx, a.x + 10, TRAIN_Y + 30, a.x + a.w - 10, TRAIN_Y + 30);
    ctx.strokeStyle = '#4a3b2a';
    for (let x = a.x + 16; x < a.x + a.w - 10; x += 14) line(ctx, x, TRAIN_Y + 18, x, TRAIN_Y + 34);

    ctx.fillStyle = C.orange;
    roundRect(ctx, a.x + 22, TRAIN_Y - 18, 64, 38, 5);
    ctx.fill();
    ctx.fillStyle = '#0f1113';
    ctx.fillRect(a.x + 30, TRAIN_Y - 12, 18, 12);
    ctx.fillStyle = C.machine;
    roundRect(ctx, a.x + 96, TRAIN_Y - 10, 112, 30, 4);
    ctx.fill();
    const stacked = Math.min(this.archivedCount, 8);
    for (let i = 0; i < stacked; i++) {
      ctx.fillStyle = '#7c6a55';
      ctx.fillRect(a.x + 102 + (i % 4) * 26, TRAIN_Y - 30 - Math.floor(i / 4) * 18, 22, 16);
    }
    ctx.fillStyle = '#111';
    for (const wx of [a.x + 36, a.x + 72, a.x + 112, a.x + 192]) {
      ctx.beginPath();
      ctx.arc(wx, TRAIN_Y + 22, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    const puff = (t / 40) % 30;
    ctx.fillStyle = `rgba(200,200,200,${0.3 - puff / 100})`;
    ctx.beginPath();
    ctx.arc(a.x + 76, TRAIN_Y - 26 - puff, 6 + puff / 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = C.text;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Warehouse ▸  ${this.archivedCount} archived`, a.x + a.w / 2, a.y + 70);
    ctx.fillStyle = C.dim;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('click to browse or bring back', a.x + a.w / 2, a.y + 90);
  }

  private drawCrate(ctx: CanvasRenderingContext2D, c: CrateView, s: Sprite, t: number, hover: boolean, selected: boolean): void {
    const x = s.x - CRATE_W / 2;
    const y = s.y - CRATE_H / 2;
    const storage = c.zone === 'storage' && !s.path.length;
    ctx.save();
    ctx.globalAlpha = storage ? 0.6 : 1;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    roundRect(ctx, x + 3, y + 4, CRATE_W, CRATE_H, 5);
    ctx.fill();
    ctx.fillStyle = repoColor(c.repo);
    roundRect(ctx, x, y, CRATE_W, CRATE_H, 5);
    ctx.fill();
    ctx.strokeStyle = repoColor(c.repo, 30);
    ctx.lineWidth = 3;
    roundRect(ctx, x + 1.5, y + 1.5, CRATE_W - 3, CRATE_H - 3, 4);
    ctx.stroke();
    ctx.lineWidth = 2;
    line(ctx, x + 6, y + 6, x + CRATE_W - 6, y + CRATE_H - 6);
    line(ctx, x + CRATE_W - 6, y + 6, x + 6, y + CRATE_H - 6);

    ctx.fillStyle = 'rgba(10,10,12,0.78)';
    roundRect(ctx, x + 4, y + CRATE_H / 2 - 9, CRATE_W - 8, 18, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(short(c.jiraKey ?? c.repo, 9), s.x, s.y + 4);
    ctx.restore();

    if (selected || hover) {
      ctx.strokeStyle = selected ? C.amber : '#ffffff';
      ctx.lineWidth = 2;
      roundRect(ctx, x - 4, y - 4, CRATE_W + 8, CRATE_H + 8, 7);
      ctx.stroke();
    }

    if (s.path.length) return;
    ctx.fillStyle = C.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const caption = c.jiraKey && c.label === c.jiraKey ? (c.firstPrompt ?? c.label) : c.label;
    ctx.fillText(short(caption, 14), s.x, y + CRATE_H + 14);

    if (c.zone === 'alert') {
      const bob = Math.sin(t / 160) * 3;
      const on = Math.floor(t / 400) % 2 === 0;
      ctx.fillStyle = on ? C.alert : '#b91c1c';
      ctx.beginPath();
      ctx.arc(s.x, y - 14 + bob, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '900 15px system-ui, sans-serif';
      ctx.fillText('!', s.x, y - 9 + bob);
      if (c.alertReason) {
        ctx.fillStyle = '#fca5a5';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(c.alertReason, s.x, y + CRATE_H + 27);
      }
    }
    if (c.zone === 'dock') {
      ctx.fillStyle = C.dim;
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`waiting ${minutes(this.now() - c.zoneSince)}`, s.x, y - 6);
    }
    if (c.readyToShip) {
      ctx.fillStyle = C.ship;
      roundRect(ctx, x + CRATE_W - 26, y - 9, 34, 15, 3);
      ctx.fill();
      ctx.fillStyle = '#062e22';
      ctx.font = '700 9px system-ui, sans-serif';
      ctx.fillText('SHIP?', x + CRATE_W - 9, y + 2);
    }
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function belt(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t: number, dir: 'h' | 'v'): void {
  if (w <= 0 || h <= 0) return;
  ctx.fillStyle = C.belt;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = C.beltEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 2, y + 2, w - 4, h - 4);
  ctx.clip();
  ctx.strokeStyle = 'rgba(242,140,40,0.35)';
  ctx.lineWidth = 2;
  const offset = (t / 30) % 18;
  if (dir === 'h') {
    for (let px = x - 18 + offset; px < x + w; px += 18) {
      ctx.beginPath();
      ctx.moveTo(px, y + 6);
      ctx.lineTo(px + 6, y + h / 2);
      ctx.lineTo(px, y + h - 6);
      ctx.stroke();
    }
  } else {
    for (let py = y - 18 + offset; py < y + h; py += 18) {
      ctx.beginPath();
      ctx.moveTo(x + 5, py);
      ctx.lineTo(x + w / 2, py + 6);
      ctx.lineTo(x + w - 5, py);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function gear(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, angle: number, color: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  for (let i = 0; i < 8; i++) {
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-r * 0.22, -r - 3, r * 0.44, 5);
  }
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.machine;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function hazardBorder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.rect(x + 6, y + 6, w - 12, h - 12);
  ctx.clip('evenodd');
  ctx.fillStyle = '#facc15';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#111';
  for (let i = -h; i < w; i += 16) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + 8, y + h);
    ctx.lineTo(x + i + 8 + h, y);
    ctx.lineTo(x + i + h, y);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
