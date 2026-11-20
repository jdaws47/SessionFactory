import { describe, expect, it } from 'vitest';
import { assignPlacements } from '../src/server/placement';
import { CAPACITY, type Crate, type Placement } from '../src/shared/types';

let clock = 1000;
function crate(id: string, over: Partial<Crate> = {}): Crate {
  return { id, sessionIds: [id], cwd: '/cr', repo: 'cr', label: id, labelSource: 'auto', zone: 'dock', zoneSince: 0, turns: 2, startedAt: 0, updatedAt: 0, archived: false, archiveCount: 0, reactivationCount: 0, ...over };
}
/** Runs placement like the server does: each round sees the previous round's placements. */
function place(crates: Crate[]): Map<string, Placement> {
  const out = assignPlacements(crates, (clock += 1000));
  for (const c of crates) c.placement = out.get(c.id);
  return out;
}
const at = (p: Map<string, Placement>, id: string) => {
  const x = p.get(id)!;
  return `${x.area}/${x.slot}${x.pileSize > 1 ? `#${x.rank}` : ''}`;
};

describe('server placement', () => {
  it('maps states to areas: waiting on you stays in its assembler, a used session back at intake waits at the dock, archived goes to the warehouse', () => {
    const p = place([
      crate('a', { zone: 'alert' }),
      crate('i', { zone: 'intake', turns: 0 }),
      crate('c', { zone: 'intake', turns: 3 }),
      crate('w', { zone: 'storage', archived: true }),
    ]);
    expect([at(p, 'a'), at(p, 'i'), at(p, 'c'), at(p, 'w')]).toEqual(['working/0', 'intake/0', 'dock/0', 'warehouse/0']);
  });

  it('orders the dock longest-waiting first, and keeps that order whatever order crates arrive in', () => {
    const crates = [crate('new', { zoneSince: 300 }), crate('old', { zoneSince: 100 }), crate('mid', { zoneSince: 200 })];
    const p = place(crates);
    expect(['old', 'mid', 'new'].map((id) => at(p, id))).toEqual(['dock/0', 'dock/1', 'dock/2']);
    // The front crate leaves: everyone moves up.
    crates.find((c) => c.id === 'old')!.zone = 'working';
    const q = place(crates);
    expect(['mid', 'new'].map((id) => at(q, id))).toEqual(['dock/0', 'dock/1']);
  });

  it('piles extra dock crates on the last spot, newest on top', () => {
    const crates = Array.from({ length: CAPACITY.dock + 2 }, (_, i) => crate(`d${i}`, { zoneSince: i }));
    const p = place(crates);
    const last = CAPACITY.dock - 1;
    expect([at(p, `d${last}`), at(p, `d${last + 1}`), at(p, `d${last + 2}`)]).toEqual([`dock/${last}#2`, `dock/${last}#1`, `dock/${last}#0`]);
  });

  it('assemblers and storage are sticky: a crate keeps its spot when others come and go', () => {
    const crates = [crate('a', { zone: 'working', zoneSince: 1 }), crate('b', { zone: 'working', zoneSince: 2 }), crate('c', { zone: 'working', zoneSince: 3 })];
    place(crates);
    crates[0].zone = 'dock';
    const p = place(crates);
    expect([at(p, 'b'), at(p, 'c')]).toEqual(['working/1', 'working/2']);
    // A newcomer takes the free spot rather than shuffling anyone.
    crates.push(crate('d', { zone: 'working', zoneSince: 9 }));
    expect(at(place(crates), 'd')).toBe('working/0');
  });

  it('a full area piles on its last spot, last in on top; a freed spot is taken by the top of the pile first', () => {
    const crates = Array.from({ length: CAPACITY.storage }, (_, i) => crate(`s${i}`, { zone: 'storage', zoneSince: i }));
    place(crates);
    crates.push(crate('x', { zone: 'storage', zoneSince: 50 }));
    place(crates);
    crates.push(crate('y', { zone: 'storage', zoneSince: 60 }));
    const p = place(crates);
    const last = CAPACITY.storage - 1;
    expect([at(p, `s${last}`), at(p, 'x'), at(p, 'y')]).toEqual([`storage/${last}#2`, `storage/${last}#1`, `storage/${last}#0`]);
    crates[0].zone = 'dock';
    const q = place(crates);
    expect([at(q, 'y'), at(q, 'x'), at(q, `s${last}`)]).toEqual(['storage/0', `storage/${last}#0`, `storage/${last}#1`]);
  });

  it('warehouse spots are sticky and fill from the first free one', () => {
    const crates = [crate('a', { archived: true, archivedAt: 1 }), crate('b', { archived: true, archivedAt: 2 })];
    place(crates);
    crates[0].archived = false;
    crates.push(crate('c', { archived: true, archivedAt: 3 }));
    const p = place(crates);
    expect([at(p, 'b'), at(p, 'c')]).toEqual(['warehouse/1', 'warehouse/0']);
  });

  it('keeps the time a crate was put on its spot until it moves', () => {
    const crates = [crate('a', { zone: 'working' })];
    const first = place(crates).get('a')!.since;
    expect(place(crates).get('a')!.since).toBe(first);
    crates[0].zone = 'storage';
    expect(place(crates).get('a')!.since).toBeGreaterThan(first);
  });
});
