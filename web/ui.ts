import type { CrateView, FactoryState, HopperTicket } from '../src/shared/types';
import { AlertNotifier } from './alerts';
import { get, post } from './api';
import { crateColor } from './scene';
import { AttachedTerminal } from './terminal';

export interface Action {
  label: string;
  kind?: 'primary' | 'danger' | 'plain';
  run: () => void | Promise<void>;
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

const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
/** Corners pointing out: go full screen. */
const ICON_EXPAND = svg('M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5');
/** Corners pointing in: leave full screen. */
const ICON_COLLAPSE = svg('M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5');

const ZONE_NAMES: Record<string, string> = {
  intake: 'Intake',
  working: 'Working',
  alert: 'Needs you',
  dock: 'Waiting for prompt',
  storage: 'Ended',
};

export class Ui {
  private state: FactoryState | null = null;
  private connected = false;
  private selected: string | null = null;
  private warehouseOpen = false;
  private warehouseQuery = '';
  private archiveMenu = false;
  private fullScreen = false;
  private moveNotice: { id: string; text: string } | null = null;
  private terminal: AttachedTerminal | null = null;
  private readonly alerts = new AlertNotifier();
  /** Click handlers by key. Page handlers are rebuilt on every state update; dialog handlers live until the dialog changes. */
  private actionMap = new Map<string, { fn: () => void | Promise<void>; dialog: boolean }>();
  private actionSeq = 0;
  private buildingDialog = false;

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
      const fn = this.actionMap.get(el.dataset.act!)?.fn;
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
    this.alerts.onState(state, (id) => this.select(id));
    if (this.selected && !state.crates.find((c) => c.id === this.selected && !c.archived)) this.select(null);
    this.render();
  }

  setConnected(up: boolean): void {
    this.connected = up;
    this.renderTop();
  }

  select(id: string | null): void {
    if (id !== this.selected) {
      this.moveNotice = null;
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
      ${c.jiraKey && c.jiraKey !== c.label ? `<div class="tt-row">${esc(c.jiraKey)}</div>` : ''}
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
    this.actionMap.set(key, { fn, dialog: this.buildingDialog });
    return `data-act="${key}"`;
  }

  /** Builds dialog markup whose handlers survive page re-renders (state updates arrive constantly). */
  private inDialog<T>(build: () => T): T {
    this.buildingDialog = true;
    try {
      return build();
    } finally {
      this.buildingDialog = false;
    }
  }

  private clearActions(dialog: boolean): void {
    for (const [key, a] of this.actionMap) if (a.dialog === dialog) this.actionMap.delete(key);
  }

  button(a: Action): string {
    return `<button class="btn ${a.kind ?? 'plain'}" ${this.act(a.run)}>${esc(a.label)}</button>`;
  }

  private render(): void {
    this.clearActions(false);
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
        <span class="stat produced" title="Finished turns since midnight"><b>${s?.stats.turnsToday ?? 0}</b> turns today</span>
      </div>
      <div class="actions">
        ${s?.features.terminals ? this.button({ label: '+ New session', kind: 'primary', run: () => this.openNewSession() }) : ''}
        ${this.button({ label: 'Warehouse', run: () => this.openWarehouse() })}
        <button class="icon bell ${this.alerts.enabled ? 'on' : ''}" title="${this.alerts.enabled ? 'Alert sound on' : 'Alert sound off'}" ${this.act(async () => { await this.alerts.toggle(); this.renderTop(); })}>${this.alerts.enabled ? '🔔' : '🔕'}</button>
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
          ...(c.hasTerminal
            ? [
                {
                  label: 'End session',
                  kind: 'danger' as const,
                  run: async () => {
                    const busy = c.zone === 'working' || c.zone === 'alert';
                    if (busy && !window.confirm(`Claude is in the middle of a turn in "${c.label}". End the session anyway? This interrupts it and closes the terminal.`)) return;
                    this.toast('Ending session…');
                    await post(`/api/crates/${c.id}/end`);
                    this.toast(`${c.label} ended`);
                  },
                },
              ]
            : []),
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
      `${c.alertReason ? `${c.alertReason}, ` : ''}for ${ago(s.now - c.zoneSince).replace(' ago', '')}`,
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
        <span class="dot big" style="background:${crateColor(c.id)}"></span>
        <div class="cw-name">
          <div class="cw-label" title="Rename" ${rename}>${esc(c.label)} <span class="pencil">✎</span></div>
          <div class="cw-meta">
            <span class="chip zone-${c.zone}">${esc(ZONE_NAMES[c.zone])}</span>
            ${c.jiraKey ? this.jiraChip(c, s) : ''}
            ${c.readyToShip ? `<span class="chip ship">ready to ship · ${esc(c.readyToShip)}</span>` : ''}
            <span class="dim">${esc(meta.join(' · '))}</span>
          </div>
        </div>
      </div>
      <div class="cw-actions">
        ${actions.map((a) => this.button(a)).join('')}
        <button class="icon svg" title="${this.fullScreen ? 'Exit full screen' : 'Full screen'}" aria-label="${this.fullScreen ? 'Exit full screen' : 'Full screen'}" ${toggleFull}>${this.fullScreen ? ICON_COLLAPSE : ICON_EXPAND}</button>
        <button class="icon" title="Close (the terminal keeps running)" ${this.act(() => this.select(null))}>✕</button>
      </div>`;
  }

  private jiraChip(c: CrateView, s: FactoryState): string {
    const text = `${c.jiraKey}${c.jira?.status ? ` · ${c.jira.status}` : ''}`;
    return s.features.jiraHost
      ? `<a class="chip link" href="${esc(`${s.features.jiraHost}/browse/${c.jiraKey}`)}" target="_blank" rel="noreferrer">${esc(text)} ↗</a>`
      : `<span class="chip">${esc(text)}</span>`;
  }

  private windowInfo(c: CrateView, s: FactoryState): string {
    const details = `
      <dl class="cw-details">
        <dt>Started</dt><dd>${esc(new Date(c.startedAt).toLocaleString())}</dd>
        <dt>Session</dt><dd><code>${esc(lastSessionId(c) ?? 'not started yet')}</code></dd>
        <dt>Started in</dt><dd><code>${esc(c.cwd)}</code></dd>
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
    const move = s.features.terminals ? this.button({ label: 'Move to factory', kind: 'primary', run: () => this.moveToFactory(c) }) : '';
    const notice = this.moveNotice?.id === c.id ? `<div class="notice">${esc(this.moveNotice.text)}</div>` : '';
    return `<div class="cw-empty">
      <h3>Running in another terminal</h3>
      <p>This session was started outside the factory, so there's no terminal to open here. <b>Move to factory</b> resumes it in a factory terminal with its full context, once it's closed in the other terminal.</p>
      ${notice}
      <div class="row center">${move}</div>
      ${details}
    </div>`;
  }

  /** Hand a session over from an outside terminal; stops and explains if it still looks open there. */
  async moveToFactory(c: CrateView): Promise<void> {
    try {
      await post(`/api/crates/${c.id}/resume`);
      this.moveNotice = null;
      this.toast(`${c.label} moved into a factory terminal`);
      this.renderWindow();
    } catch (err) {
      this.moveNotice = { id: c.id, text: (err as Error).message };
      this.renderWindow();
    }
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
    this.clearActions(true);
    this.inDialog(() => this.buildNewSession(s));
    this.modal.hidden = false;
    (document.getElementById('ns-label') as HTMLInputElement).focus();
    if (s.features.jira) void this.loadTickets(false);
  }

  private buildNewSession(s: FactoryState): void {
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
        ${s.features.jira ? `<section class="hopper"><div class="hopper-head"><h3>Your Jira tickets</h3><button class="icon" title="Refresh" ${this.act(() => this.loadTickets(true))}>↻</button></div><div id="ns-tickets" class="tickets"><div class="dim">Loading tickets…</div></div></section><div class="or"><span>or start blank</span></div>` : ''}
        <label>Name <span class="dim">(optional)</span><input id="ns-label" placeholder="e.g. warm runners" /></label>
        <label>First prompt <span class="dim">(optional)</span><textarea id="ns-prompt" rows="4" placeholder="What should Claude start on?"></textarea></label>
        <div class="row end"><button class="btn plain" ${this.act(close)}>Cancel</button><button class="btn primary" ${start}>Start</button></div>
      </div>`;
  }

  private showTicketsOnFloor = false;

  /**
   * Lists assigned tickets. Ones that already have a live session are hidden behind a toggle (Open jumps to
   * that crate); ones with an archived session offer Resume as well as a fresh start.
   */
  private async loadTickets(refresh: boolean): Promise<void> {
    const box = document.getElementById('ns-tickets');
    if (!box) return;
    box.innerHTML = '<div class="dim">Loading tickets…</div>';
    let tickets: HopperTicket[];
    try {
      ({ tickets } = await get<{ tickets: HopperTicket[] }>(`/api/jira/assigned${refresh ? '?refresh=1' : ''}`));
    } catch (err) {
      box.innerHTML = `<div class="error">Couldn't load tickets: ${esc((err as Error).message)}</div>`;
      return;
    }
    if (!document.getElementById('ns-tickets')) return;
    const close = () => {
      this.modal.hidden = true;
    };
    const start = (t: HopperTicket): Action => ({
      label: t.archivedCrateId ? 'Start new' : 'Start',
      kind: t.archivedCrateId ? 'plain' : 'primary',
      run: async () => {
        const { crateId } = await post<{ crateId: string }>(`/api/jira/${encodeURIComponent(t.key)}/start`);
        close();
        this.select(crateId);
      },
    });
    const row = (t: HopperTicket) => {
      const actions: Action[] = t.liveCrateId
        ? [{ label: 'Open', kind: 'primary', run: () => { close(); this.select(t.liveCrateId!); } }]
        : t.archivedCrateId
          ? [
              {
                label: 'Resume',
                kind: 'primary',
                run: async () => {
                  close();
                  await this.resume({ id: t.archivedCrateId! } as CrateView);
                },
              },
              start(t),
            ]
          : [start(t)];
      const note = t.liveCrateId ? '<span class="chip ship">on the floor</span>' : t.archivedCrateId ? '<span class="chip">in the warehouse</span>' : '';
      return `<div class="ticket">
        <div class="ticket-text"><b>${esc(t.key)}</b> <span class="chip">${esc(t.status)}</span> ${note}<div>${esc(t.summary)}</div></div>
        <div class="row">${actions.map((a) => this.button(a)).join('')}</div>
      </div>`;
    };
    const render = () => {
      const live = tickets.filter((t) => t.liveCrateId);
      const shown = tickets.filter((t) => this.showTicketsOnFloor || !t.liveCrateId);
      const toggle = live.length
        ? `<button class="linkish" ${this.act(() => { this.showTicketsOnFloor = !this.showTicketsOnFloor; renderInDialog(); })}>${this.showTicketsOnFloor ? 'Hide' : 'Show'} ${live.length} already on the floor</button>`
        : '';
      box.innerHTML = (shown.length ? shown.map(row).join('') : '<div class="dim">Every assigned ticket already has a session on the floor.</div>') + toggle;
    };
    const renderInDialog = () => this.inDialog(render);
    renderInDialog();
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
      .filter((c) => !q || [c.label, c.jiraKey, c.firstPrompt, c.lastMessage, new Date(c.archivedAt ?? 0).toLocaleDateString()].some((f) => f?.toLowerCase().includes(q)))
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
          <input id="wh-search" placeholder="Search name, ticket, date…" value="${esc(this.warehouseQuery)}" />
          ${this.button({
            label: 'Import older sessions',
            run: async () => {
              const { added, scanned } = await post<{ added: number; scanned: number }>('/api/history/import');
              this.toast(added ? `Imported ${added} past session${added === 1 ? '' : 's'}` : `Nothing new (${scanned} past sessions already here)`);
            },
          })}
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
    ];
    return `<article class="wh-card ${c.returned ? 'returned' : ''}">
      <div class="wh-top"><span class="dot" style="background:${crateColor(c.id)}"></span>
        <span class="dim">archived ${esc(new Date(c.archivedAt ?? 0).toLocaleDateString())}</span>
        ${c.archiveCount > 1 || c.reactivationCount ? `<span class="dim">· round ${c.archiveCount}</span>` : ''}
        ${c.jiraKey && c.jiraKey !== c.label ? `<span class="dim">· ${esc(c.jiraKey)}</span>` : ''}
      </div>
      ${c.returned ? `<div class="returned-badge">returned: ${esc(c.returned.reason)}</div>` : ''}
      ${c.lastMessage ? `<p class="quote dim clamp">${esc(c.lastMessage)}</p>` : ''}
      <div class="row wrap">${actions.map((a) => this.button(a)).join('')}</div>
    </article>`;
  }
}
