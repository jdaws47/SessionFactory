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

/** A squircle centred on (cx, cy): the stand-in for a dot, wheel, lamp or badge. */
export function squircleAt(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  squirclePath(ctx, cx - size / 2, cy - size / 2, size, size, size / 2);
}

/**
 * Points along a superellipse (n = 4) corner centred on (cx, cy), from one angle to another in degrees.
 * Used for belt bends so curves read as squircle corners rather than circular arcs.
 */
export function squircleCorner(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): { x: number; y: number }[] {
  const steps = Math.max(8, Math.ceil((Math.abs(toDeg - fromDeg) / 90) * 14));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return { x: cx + r * Math.sign(c) * Math.sqrt(Math.abs(c)), y: cy + r * Math.sign(s) * Math.sqrt(Math.abs(s)) };
  });
}
