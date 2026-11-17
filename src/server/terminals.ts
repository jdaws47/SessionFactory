import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import pty, { type IPty } from 'node-pty';

const run = promisify(execFile);

export const SLOT_RE = /^sf-[a-z0-9]{4,16}$/;

export function newSlot(): string {
  return `sf-${randomBytes(3).toString('hex')}`;
}

export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line typed into a new factory terminal: always scrub-in first, then claude from clean-room. The shell
 * exits when claude does, so an ended session never leaves a terminal (or the tmux server) behind.
 */
export function claudeCommand(cleanRoot: string, opts: { resume?: string; prompt?: string; name?: string } = {}): string {
  let cmd = `scrub-in; cd ${shellQuote(cleanRoot)} && claude`;
  if (opts.resume) cmd += ` --resume ${shellQuote(opts.resume)}`;
  if (opts.name) cmd += ` --name ${shellQuote(opts.name)}`;
  if (opts.prompt) cmd += ` ${shellQuote(opts.prompt.replace(/\s+/g, ' ').trim())}`;
  return `${cmd}; exit`;
}

/**
 * Factory terminals are sessions on a private tmux server whose socket lives in session-factory/run/.
 * The browser attaches through a pty running `tmux attach`; closing the popup only detaches.
 */
export class Terminals {
  private live = new Set<string>();

  constructor(
    private readonly socket: string,
    private readonly config: string,
    private readonly cleanRoot: string,
  ) {
    fs.mkdirSync(this.socketDir(), { recursive: true });
  }

  private socketDir(): string {
    return this.socket.slice(0, this.socket.lastIndexOf('/'));
  }

  private tmux(args: string[]): Promise<{ stdout: string }> {
    return run('tmux', ['-S', this.socket, '-f', this.config, ...args]);
  }

  static async available(): Promise<boolean> {
    try {
      await run('tmux', ['-V']);
      return true;
    } catch {
      return false;
    }
  }

  get liveSlots(): Set<string> {
    return this.live;
  }

  /** Refreshes the set of running factory terminals; returns true when it changed. */
  async refresh(): Promise<boolean> {
    let next = new Set<string>();
    try {
      const { stdout } = await this.tmux(['list-sessions', '-F', '#{session_name}']);
      next = new Set(stdout.split('\n').filter((s) => SLOT_RE.test(s)));
    } catch {
      // no tmux server running yet
    }
    const changed = next.size !== this.live.size || [...next].some((s) => !this.live.has(s));
    this.live = next;
    return changed;
  }

  async start(slot: string, command: string): Promise<void> {
    await this.tmux(['new-session', '-d', '-s', slot, '-x', '200', '-y', '50', '-c', this.cleanRoot, '-e', `SF_SLOT=${slot}`, '-e', 'CLAUDE_CODE_AUTO_CONNECT_IDE=false']);
    await this.tmux(['send-keys', '-t', slot, '-l', command]);
    await this.tmux(['send-keys', '-t', slot, 'Enter']);
    await this.refresh();
  }

  /**
   * Ends a factory terminal. When Claude is idle at its prompt it is asked to /exit first so the session
   * ends cleanly; then the tmux session (and the shell left behind) is closed.
   */
  async end(slot: string, claudeIdle: boolean): Promise<void> {
    if (claudeIdle) {
      await this.tmux(['send-keys', '-t', slot, '-l', '/exit']).catch(() => undefined);
      await this.tmux(['send-keys', '-t', slot, 'Enter']).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 2500));
    }
    await this.kill(slot);
  }

  /** Types a line into a factory terminal, as if you had (used for /rename). */
  async sendLine(slot: string, line: string): Promise<void> {
    await this.tmux(['send-keys', '-t', slot, '-l', line.replace(/[\r\n]+/g, ' ')]);
    await this.tmux(['send-keys', '-t', slot, 'Enter']);
  }

  async kill(slot: string): Promise<void> {
    await this.tmux(['kill-session', '-t', slot]).catch(() => undefined);
    await this.refresh();
  }

  attach(slot: string, cols: number, rows: number): IPty {
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>;
    delete env.TMUX;
    return pty.spawn('tmux', ['-S', this.socket, '-f', this.config, 'attach-session', '-t', slot], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: this.cleanRoot,
      env,
    });
  }
}
