import type { FactoryEvent } from '../src/server/events';

export const CLEAN_ROOT = '/work/clean-room';

let clock = 1_000_000;

/** Builds a normalized event with sensible defaults and a monotonically increasing timestamp. */
export function ev(partial: Partial<FactoryEvent> & Pick<FactoryEvent, 'kind'>): FactoryEvent {
  clock += 1000;
  return {
    at: clock,
    sessionId: 's1',
    cwd: `${CLEAN_ROOT}/cerebrum`,
    ...partial,
  } as FactoryEvent;
}
