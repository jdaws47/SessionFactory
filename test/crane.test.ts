import { describe, expect, it } from 'vitest';
import { Crane } from '../web/crane';
import type { Point } from '../web/layout';

function world(start: Point) {
  const crates = new Map<string, Point>([['c', { ...start }]]);
  const finished: string[] = [];
  return {
    crates,
    finished,
    api: {
      get: (id: string) => crates.get(id),
      move: (id: string, p: Point) => crates.set(id, { ...p }),
      done: (id: string) => finished.push(id),
      free: (at: Point, except: string) => ![...crates.entries()].some(([id, p]) => id !== except && Math.abs(p.x - at.x) < 50 && Math.abs(p.y - at.y) < 30),
    },
  };
}

const HOME = { x: 500, y: 0 };
const DT = 1 / 60;

function run(crane: Crane, api: ReturnType<typeof world>['api'], seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += DT) {
    crane.update(DT, api);
    each?.();
  }
}

describe('storage crane', () => {
  it('leaves the crate where it is until the crane has come over and grabbed it', () => {
    const w = world({ x: 100, y: 0 });
    const crane = new Crane(HOME);
    crane.request('c', { x: 100, y: 200 });
    run(crane, w.api, 3);
    expect(w.crates.get('c')).toEqual({ x: 100, y: 0 });
    expect(crane.holding).toBeNull();
  });

  it('moves one axis at a time, carries the crate, sets it down, and parks at home', () => {
    const w = world({ x: 100, y: 0 });
    const crane = new Crane(HOME);
    crane.request('c', { x: 300, y: 200 });
    let prev = { ...crane.pos };
    let diagonal = false;
    run(crane, w.api, 40, () => {
      if (crane.pos.x !== prev.x && crane.pos.y !== prev.y) diagonal = true;
      prev = { ...crane.pos };
    });
    expect(diagonal).toBe(false);
    expect(w.crates.get('c')).toEqual({ x: 300, y: 200 });
    expect(w.finished).toEqual(['c']);
    expect(crane.pos).toEqual(HOME);
    expect(crane.busy).toBe(false);
  });

  it('moves the bridge first when empty, and the trolley first when carrying', () => {
    const w = world({ x: 100, y: 300 });
    const crane = new Crane(HOME);
    crane.request('c', { x: 400, y: 100 });
    const moves: string[] = [];
    let prev = { ...crane.pos };
    let carrying = false;
    run(crane, w.api, 40, () => {
      const axis = crane.pos.x !== prev.x ? 'x' : crane.pos.y !== prev.y ? 'y' : '';
      if (axis) {
        const tag = `${crane.holding ? 'loaded' : 'empty'}:${axis}`;
        if (moves[moves.length - 1] !== tag) moves.push(tag);
      }
      if (crane.holding) carrying = true;
      prev = { ...crane.pos };
    });
    expect(carrying).toBe(true);
    expect(moves.slice(0, 2)).toEqual(['empty:y', 'empty:x']);
    expect(moves.slice(2, 4)).toEqual(['loaded:x', 'loaded:y']);
  });

  it('lifts the crate while carrying it and sets it down before letting go', () => {
    const w = world({ x: 100, y: 0 });
    const crane = new Crane(HOME);
    crane.request('c', { x: 300, y: 200 });
    let maxLift = 0;
    let liftAtRelease = -1;
    run(crane, w.api, 40, () => {
      maxLift = Math.max(maxLift, crane.lift);
      if (w.finished.length && liftAtRelease < 0) liftAtRelease = crane.lift;
    });
    expect(maxLift).toBe(1);
    expect(liftAtRelease).toBe(0);
  });

  it('feels heavy: a short hop still takes a few seconds', () => {
    const w = world({ x: 480, y: 0 });
    const crane = new Crane(HOME);
    crane.request('c', { x: 480, y: 80 });
    let elapsed = 0;
    while (!w.finished.length && elapsed < 60) {
      crane.update(DT, w.api);
      elapsed += DT;
    }
    expect(elapsed).toBeGreaterThan(2);
  });

  it('collects a crate waiting on a spot before setting another crate down there', () => {
    const w = world({ x: 300, y: 200 });
    w.crates.set('waiting', { x: 100, y: 0 });
    const crane = new Crane(HOME);
    crane.request('c', { x: 100, y: 0 });
    crane.request('waiting', { x: 400, y: 200 });
    run(crane, w.api, 90);
    expect(w.finished).toEqual(['waiting', 'c']);
    expect(w.crates.get('c')).toEqual({ x: 100, y: 0 });
  });

  it('works through queued jobs one at a time', () => {
    const w = world({ x: 100, y: 0 });
    w.crates.set('d', { x: 200, y: 0 });
    const crane = new Crane(HOME);
    crane.request('c', { x: 100, y: 100 });
    crane.request('d', { x: 200, y: 100 });
    crane.request('c', { x: 100, y: 100 });
    run(crane, w.api, 90);
    expect(w.finished).toEqual(['c', 'd']);
  });
});
