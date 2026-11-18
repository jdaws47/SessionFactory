import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventIngestor } from '../src/server/ingest';
import { Registry } from '../src/server/registry';
import { CLEAN_ROOT } from './helpers';

const TMP = path.join(import.meta.dirname, '.tmp', 'ingest');
const EVENTS = path.join(TMP, 'events');
const event = (n: number, sessionId: string) =>
  fs.writeFileSync(path.join(EVENTS, `${1_700_000_000_000 + n}-${n}.json`), JSON.stringify({ sf: { at: n }, payload: { session_id: sessionId, cwd: CLEAN_ROOT, hook_event_name: 'SessionStart' } }));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe('event ingestion', () => {
  it('keeps going when the events folder is deleted and comes back', async () => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(EVENTS, { recursive: true });
    const reg = new Registry(path.join(TMP, 'registry.json'), CLEAN_ROOT);
    const ingestor = new EventIngestor(EVENTS, reg);
    ingestor.start();
    event(1, 'before');
    await until(() => reg.all().length === 1);

    fs.rmSync(EVENTS, { recursive: true });
    await new Promise((r) => setTimeout(r, 100));
    // The hook re-creates the folder on its next event.
    fs.mkdirSync(EVENTS, { recursive: true });
    event(2, 'after');
    await until(() => reg.all().length === 2);
    ingestor.stop();
    reg.close();
    expect(reg.all().flatMap((c) => c.sessionIds).sort()).toEqual(['after', 'before']);
  });
});
