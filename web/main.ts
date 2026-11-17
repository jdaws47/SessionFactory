import type { FactoryState } from '../src/shared/types';
import { subscribe } from './api';
import { AREAS, H, HOPPER, inRect, type Point, W } from './layout';
import { Scene } from './scene';
import { Ui } from './ui';

const canvas = document.getElementById('floor') as HTMLCanvasElement;
const stage = document.getElementById('stage')!;
const ctx = canvas.getContext('2d')!;
const scene = new Scene();
let state: FactoryState | null = null;
let hover: string | null = null;
let scale = 1;
let pixelRatio = 1;

export const ui = new Ui(() => undefined);
export const handlers = {
  hopperClick: (_s: FactoryState) => {},
  stateChanged: (_s: FactoryState) => {},
};

function resize(): void {
  const rect = stage.getBoundingClientRect();
  scale = Math.min(rect.width / W, rect.height / H);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${W * scale}px`;
  canvas.style.height = `${H * scale}px`;
  canvas.width = Math.round(W * scale * dpr);
  canvas.height = Math.round(H * scale * dpr);
  pixelRatio = scale * dpr;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function toFloor(e: MouseEvent): Point {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

canvas.addEventListener('mousemove', (e) => {
  const p = toFloor(e);
  hover = scene.hit(p);
  const overTarget = hover || inRect(p, AREAS.freight) || (state?.features.terminals && inRect(p, HOPPER));
  canvas.style.cursor = overTarget ? 'pointer' : 'default';
  ui.showTooltip(hover ? (state?.crates.find((c) => c.id === hover) ?? null) : null, e.clientX, e.clientY);
});

canvas.addEventListener('mouseleave', () => {
  hover = null;
  ui.showTooltip(null, 0, 0);
});

canvas.addEventListener('click', (e) => {
  const p = toFloor(e);
  const id = scene.hit(p);
  if (id) ui.select(id);
  else if (inRect(p, AREAS.freight)) ui.openWarehouse();
  else if (state && inRect(p, HOPPER)) handlers.hopperClick(state);
  else ui.select(null);
});

let last = performance.now();
function frame(t: number): void {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  scene.update(dt);
  scene.draw(ctx, t, { hover, selected: ui.selectedId, terminals: !!state?.features.terminals, pixelRatio });
  requestAnimationFrame(frame);
}

subscribe(
  (s) => {
    state = s;
    scene.setCrates(s.crates, s.now);
    ui.setState(s);
    handlers.stateChanged(s);
  },
  (up) => ui.setConnected(up),
);

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
