import type { Point } from './layout';

export type SmokeStyle = 'stack' | 'engine' | 'belch';

interface Particle {
  x: number;
  y: number;
  age: number;
  life: number;
  size: number;
  grow: number;
  rise: number;
  drift: number;
  dark: boolean;
  alpha: number;
}

/** Seconds between puffs while a source is active (belches come in bursts instead). */
const EVERY: Record<SmokeStyle, number> = { stack: 1.05, engine: 0.55, belch: 1.6 };

/**
 * Smoke as particles. Sources say each frame whether they are active; active sources release puffs, and every
 * puff lives out its own fade wherever it was released. When a source stops, nothing new appears and what is
 * already in the air dissipates naturally instead of vanishing.
 */
export class Smoke {
  private particles: Particle[] = [];
  private sources = new Map<string, { since: number; seen: boolean }>();

  /** Called every frame for each smoke source with whether it is putting out smoke right now. */
  source(key: string, at: Point, active: boolean, style: SmokeStyle): void {
    let src = this.sources.get(key);
    if (!src) {
      src = { since: EVERY[style], seen: true };
      this.sources.set(key, src);
    }
    src.seen = true;
    if (!active) {
      src.since = EVERY[style];
      return;
    }
    if (src.since < EVERY[style]) return;
    src.since = 0;
    const burst = style === 'belch' ? 3 : 1;
    for (let k = 0; k < burst; k++) {
      this.particles.push({
        x: at.x + (style === 'belch' ? (k - 1) * 5 : 0),
        y: at.y,
        age: 0,
        life: style === 'belch' ? 1.3 : style === 'engine' ? 2.2 : 3.2,
        size: style === 'belch' ? 8 + k * 3 : 7,
        grow: style === 'belch' ? 16 : style === 'engine' ? 14 : 12,
        rise: style === 'belch' ? 26 + k * 8 : 30,
        drift: style === 'belch' ? 14 : 10,
        dark: style === 'belch',
        alpha: style === 'belch' ? 0.65 : style === 'engine' ? 0.3 : 0.24,
      });
    }
  }

  update(dt: number): void {
    for (const src of this.sources.values()) src.since += dt;
    for (const p of this.particles) p.age += dt;
    this.particles = this.particles.filter((p) => p.age < p.life);
  }

  draw(ctx: CanvasRenderingContext2D, squircle: (x: number, y: number, size: number) => void): void {
    for (const p of this.particles) {
      const life = p.age / p.life;
      const size = p.size + life * p.grow;
      squircle(p.x + life * p.drift - size / 2, p.y - life * p.rise - size / 2, size);
      ctx.fillStyle = p.dark ? `rgba(28,26,24,${p.alpha * (1 - life)})` : `rgba(205,200,192,${p.alpha * (1 - life)})`;
      ctx.fill();
    }
  }

  get count(): number {
    return this.particles.length;
  }
}
