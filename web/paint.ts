/**
 * Canvas painting for the factory and warehouse: the palette, small drawing helpers, and painters for scenery,
 * belts, machines, cranes and the operator. Everything here draws from its arguments only and keeps no scene state.
 */
import type { CrateView } from '../src/shared/types';
import { ALL_TRACKS, type Track } from './belts';
import { AREAS, type Area, H, MACHINE_H, MACHINE_W, OPERATOR, type Point, TRAIN_Y, W } from './layout';
import type { Crane } from './crane';
import { STACKS, TRAIN, WAREHOUSE_X } from './warehouse';
import { squirclePath } from './shapes';

export const C = {
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
export const RADIUS = { crate: 14, small: 4, medium: 7, large: 12 };
/** Stable colour per crate (sessions roam across repos, so the directory is no use for this). */
export function crateColor(id: string, light = 52): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 50%, ${light}%)`;
}

export function minutes(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60 ? `${m % 60}m` : ''}` : `${Math.floor(h / 24)}d`;
}

export function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Splits text into at most `lines` lines that fit `width`, ellipsising the last. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
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
export function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

export function fillSquircle(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient): void {
  squirclePath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function strokeTrack(ctx: CanvasRenderingContext2D, track: Track): void {
  ctx.beginPath();
  track.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (track.closed) ctx.closePath();
  ctx.stroke();
}

export const trackIds = new Map<Track, number>(ALL_TRACKS.map((t, i) => [t, i]));

export function sectionKey(track: Track, section: number): string {
  return `${trackIds.get(track)}:${section}`;
}

export const sectionPaths = new Map<Track, Point[][]>();

export function sectionPoints(track: Track): Point[][] {
  let paths = sectionPaths.get(track);
  if (!paths) {
    paths = track.splits.length ? track.sections().map(([a, b]) => track.between(a, b)) : [track.closed ? [...track.pts, track.pts[0]] : track.pts];
    sectionPaths.set(track, paths);
  }
  return paths;
}

export function strokePoints(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
}

/**
 * Belt body, then plates with seams travelling in the belt's own direction, section by section.
 * Section joints are drawn as dark rollers across the belt. Later belts cover earlier ones at joins.
 */
export function drawBelt(ctx: CanvasRenderingContext2D, track: Track, travelled: (section: number) => number): void {
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
  // Each section's plates carry on the pattern from the start of the belt, so a belt whose sections have all run
  // alike looks like one belt.
  const starts = [0, ...track.splits];
  sectionPoints(track).forEach((pts, i) => {
    ctx.lineDashOffset = starts[i] - travelled(i);
    strokePoints(ctx, pts);
  });
  ctx.setLineDash([]);
  for (const joint of track.joints) {
    const p = track.at(joint);
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
export function junction(ctx: CanvasRenderingContext2D, p: Point): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  fillSquircle(ctx, p.x - 17, p.y - 17, 34, 34, RADIUS.medium, '#3a3e45');
  ctx.restore();
  fillSquircle(ctx, p.x - 17, p.y - 17, 34, 6, RADIUS.small, C.orange);
  fillSquircle(ctx, p.x - 9, p.y - 6, 18, 14, RADIUS.small, '#1d1f23');
}

export function drawOperator(ctx: CanvasRenderingContext2D, t: number): void {
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

export const TOP_ROW_Y = 148;

export type MachineMode = 'idle' | 'working' | 'jammed';

export function modeOf(crate: CrateView | undefined): MachineMode {
  if (!crate) return 'idle';
  return crate.zone === 'alert' ? 'jammed' : 'working';
}

/** Jam colours: red when blocked on a prompt, yellow when its last message asked you something. */
export function jamColors(crate: CrateView | undefined): { fill: string; glow: string; cog: string; ink: string } {
  return crate?.alertReason === 'asked a question'
    ? { fill: C.awaiting, glow: 'rgba(250,204,21,0.5)', cog: '#fde047', ink: '#1c1917' }
    : { fill: C.alert, glow: 'rgba(239,68,68,0.5)', cog: '#f87171', ink: '#fff' };
}

/** Machine housing behind the crate: snug around it, with stack, lamp and status band. */
export function machineBack(ctx: CanvasRenderingContext2D, pos: Point, t: number, index: number, crate: CrateView | undefined): void {
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
export function strain(t: number, offset: number): number {
  const phase = ((t + offset) % 1600) / 1600;
  if (phase < 0.12) return 0.32 * Math.sin((phase / 0.12) * (Math.PI / 2));
  if (phase < 0.45) return 0.32 * (1 - (phase - 0.12) / 0.33);
  return 0;
}

/**
 * Cogs overlap the crate's sides: turning while Claude works, straining against a jam while it waits on you.
 * A jammed machine gets a big alert badge. Signs sit on the side away from the bus.
 */
export function machineFront(ctx: CanvasRenderingContext2D, pos: Point, t: number, crate: CrateView | undefined): void {
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
export function cog(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, angle: number, color: string): void {
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

export function paintScenery(g: CanvasRenderingContext2D): void {
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
export function paintWarehouse(g: CanvasRenderingContext2D): void {
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
export function paintRail(g: CanvasRenderingContext2D): void {
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

export function plant(g: CanvasRenderingContext2D, x: number, y: number, rnd: () => number): void {
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
export const TITLE_INSET: Partial<Record<Area | 'warehouse', number>> = { dock: 52, storage: 104 };

export function foundation(g: CanvasRenderingContext2D, key: Area | 'warehouse', a: (typeof AREAS)[Area]): void {
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
export function drawCrane(ctx: CanvasRenderingContext2D, crane: Crane, r: { left: number; right: number; top: number; bottom: number }): void {
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
