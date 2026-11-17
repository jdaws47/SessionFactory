import type { Point } from './layout';

type Phase = 'idle' | 'settle' | 'travel' | 'lower' | 'grab' | 'lift' | 'carry' | 'drop' | 'release' | 'raise' | 'return';

export interface CraneCrates {
  /** Where the crate is now, or undefined if it no longer exists. */
  get(id: string): Point | undefined;
  move(id: string, to: Point): void;
  /** The crane has set the crate down at the requested point. */
  done(id: string): void;
  /** Whether nothing but `except` sits at this point. */
  free(at: Point, except: string): boolean;
}

/**
 * Overhead bridge crane. Deliberately clunky: it moves one axis at a time (bridge along the rails, then the
 * trolley across), pauses between moves, and lowers, grabs and raises its claw at every pick and drop.
 * It works through jobs one at a time and parks at home when idle.
 */
export class Crane {
  pos: Point;
  /** 0 = claw raised, 1 = fully lowered. */
  claw = 0;
  holding: string | null = null;
  private queue: { id: string; to: Point }[] = [];
  private job: { id: string; to: Point } | null = null;
  private phase: Phase = 'idle';
  private timer = 0;
  private axis: 'y' | 'x' = 'y';
  private target: Point;

  constructor(
    readonly home: Point,
    private readonly speed = 110,
    private readonly pause = 0.25,
    private readonly clawSeconds = 0.45,
  ) {
    this.pos = { ...home };
    this.target = { ...home };
  }

  /** How closed the spreader's clamps are: 0 open, 1 gripping. */
  get grip(): number {
    return this.holding ? 1 : this.claw;
  }

  /** How high the held crate is: 0 resting, 1 fully lifted. */
  get lift(): number {
    return this.holding ? 1 - this.claw : 0;
  }

  /** Where the crane has promised to set crates down (current job first, then queued ones). */
  get reserved(): { id: string; to: Point }[] {
    return [...(this.job ? [this.job] : []), ...this.queue];
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  request(id: string, to: Point): void {
    if (this.job?.id === id || this.queue.some((j) => j.id === id)) return;
    this.queue.push({ id, to: { x: to.x, y: to.y } });
  }

  /**
   * Withdraws a crate's request, as long as the crane has not picked it up yet. Returns false if it is
   * already holding (or setting down) that crate.
   */
  cancel(id: string): boolean {
    if (this.holding === id) return false;
    this.queue = this.queue.filter((j) => j.id !== id);
    if (this.job?.id === id) {
      if (this.phase !== 'settle' && this.phase !== 'travel' && this.phase !== 'lower') return false;
      this.job = null;
      this.claw = 0;
      this.timer = 0;
      this.goHome();
    }
    return true;
  }

  update(dt: number, crates: CraneCrates): void {
    if (this.timer > 0) {
      this.timer -= dt;
      return;
    }
    if (this.job && !crates.get(this.job.id) && !this.holding) {
      this.job = null;
      this.goHome();
    }
    switch (this.phase) {
      case 'idle':
        if (this.queue.length) this.startNext(crates);
        break;
      case 'settle': {
        const at = this.job && crates.get(this.job.id);
        if (!at) return this.goHome();
        this.headFor(at, 'travel');
        break;
      }
      case 'travel':
        if (this.step(dt)) this.phase = 'lower';
        break;
      case 'lower':
        if (this.moveClaw(dt, 1)) {
          this.phase = 'grab';
          this.timer = this.pause * 0.6;
        }
        break;
      case 'grab':
        this.holding = this.job!.id;
        this.phase = 'lift';
        break;
      case 'lift':
        if (this.moveClaw(dt, 0)) this.headFor(this.job!.to, 'carry');
        break;
      case 'carry':
        if (this.step(dt)) this.phase = 'drop';
        if (this.holding) crates.move(this.holding, this.pos);
        break;
      case 'drop':
        // Never set a crate down on top of another: hover until the spot is clear.
        if (this.claw === 0 && !crates.free(this.job!.to, this.job!.id)) {
          this.timer = this.pause;
          break;
        }
        if (this.moveClaw(dt, 1)) {
          crates.move(this.job!.id, this.job!.to);
          this.phase = 'release';
          this.timer = this.pause * 0.6;
        }
        break;
      case 'release':
        crates.done(this.job!.id);
        this.holding = null;
        this.job = null;
        this.phase = 'raise';
        break;
      case 'raise':
        if (this.moveClaw(dt, 0)) {
          if (this.queue.length) this.startNext(crates);
          else this.goHome();
        }
        break;
      case 'return':
        if (this.step(dt)) this.phase = 'idle';
        break;
    }
  }

  /** Takes the oldest job whose set-down spot is free, so a crate waiting on the spot is collected first. */
  private startNext(crates: CraneCrates): void {
    const ready = this.queue.findIndex((j) => crates.free(j.to, j.id));
    this.job = this.queue.splice(ready < 0 ? 0 : ready, 1)[0];
    this.phase = 'settle';
    this.timer = this.pause;
  }

  private goHome(): void {
    this.holding = null;
    this.headFor(this.home, 'return');
  }

  private headFor(target: Point, phase: Phase): void {
    this.target = { x: target.x, y: target.y };
    this.axis = 'y';
    this.phase = phase;
  }

  private moveClaw(dt: number, to: 0 | 1): boolean {
    const delta = dt / this.clawSeconds;
    this.claw = to ? Math.min(1, this.claw + delta) : Math.max(0, this.claw - delta);
    return this.claw === to;
  }

  /** Moves along one axis at a time, pausing when switching. Returns true on arrival. */
  private step(dt: number): boolean {
    const key = this.axis;
    const gap = this.target[key] - this.pos[key];
    const move = this.speed * dt;
    if (Math.abs(gap) > move) {
      this.pos = { ...this.pos, [key]: this.pos[key] + Math.sign(gap) * move };
      return false;
    }
    this.pos = { ...this.pos, [key]: this.target[key] };
    if (key === 'y') {
      this.axis = 'x';
      if (this.target.x !== this.pos.x) this.timer = this.pause;
      return false;
    }
    return true;
  }
}
