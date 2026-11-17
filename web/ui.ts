import type { CrateView, FactoryState } from '../src/shared/types';
import { post } from './api';
import { repoColor } from './scene';
import { AttachedTerminal } from './terminal';

export interface Action {
  label: string;
  kind?: 'primary' | 'danger' | 'plain';
  run: () => void | Promise<void>;
}

/** Hooks later features use to add UI without the core knowing about them. */
export interface UiExtensions {
  warehouseActions: Array<(c: CrateView, state: FactoryState) => Action | null>;
  newSessionExtras: Array<(state: FactoryState) => string>;
}

export function esc(text: unknown): string {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function ago(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function lastSessionId(c: CrateView): string | undefined {
  return c.sessionIds[c.sessionIds.length - 1];
}

export function resumeCommand(c: CrateView, cleanRoot: string): string {
  return `scrub-in; cd '${cleanRoot}' && claude --resume ${lastSessionId(c)}`;
}

const ZONE_NAMES: Record<string, string> = {
  intake: 'Intake',
  working: 'Working',
  alert: 'Needs you',
  dock: 'Waiting for prompt',
  storage: 'Ended',
};

export class Ui {
  readonly ext: UiExtensions = { warehouseActions: [], newSessionExtras: [] };
  private state: FactoryState | null = null;
  private connected = false;
  private selected: string | null = null;
  private warehouseOpen = false;
  private warehouseQuery = '';
  private archiveMenu = false;
  private fullScreen = false;
  private terminal: AttachedTerminal | null = null;
  private actionMap = new Map<string, () => void | Promise<void>>();
  private actionSeq = 0;

  private top = document.getElementById('topbar')!;
  private win = document.getElementById('crate-window')!;
  private winHead = document.getElementById('cw-head')!;
  private winTerm = document.getElementById('cw-term')!;
  private winInfo = document.getElementById('cw-info')!;
  private tooltip = document.getElementById('tooltip')!;
  private inbox = document.getElementById('inbox')!;
  private warehouse = document.getElementById('warehouse')!;
  private modal = document.getElementById('modal')!;
  private toastEl = document.getElementById('toast')!;

  constructor() {
    document.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el) return;
      const fn = this.actionMap.get(el.dataset.act!);
      if (fn) Promise.resolve(fn()).catch((err) => this.toast(`Failed: ${(err as Error).message}`));
    });
    this.win.addEventListener('mousedown', (e) => {
      if (e.target === this.win) this.select(null);
    });
    this.warehouse.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.id === 'wh-search') {
        this.warehouseQuery = input.value;
        this.renderWarehouse(true);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest('.xterm')) return;
      if (!this.modal.hidden) this.modal.hidden = true;
      else if (this.warehouseOpen) this.closeWarehouse();
      else this.select(null);
    });
  }

  get selectedId(): string | null {
    return this.selected;
  }

  setState(state: FactoryState): void {
    this.state = state;
    if (this.selected && !state.crates.find((c) => c.id === this.selected && !c.archived)) this.select(null);
    this.render();
  }

  setConnected(up: boolean): void {
    this.connected = up;
    this.renderTop();
  }

  select(id: string | null): void {
    if (id !== this.selected) {
      this.terminal?.dispose();
      this.terminal = null;
      this.archiveMenu = false;
    }
    this.selected = id;
    this.renderWindow();
  }

  openWarehouse(): void {
    this.warehouseOpen = true;
    this.renderWarehouse();
    this.warehouse.querySelector<HTMLInputElement>('#wh-search')?.focus();
  }

  closeWarehouse(): void {
    this.warehouseOpen = false;
    this.renderWarehouse();
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout((this.toastEl as any)._t);
    (this.toastEl as any)._t = setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  async copy(text: string, what: string): Promise<void> {
    await navigator.clipboard.writeText(text);
    this.toast(`${what} copied`);
  }

  showTooltip(c: CrateView | null, x: number, y: number): void {
    if (!c || !this.state) {
      this.tooltip.hidden = true;
      return;
    }
    const since = ago(this.state.now - c.zoneSince).replace(' ago', '');
    this.tooltip.innerHTML = `
      <div class="tt-title">${esc(c.label)}</div>
      <div class="tt-row"><span class="dot" style="background:${repoColor(c.repo)}"></span>${esc(c.repo)}${c.jiraKey ? ` · ${esc(c.jiraKey)}` : ''}</div>
      <div class="tt-row">${esc(ZONE_NAMES[c.zone])}${c.alertReason ? ` (${esc(c.alertReason)})` : ''} · ${esc(since)}</div>
      ${c.waitingOn ? `<div class="tt-row dim">waiting on ${esc(c.waitingOn)}</div>` : c.lastTool ? `<div class="tt-row dim">last tool: ${esc(c.lastTool)}</div>` : ''}
      ${c.readyToShip ? `<div class="tt-row ship">ready to ship: ${esc(c.readyToShip)}</div>` : ''}
      <div class="tt-row dim">${c.hasTerminal ? 'click to open terminal' : 'click for details'}</div>`;
    this.tooltip.hidden = false;
    const r = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(x + 16, innerWidth - r.width - 8)}px`;
    this.tooltip.style.top = `${Math.min(y + 16, innerHeight - r.height - 8)}px`;
  }

  /** Registers a click handler for this render pass and returns the attribute that triggers it. */
  act(fn: () => void | Promise<void>): string {
    const key = `a${++this.actionSeq}`;
    this.actionMap.set(key, fn);
    return `data-act="${key}"`;
  }

  button(a: Action): string {
    return `<button class="btn ${a.kind ?? 'plain'}" ${this.act(a.run)}>${esc(a.label)}</button>`;
  }

  private render(): void {
    this.actionMap.clear();
    this.renderTop();
    this.renderWindow();
    this.renderInbox();
    if (this.warehouseOpen) this.renderWarehouse(true);
  }

  private renderTop(): void {
    const s = this.state;
    const live = s?.crates.filter((c) => !c.archived) ?? [];
    const count = (z: string) => live.filter((c) => c.zone === z).length;
    this.top.innerHTML = `
      <div class="brand"><span class="logo"></span>SESSION FACTORY</div>
      <div class="stats">
        <span class="stat"><b>${count('working')}</b> working</span>
        <span class="stat alert"><b>${count('alert')}</b> need you</span>
        <span class="stat"><b>${count('dock')}</b> waiting</span>
        <span class="stat"><b>${count('intake')}</b> intake</span>
        <span class="stat dim"><b>${count('storage')}</b> ended</span>
        <span class="stat dim"><b>${(s?.crates.length ?? 0) - live.length}</b> archived</span>
      </div>
      <div class="actions">
        ${s?.features.terminals ? this.button({ label: '+ New session', kind: 'primary', run: () => this.openNewSession() }) : ''}
        ${this.button({ label: 'Warehouse', run: () => this.openWarehouse() })}
        <span class="conn ${this.connected ? 'up' : 'down'}" title="${this.connected ? 'connected' : 'reconnecting…'}"></span>
      </div>`;
  }

  private renderWindow(): void {
    const s = this.state;
    const c = s?.crates.find((x) => x.id === this.selected);
    if (!s || !c) {
      this.terminal?.dispose();
      this.terminal = null;
      this.win.hidden = true;
      return;
    }
    this.win.hidden = false;
    this.win.classList.toggle('full', this.fullScreen);
    this.winHead.innerHTML = this.windowHead(c, s);

    if (c.hasTerminal && c.slot) {
      this.winTerm.hidden = false;
      this.winInfo.hidden = true;
      if (this.terminal?.slot !== c.slot) {
        this.terminal?.dispose();
        this.terminal = new AttachedTerminal(c.slot, this.winTerm);
      }
    } else {
      this.terminal?.dispose();
      this.terminal = null;
      this.winTerm.hidden = true;
      this.winInfo.hidden = false;
      this.winInfo.innerHTML = this.windowInfo(c, s);
    }
  }

  private windowHead(c: CrateView, s: FactoryState): string {
    const sameLabel = s.crates.filter((x) => !x.archived && x.label === c.label).length;
    const rename = this.act(async () => {
      const next = window.prompt('Crate name (leave empty to follow the session name again)', c.labelSource === 'manual' ? c.label : '');
      if (next === null) return;
      await post(`/api/crates/${c.id}/label`, { label: next });
    });
    const archive = async (endSession: boolean) => {
      if (endSession && !window.confirm(`End the Claude session in "${c.label}" and archive it?`)) return;
      await post(`/api/crates/${c.id}/archive`, { endSession });
      this.toast(`Shipped ${c.label} to the warehouse`);
    };
    const closeMenu = () => {
      this.archiveMenu = false;
      this.renderWindow();
    };

    const actions: Action[] = this.archiveMenu
      ? [
          ...(c.hasTerminal
            ? [
                { label: 'End session & archive', kind: 'danger' as const, run: () => archive(true) },
                { label: 'Archive, keep running', kind: 'danger' as const, run: () => archive(false) },
              ]
            : [{ label: 'Archive', kind: 'danger' as const, run: () => archive(false) }]),
          ...(sameLabel > 1
            ? [
                {
                  label: `Archive all "${c.label}" (${sameLabel})`,
                  kind: 'danger' as const,
                  run: async () => {
                    await post('/api/labels/archive', { label: c.label });
                    this.toast(`Shipped the ${c.label} pallet`);
                  },
                },
              ]
            : []),
          { label: 'Cancel', run: closeMenu },
        ]
      : [
          { label: 'Copy resume cmd', run: () => this.copy(resumeCommand(c, s.cleanRoot), 'Resume command') },
          {
            label: 'Archive…',
            kind: 'danger',
            run: () => {
              this.archiveMenu = true;
              this.renderWindow();
            },
          },
        ];
    const meta = [
      `${ZONE_NAMES[c.zone]}${c.alertReason ? `: ${c.alertReason}` : ''} for ${ago(s.now - c.zoneSince).replace(' ago', '')}`,
      c.waitingOn ? `waiting on ${c.waitingOn}` : c.lastTool ? `last tool ${c.lastTool}` : '',
      `${c.turns} turn${c.turns === 1 ? '' : 's'}`,
    ].filter(Boolean);
    const toggleFull = this.act(() => {
      this.fullScreen = !this.fullScreen;
      this.renderWindow();
      setTimeout(() => this.terminal?.refit(), 60);
    });

    return `
      <div class="cw-title">
        <span class="dot big" style="background:${repoColor(c.repo)}"></span>
        <div class="cw-name">
          <div class="cw-label" title="Rename" ${rename}>${esc(c.label)} <span class="pencil">✎</span></div>
          <div class="cw-meta">
            <span class="chip zone-${c.zone}">${esc(c.repo)}</span>
            ${c.jiraKey && c.jiraKey !== c.label ? `<span class="chip">${esc(c.jiraKey)}</span>` : ''}
            ${c.readyToShip ? `<span class="chip ship">ready to ship · ${esc(c.readyToShip)}</span>` : ''}
            <span class="dim">${esc(meta.join(' · '))}</span>
          </div>
        </div>
      </div>
      <div class="cw-actions">
        ${actions.map((a) => this.button(a)).join('')}
        <button class="icon" title="${this.fullScreen ? 'Exit full screen' : 'Full screen'}" ${toggleFull}>${this.fullScreen ? '⤡' : '⤢'}</button>
        <button class="icon" title="Close (the terminal keeps running)" ${this.act(() => this.select(null))}>✕</button>
      </div>`;
  }

  private windowInfo(c: CrateView, s: FactoryState): string {
    const details = `
      <dl class="cw-details">
        <dt>Started</dt><dd>${esc(new Date(c.startedAt).toLocaleString())}</dd>
        <dt>Session</dt><dd><code>${esc(lastSessionId(c) ?? 'not started yet')}</code></dd>
        <dt>Directory</dt><dd><code>${esc(c.cwd)}</code></dd>
      </dl>`;
    if (c.slot && c.zone !== 'storage' && !lastSessionId(c) && s.now - c.startedAt < 20_000) {
      return `<div class="cw-empty"><div class="spinner"></div><h3>Starting the terminal…</h3><p>Running scrub-in, then claude.</p></div>`;
    }
    if (c.zone === 'storage') {
      const actions: Action[] = s.features.terminals
        ? [
            { label: 'Resume in a factory terminal', kind: 'primary', run: () => this.resume(c) },
            { label: 'New session, same label', run: () => this.continueLabel(c) },
          ]
        : [];
      return `<div class="cw-empty">
        <h3>This session has ended</h3>
        <p>Resume picks the conversation back up with its full context. A new session starts fresh under the same name, primed with how the last one finished.</p>
        <div class="row center">${actions.map((a) => this.button(a)).join('')}</div>
        ${details}
      </div>`;
    }
    return `<div class="cw-empty">
      <h3>Running in another terminal</h3>
      <p>This session was started outside the factory, so there's no terminal to open here. Sessions started with <b>+ New session</b>, the hopper, or <code>~/clean-room/session-factory/bin/sf</code> open right in this window.</p>
      ${details}
    </div>`;
  }

  async resume(c: CrateView): Promise<void> {
    await post(`/api/crates/${c.id}/resume`);
    this.closeWarehouse();
    this.select(c.id);
  }

  async continueLabel(c: CrateView): Promise<void> {
    const { crateId } = await post<{ crateId: string }>(`/api/crates/${c.id}/continue`);
    this.closeWarehouse();
    this.select(crateId);
  }

  openNewSession(): void {
    const s = this.state;
    if (!s?.features.terminals) return;
    const close = () => {
      this.modal.hidden = true;
    };
    const start = this.act(async () => {
      const label = (document.getElementById('ns-label') as HTMLInputElement).value.trim();
      const prompt = (document.getElementById('ns-prompt') as HTMLTextAreaElement).value.trim();
      const { crateId } = await post<{ crateId: string }>('/api/terminals', { label, prompt });
      close();
      this.select(crateId);
    });
    this.modal.innerHTML = `
      <div class="dialog">
        <header><h2>New session</h2><button class="icon" ${this.act(close)}>✕</button></header>
        <p class="dim">Opens a factory terminal in clean-room that runs <code>scrub-in</code>, then <code>claude</code>.</p>
        ${this.ext.newSessionExtras.map((f) => f(s)).join('')}
        <label>Name <span class="dim">(optional)</span><input id="ns-label" placeholder="e.g. warm runners" /></label>
        <label>First prompt <span class="dim">(optional)</span><textarea id="ns-prompt" rows="4" placeholder="What should Claude start on?"></textarea></label>
        <div class="row end"><button class="btn plain" ${this.act(close)}>Cancel</button><button class="btn primary" ${start}>Start</button></div>
      </div>`;
    this.modal.hidden = false;
    (document.getElementById('ns-label') as HTMLInputElement).focus();
  }

  private renderInbox(): void {
    const returned = this.state?.crates.filter((c) => c.archived && c.returned) ?? [];
    if (!returned.length) {
      this.inbox.hidden = true;
      return;
    }
    this.inbox.innerHTML = `<h4>Returned from the warehouse</h4>${returned
      .map(
        (c) => `<div class="inbox-item">
          <div><b>${esc(c.label)}</b><div class="dim">${esc(c.returned!.reason)}</div></div>
          <div class="row">
            ${this.button({ label: 'Bring back', kind: 'primary', run: () => this.bringBack(c) })}
            ${this.button({ label: 'Dismiss', run: () => post(`/api/crates/${c.id}/dismiss-returned`) })}
          </div>
        </div>`,
      )
      .join('')}`;
    this.inbox.hidden = false;
  }

  async bringBack(c: CrateView): Promise<void> {
    await post(`/api/crates/${c.id}/unarchive`);
    this.toast(`${c.label} is back on the floor`);
  }

  private renderWarehouse(keepFocus = false): void {
    const s = this.state;
    if (!this.warehouseOpen || !s) {
      this.warehouse.hidden = true;
      return;
    }
    const q = this.warehouseQuery.trim().toLowerCase();
    const archived = s.crates
      .filter((c) => c.archived)
      .filter((c) => !q || [c.label, c.repo, c.jiraKey, c.firstPrompt, c.lastMessage, new Date(c.archivedAt ?? 0).toLocaleDateString()].some((f) => f?.toLowerCase().includes(q)))
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    const groups = new Map<string, CrateView[]>();
    for (const c of archived) groups.set(c.label, [...(groups.get(c.label) ?? []), c]);

    const shelves = [...groups.entries()]
      .map(([label, crates]) => {
        const bringAll =
          crates.length > 1
            ? this.button({
                label: `Bring back all (${crates.length})`,
                run: async () => {
                  for (const c of crates) await post(`/api/crates/${c.id}/unarchive`);
                  this.toast(`${label} pallet is back on the floor`);
                },
              })
            : '';
        return `<section class="shelf">
          <div class="shelf-head"><h3>${esc(label)}</h3>${bringAll}</div>
          <div class="shelf-row">${crates.map((c) => this.warehouseCard(c, s)).join('')}</div>
        </section>`;
      })
      .join('');

    const search = this.warehouse.querySelector<HTMLInputElement>('#wh-search');
    const caret = search?.selectionStart ?? null;
    const hadFocus = !!search && document.activeElement === search;
    this.warehouse.innerHTML = `
      <div class="wh-inner">
        <header>
          <h2>WAREHOUSE</h2>
          <input id="wh-search" placeholder="Search name, ticket, repo, date…" value="${esc(this.warehouseQuery)}" />
          <button class="icon" ${this.act(() => this.closeWarehouse())} title="Close">✕</button>
        </header>
        ${shelves || `<p class="empty">${q ? 'Nothing matches that search.' : 'Nothing archived yet. Archive a crate from its window and it ships here.'}</p>`}
      </div>`;
    this.warehouse.hidden = false;
    if (keepFocus && hadFocus) {
      const input = this.warehouse.querySelector<HTMLInputElement>('#wh-search')!;
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }

  private warehouseCard(c: CrateView, s: FactoryState): string {
    const actions: Action[] = [
      { label: 'Bring back', kind: 'primary', run: () => this.bringBack(c) },
      ...(s.features.terminals
        ? [
            { label: 'Resume', run: () => this.resume(c) },
            { label: 'New session, same label', run: () => this.continueLabel(c) },
          ]
        : [{ label: 'Copy resume cmd', run: () => this.copy(resumeCommand(c, s.cleanRoot), 'Resume command') }]),
      ...this.ext.warehouseActions.map((f) => f(c, s)).filter((a): a is Action => !!a),
    ];
    return `<article class="wh-card ${c.returned ? 'returned' : ''}">
      <div class="wh-top"><span class="dot" style="background:${repoColor(c.repo)}"></span>${esc(c.repo)}
        <span class="dim">· archived ${esc(new Date(c.archivedAt ?? 0).toLocaleDateString())}</span>
        ${c.archiveCount > 1 || c.reactivationCount ? `<span class="dim">· round ${c.archiveCount}</span>` : ''}
        ${c.jiraKey && c.jiraKey !== c.label ? `<span class="dim">· ${esc(c.jiraKey)}</span>` : ''}
      </div>
      ${c.returned ? `<div class="returned-badge">returned: ${esc(c.returned.reason)}</div>` : ''}
      ${c.lastMessage ? `<p class="quote dim clamp">${esc(c.lastMessage)}</p>` : ''}
      <div class="row wrap">${actions.map((a) => this.button(a)).join('')}</div>
    </article>`;
  }
}
