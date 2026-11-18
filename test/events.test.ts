import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/server/events';

const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'emit-event');

describe('normalize', () => {
  it('maps a Notification hook payload and drops the transcript path', () => {
    const event = normalize({
      sf: { at: 5, pid: 7, slot: 'sf-1' },
      payload: {
        session_id: 'abc',
        cwd: '/x',
        transcript_path: '/home/u/.claude/projects/p/abc.jsonl',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
      },
    });
    expect(event).toEqual({ at: 5, pid: 7, slot: 'sf-1', sessionId: 'abc', cwd: '/x', kind: 'notify', notificationType: 'permission_prompt', message: undefined });
    expect(JSON.stringify(event)).not.toContain('transcript');
  });

  it('describes background work a Stop is paused on', () => {
    const event = normalize({
      sf: {},
      payload: { session_id: 'a', cwd: '/x', hook_event_name: 'Stop', background_tasks: [{ type: 'shell', command: 'npm test' }, { type: 'subagent' }], session_crons: [] },
    });
    expect(event?.waitingOn).toBe('shell: npm test +1');
  });

  it('a permission request jams at once, and a failed tool counts as the tool being done', () => {
    const asked = normalize({ sf: {}, payload: { session_id: 'a', cwd: '/x', hook_event_name: 'PermissionRequest', tool_name: 'Bash' } });
    expect(asked).toMatchObject({ kind: 'notify', notificationType: 'permission_prompt' });
    const failed = normalize({ sf: {}, payload: { session_id: 'a', cwd: '/x', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' } });
    expect(failed).toMatchObject({ kind: 'postTool', tool: 'Bash' });
  });

  it('rejects payloads without a session id or cwd', () => {
    expect(normalize({ sf: {}, payload: { hook_event_name: 'Stop' } })).toBeNull();
    expect(normalize(null)).toBeNull();
  });
});

describe('emit-event hook', () => {
  it('writes one event file, prints nothing, and exits 0', () => {
    const root = path.join(import.meta.dirname, '.tmp', 'hook');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.copyFileSync(HOOK, path.join(root, 'hooks', 'emit-event'));
    fs.chmodSync(path.join(root, 'hooks', 'emit-event'), 0o755);

    const input = JSON.stringify({ session_id: 'abc', cwd: '/x', hook_event_name: 'Stop' });
    const out = execFileSync(path.join(root, 'hooks', 'emit-event'), { input, env: { ...process.env, SF_SLOT: 'sf-1;rm' } });

    expect(out.toString()).toBe('');
    const files = fs.readdirSync(path.join(root, 'data', 'events'));
    expect(files).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(root, 'data', 'events', files[0]), 'utf8'));
    expect(written.payload.session_id).toBe('abc');
    expect(written.sf.slot).toBe('sf-1rm');
    expect(normalize(written)?.kind).toBe('stop');
  });

  it('records nothing for headless claude -p runs, but still records interactive ones', () => {
    const root = path.join(import.meta.dirname, '.tmp', 'hook-headless');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.copyFileSync(HOOK, path.join(root, 'hooks', 'emit-event'));
    fs.chmodSync(path.join(root, 'hooks', 'emit-event'), 0o755);
    // A stand-in "claude" process: bash under that name (bash's own -p is harmless privileged mode).
    const claude = path.join(root, 'claude');
    fs.copyFileSync(execFileSync('bash', ['-c', 'command -v bash']).toString().trim(), claude);
    fs.chmodSync(claude, 0o755);
    const input = JSON.stringify({ session_id: 'abc', cwd: '/x', hook_event_name: 'SessionStart' });
    fs.writeFileSync(path.join(root, 'input.json'), input);
    const run = `"${path.join(root, 'hooks', 'emit-event')}" < "${path.join(root, 'input.json')}"; true`;
    const events = () => (fs.existsSync(path.join(root, 'data', 'events')) ? fs.readdirSync(path.join(root, 'data', 'events')) : []);

    expect(execFileSync(claude, ['-p', '-c', run]).toString()).toBe('');
    expect(events()).toHaveLength(0);

    execFileSync(claude, ['-c', run]);
    expect(events()).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(root, 'data', 'events', events()[0]), 'utf8'));
    expect(written.sf.pid).toBeGreaterThan(1);
  });

  it('still exits 0 when it cannot write', () => {
    const root = path.join(import.meta.dirname, '.tmp', 'hook-ro');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.copyFileSync(HOOK, path.join(root, 'hooks', 'emit-event'));
    fs.writeFileSync(path.join(root, 'data'), 'not a directory');
    expect(() => execFileSync('bash', [path.join(root, 'hooks', 'emit-event')], { input: '{}' })).not.toThrow();
  });
});
