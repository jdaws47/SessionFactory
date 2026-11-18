import type { Crate } from '../shared/types';

/**
 * Why a crate can't be moved into a factory terminal yet, or null when it is safe.
 * Resuming while the original is still open would run the same conversation twice.
 */
export function handoffBlocker(crate: Crate, isAlive: (pid: number) => boolean, opts: { factoryTerminalGone?: boolean } = {}): string | null {
  if (!crate.sessionIds.length) return 'This crate has no Claude session to move yet.';
  if (crate.pid && isAlive(crate.pid)) {
    return `This session is still open in another terminal (Claude process ${crate.pid}). Type /exit there, then try again.`;
  }
  // With no process on record, it is only safe when the session ended, or ran in a factory terminal that has closed.
  if (!crate.pid && crate.zone !== 'storage' && !opts.factoryTerminalGone) {
    return "Can't confirm this session has closed in its other terminal. Type /exit there, then try again.";
  }
  return null;
}
