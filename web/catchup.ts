/** Longest stretch of missed time worth replaying: anything in flight has long settled after a few minutes. */
export const CATCH_UP_MAX = 180;
/** Time each frame may spend on catching up, so the page never stalls. */
export const CATCH_UP_BUDGET_MS = 6;
const STEP = 0.1;

/**
 * Browsers stop animation frames in hidden tabs. While hidden the floor keeps receiving state; on return the missed
 * time is replayed in the spare time of the next frames (in 0.1 s steps, the same as a slow frame).
 */
export class CatchUp {
  private hiddenAt: number | null = null;
  /** Seconds still to replay. */
  pending = 0;

  hidden(nowMs: number): void {
    this.hiddenAt ??= nowMs;
  }

  shown(nowMs: number): void {
    if (this.hiddenAt === null) return;
    this.pending = Math.min(CATCH_UP_MAX, this.pending + (nowMs - this.hiddenAt) / 1000);
    this.hiddenAt = null;
  }

  /** Replays missed time through `update` until it is done or `clock()` passes the frame's budget. */
  run(update: (dt: number) => void, clock: () => number = () => performance.now()): void {
    for (const until = clock() + CATCH_UP_BUDGET_MS; this.pending > 0 && clock() < until; ) {
      const dt = Math.min(STEP, this.pending);
      update(dt);
      this.pending -= dt;
    }
  }
}
