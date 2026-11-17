import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Crate, CrateView, JiraInfo } from '../shared/types';
import type { FactoryEvent } from './events';
import type { PastSession } from './history';
import { DEFAULT_JIRA_PROJECTS, isWithin, refreshLabel, repoOf } from './labels';
import { applyEvent, isSyntheticPrompt, newCrate } from './machine';

export const READY_TO_SHIP_AFTER_MS = 3 * 24 * 3600 * 1000;
/** A /clear ends one session id and starts the next in the same process within moments. */
const PID_RELINK_WINDOW_MS = 60_000;

/**
 * Persistent set of every crate the factory has seen. Crates are only ever hidden by archive();
 * nothing here deletes one.
 */
export class Registry {
  private crates = new Map<string, Crate>();
  private saveTimer?: NodeJS.Timeout;
  private listeners: Array<() => void> = [];
  /** Timestamps of finished turns over the last week, for the throughput counter. */
  private turnLog: number[] = [];

  constructor(
    private readonly file: string,
    private readonly cleanRoot: string,
    private readonly jiraProjects: string[] = DEFAULT_JIRA_PROJECTS,
  ) {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { crates: Crate[]; turnLog?: number[] };
      for (const c of saved.crates) {
        if (isSyntheticPrompt(c.firstPrompt)) c.firstPrompt = undefined;
        // Links are by session name only; re-derive so older prompt-based links drop away.
        refreshLabel(c, this.jiraProjects);
        this.crates.set(c.id, c);
      }
      this.turnLog = saved.turnLog ?? [];
    }
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  all(): Crate[] {
    return [...this.crates.values()];
  }

  get(id: string): Crate | undefined {
    return this.crates.get(id);
  }

  findBySlot(slot: string): Crate | undefined {
    return this.all().find((c) => c.slot === slot);
  }

  /** Applies a hook event. Returns false for sessions outside clean-room, which are never tracked. */
  ingest(ev: FactoryEvent): boolean {
    if (!isWithin(ev.cwd, this.cleanRoot)) return false;
    const crate = this.link(ev) ?? { ...newCrate(ev, this.cleanRoot, randomUUID()), slot: ev.slot };
    if (ev.kind === 'stop' && !ev.waitingOn) {
      this.turnLog.push(ev.at);
      this.turnLog = this.turnLog.filter((t) => ev.at - t < 7 * 24 * 3600 * 1000);
    }
    this.put(applyEvent(crate, ev, this.jiraProjects));
    return true;
  }

  /** Creates the crate for a factory terminal before its Claude session reports in, named as the session will be. */
  preregister(slot: string, opts: { name?: string; cwd?: string }, now: number): Crate {
    const cwd = opts.cwd ?? this.cleanRoot;
    const crate: Crate = {
      ...newCrate({ at: now, sessionId: '', cwd, kind: 'start' }, this.cleanRoot, randomUUID()),
      slot,
      title: opts.name || undefined,
    };
    refreshLabel(crate, this.jiraProjects);
    this.put(crate);
    return crate;
  }

  /**
   * Adds past sessions the factory never saw as archived crates, so they show in the Warehouse and can be
   * resumed. Sessions already known, outside clean-room, or active since `quietSince` are skipped (hooks
   * will report those). Returns how many were added.
   */
  importPast(sessions: PastSession[], quietSince: number): number {
    const removed = this.forgetHeadless(new Set(sessions.filter((p) => p.headless).map((p) => p.sessionId)));
    const known = new Set(this.all().flatMap((c) => c.sessionIds));
    let added = 0;
    for (const p of sessions) {
      if (p.headless || known.has(p.sessionId) || !isWithin(p.cwd, this.cleanRoot) || p.endedAt > quietSince) continue;
      const crate: Crate = {
        ...newCrate({ at: p.startedAt, sessionId: p.sessionId, cwd: p.cwd, kind: 'start' }, this.cleanRoot, randomUUID()),
        sessionIds: [p.sessionId],
        title: p.title,
        jiraKey: p.jiraKey,
        zone: 'storage',
        zoneSince: p.endedAt,
        updatedAt: p.endedAt,
        endedAt: p.endedAt,
        archived: true,
        archivedAt: p.endedAt,
        archiveCount: 1,
      };
      refreshLabel(crate, this.jiraProjects);
      if (crate.labelSource === 'auto' && !crate.title) crate.label = `${crate.repo} · ${new Date(p.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
      this.crates.set(crate.id, crate);
      known.add(p.sessionId);
      added++;
    }
    if (added || removed) {
      this.scheduleSave();
      for (const l of this.listeners) l();
    }
    return added;
  }

  /**
   * Drops crates that only ever held headless runs (claude -p). They were never sessions you worked in, so this is
   * the one removal that isn't an Archive. Crates that also held a real session are kept.
   */
  private forgetHeadless(headless: Set<string>): number {
    let removed = 0;
    for (const [id, c] of this.crates) {
      if (c.sessionIds.length && c.sessionIds.every((s) => headless.has(s))) {
        this.crates.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Points an existing crate at a new factory terminal (resume / bring back). */
  attachSlot(id: string, slot: string): void {
    this.update(id, (c) => ({ ...c, slot }));
  }

  archive(id: string, now: number): void {
    this.update(id, (c) =>
      c.archived
        ? c
        : {
            ...c,
            archived: true,
            archivedAt: now,
            archiveCount: c.archiveCount + 1,
            returned: undefined,
            jira: c.jira ? { ...c.jira, statusAtArchive: c.jira.status } : c.jira,
          },
    );
  }

  unarchive(id: string, _now: number): void {
    this.update(id, (c) =>
      c.archived ? { ...c, archived: false, reactivationCount: c.reactivationCount + 1, returned: undefined } : c,
    );
  }

  archiveLabel(label: string, now: number): number {
    const matching = this.all().filter((c) => !c.archived && c.label === label);
    for (const c of matching) this.archive(c.id, now);
    return matching.length;
  }

  /** Removes the crate's Jira link and stops it being detected again. */
  unlinkJira(id: string): void {
    this.update(id, (c) => {
      const next: Crate = { ...c, jiraKey: undefined, jira: undefined, jiraUnlinked: true, labelSource: c.labelSource === 'jira' ? 'auto' : c.labelSource };
      refreshLabel(next, this.jiraProjects);
      return next;
    });
  }

  /** The session was renamed: the crate takes the new session name. */
  setTitle(id: string, title: string): void {
    this.update(id, (c) => {
      const next: Crate = { ...c, title, labelSource: 'auto' };
      refreshLabel(next, this.jiraProjects);
      return next;
    });
  }

  dismissReturned(id: string): void {
    this.update(id, (c) => ({ ...c, returned: undefined }));
  }

  markReturned(id: string, reason: string, now: number): void {
    this.update(id, (c) => (c.archived && !c.returned ? { ...c, returned: { reason, at: now } } : c));
  }

  /**
   * Records the latest Jira status. For archived crates the status at archive time is the baseline;
   * any later change (reopened, moved on) marks the crate as returned. It is never unarchived here.
   */
  setJira(id: string, info: Pick<JiraInfo, 'status' | 'resolved'>, now: number): void {
    this.update(id, (c) => {
      const next: Crate = { ...c, jira: { ...c.jira, ...info, checkedAt: now } };
      if (c.archived && info.status) {
        const baseline = c.jira?.statusAtArchive;
        if (!baseline) next.jira = { ...next.jira, statusAtArchive: info.status };
        else if (baseline !== info.status && !c.returned) next.returned = { reason: `ticket moved to ${info.status}`, at: now };
      }
      return next;
    });
  }

  /**
   * A session is being resumed in a factory terminal: it will land waiting for your prompt, so the crate heads
   * for the dock now. The old process is gone; forget it so the liveness check doesn't send the crate back.
   */
  markResuming(id: string, now: number): void {
    this.update(id, (c) => ({ ...c, zone: 'dock', zoneSince: now, endedAt: undefined, pid: undefined, alertReason: undefined, waitingOn: undefined }));
  }

  /** Records that a session was ended on purpose (its terminal closed from the factory). */
  markEnded(id: string, now: number): void {
    this.update(id, (c) => (c.zone === 'storage' ? c : { ...c, zone: 'storage', zoneSince: now, endedAt: now, alertReason: undefined, waitingOn: undefined }));
  }

  /** Moves crates whose Claude process has gone away (crash, closed terminal) into storage. */
  checkLiveness(isAlive: (pid: number) => boolean, now: number): void {
    for (const c of this.all()) {
      if (c.pid && c.zone !== 'storage' && !isAlive(c.pid)) {
        this.put({ ...c, zone: 'storage', zoneSince: now, endedAt: now, alertReason: undefined });
      }
    }
  }

  view(now: number, liveSlots: Set<string> = new Set()): CrateView[] {
    return this.all().map((c) => {
      let readyToShip: string | undefined;
      if (!c.archived) {
        if (c.jiraKey && c.jira?.resolved) readyToShip = `ticket ${c.jira.status ?? 'resolved'}`;
        else if (c.zone === 'storage' && c.endedAt && now - c.endedAt > READY_TO_SHIP_AFTER_MS) readyToShip = 'in storage 3+ days';
      }
      return { ...c, readyToShip, hasTerminal: !!c.slot && liveSlots.has(c.slot) };
    });
  }

  /** Finished turns since local midnight. */
  turnsSince(start: number): number {
    return this.turnLog.filter((t) => t >= start).length;
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.writeNow();
  }

  private link(ev: FactoryEvent): Crate | undefined {
    const crates = this.all();
    return (
      crates.find((c) => c.sessionIds.includes(ev.sessionId)) ??
      (ev.slot ? crates.find((c) => c.slot === ev.slot) : undefined) ??
      (ev.pid
        ? crates.find((c) => c.pid === ev.pid && (!c.endedAt || ev.at - c.endedAt < PID_RELINK_WINDOW_MS))
        : undefined)
    );
  }

  private update(id: string, fn: (c: Crate) => Crate): void {
    const c = this.crates.get(id);
    if (c) this.put(fn(c));
  }

  private put(crate: Crate): void {
    if (!crate.repo) crate.repo = repoOf(crate.cwd, this.cleanRoot);
    this.crates.set(crate.id, crate);
    this.scheduleSave();
    for (const l of this.listeners) l();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.writeNow();
    }, 250);
  }

  private writeNow(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, crates: this.all(), turnLog: this.turnLog }, null, 1));
    fs.renameSync(tmp, this.file);
  }
}
