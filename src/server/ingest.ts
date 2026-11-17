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

  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.drain();
    try {
      this.watcher = fs.watch(this.dir, () => this.drain());
    } catch {
      // polling below still picks events up
    }
    this.timer = setInterval(() => this.drain(), 1500);
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
