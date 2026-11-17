import fs from 'node:fs';
import path from 'node:path';
import { normalize } from './events';
import type { Registry } from './registry';

/** Drains event files written by hooks/emit-event into the registry, oldest first. */
export class EventIngestor {
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly dir: string,
    private readonly registry: Registry,
  ) {}

  /**
   * Drains on every change the folder watcher reports; anything it missed is picked up by the next event or a page
   * load (main.ts). Only if no watcher can run at all does polling take over, as the only way events get in.
   */
  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.drain();
    if (!this.watch()) this.timer = setInterval(() => this.drain(), 1500);
  }

  private watch(): boolean {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.watcher = fs.watch(this.dir, () => this.drain());
      this.watcher.on('error', () => {
        // e.g. the folder was deleted: start over (the sweep re-creates the watcher) and pick up what's waiting.
        this.watcher?.close();
        this.watcher = undefined;
        if (this.watch()) this.drain();
      });
      return true;
    } catch {
      this.watcher = undefined;
      return false;
    }
  }

  stop(): void {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
  }

  drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((f) => /^\d+-.*\.json$/.test(f))
        .sort();
      for (const f of files) this.consume(path.join(this.dir, f));
    } finally {
      this.draining = false;
    }
  }

  private consume(file: string): void {
    try {
      const event = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (event) this.registry.ingest(event);
      fs.unlinkSync(file);
    } catch {
      const bad = path.join(this.dir, 'bad');
      fs.mkdirSync(bad, { recursive: true });
      try {
        fs.renameSync(file, path.join(bad, path.basename(file)));
      } catch {
        // already gone
      }
    }
  }
}
