/**
 * Squircle (continuous-corner) shapes. The factory never draws true circles or ovals;
 * every rounded thing goes through these helpers.
 */

/** Cubic-bezier handle as a fraction of the corner radius, measured from the corner point. Lower = squarer. */
const HANDLE = 0.16;

export function squirclePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = r * HANDLE;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.bezierCurveTo(x + w - k, y, x + w, y + k, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.bezierCurveTo(x + w, y + h - k, x + w - k, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.bezierCurveTo(x + k, y + h, x, y + h - k, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.bezierCurveTo(x, y + k, x + k, y, x + r, y);
  ctx.closePath();
}

/** A small squircle centred on (cx, cy): the stand-in for a dot, wheel, lamp or badge. */
export function squircleAt(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  squirclePath(ctx, cx - size / 2, cy - size / 2, size, size, size * 0.3);
}
