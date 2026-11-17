import { describe, expect, it } from 'vitest';
import { claudeCommand, shellQuote } from '../src/server/terminals';

describe('factory terminal command line', () => {
  it('always runs scrub-in first, starts claude from clean-room, and closes the terminal when claude exits', () => {
    expect(claudeCommand('/home/u/clean-room')).toBe("scrub-in; cd '/home/u/clean-room' && claude; exit");
  });

  it('quotes prompts so they cannot break out of the command', () => {
    const cmd = claudeCommand('/cr', { prompt: "it's done; rm -rf /\n$(whoami)" });
    expect(cmd).toBe(`scrub-in; cd '/cr' && claude 'it'\\''s done; rm -rf / $(whoami)'; exit`);
  });

  it('resumes by session id', () => {
    expect(claudeCommand('/cr', { resume: 'abc-123' })).toBe("scrub-in; cd '/cr' && claude --resume 'abc-123'; exit");
  });

  it('shellQuote round-trips through bash', async () => {
    const { execFileSync } = await import('node:child_process');
    const nasty = `a'b"c $HOME \`x\``;
    expect(execFileSync('bash', ['-c', `printf %s ${shellQuote(nasty)}`]).toString()).toBe(nasty);
  });
});
