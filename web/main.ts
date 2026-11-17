import '@xterm/xterm/css/xterm.css';
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

const ui = new Ui();

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
  return { x: (e.clientX - r.left) / scale + scene.camX, y: (e.clientY - r.top) / scale };
}

canvas.addEventListener('mousemove', (e) => {
  const p = toFloor(e);
  hover = scene.hit(p);
  const overTarget = hover || scene.onTrain(p) || inRect(p, AREAS.freight) || (state?.features.terminals && inRect(p, HOPPER));
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
  if (id && state?.crates.find((c) => c.id === id)?.archived) ui.openStack(scene.stackOf(id), e.clientX, e.clientY);
  else if (id) ui.select(id);
  // The train takes you across in either direction; the freight station leads to the warehouse.
  else if (scene.onTrain(p)) (scene.onWarehouse ? ui.showFactory() : ui.openWarehouse());
  else if (inRect(p, AREAS.freight)) ui.openWarehouse();
  else if (state?.features.terminals && inRect(p, HOPPER)) ui.openNewSession();
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
  },
  (up) => ui.setConnected(up),
);

// Sideways scroll or swipe pans between the factory and the warehouse.
canvas.addEventListener(
  'wheel',
  (e) => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (Math.abs(dx) < 8) return;
    e.preventDefault();
    if (dx > 0) ui.openWarehouse();
    else ui.showFactory();
  },
  { passive: false },
);

ui.onPan = (where) => scene.panTo(where);
scene.onFollowTrain = (where) => (where === 'factory' ? ui.showFactory() : ui.openWarehouse());
ui.onSearch = (q) => (scene.highlight = q);

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
