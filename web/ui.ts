import type { CrateView, FactoryState } from '../src/shared/types';
import { post } from './api';
import { repoColor } from './scene';

export interface Action {
  label: string;
  kind?: 'primary' | 'danger' | 'plain';
  run: () => void | Promise<void>;
}

/** Hooks later features use to add buttons without the core UI knowing about them. */
export interface UiExtensions {
  crateActions: Array<(c: CrateView, state: FactoryState) => Action | null>;
  warehouseActions: Array<(c: CrateView, state: FactoryState) => Action | null>;
  toolbarActions: Array<(state: FactoryState) => Action | null>;
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
  readonly ext: UiExtensions = { crateActions: [], warehouseActions: [], toolbarActions: [] };
  private state: FactoryState | null = null;
  private connected = false;
  private selected: string | null = null;
  private warehouseOpen = false;
  private warehouseQuery = '';
  private actionMap = new Map<string, () => void | Promise<void>>();
  private actionSeq = 0;

  private top = document.getElementById('topbar')!;
  private panel = document.getElementById('panel')!;
  private tooltip = document.getElementById('tooltip')!;
  private inbox = document.getElementById('inbox')!;
  private warehouse = document.getElementById('warehouse')!;
  private toastEl = document.getElementById('toast')!;

  constructor(private readonly onSelect: (id: string | null) => void) {
    document.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!el) return;
      const fn = this.actionMap.get(el.dataset.act!);
      if (fn) Promise.resolve(fn()).catch((err) => this.toast(`Failed: ${(err as Error).message}`));
    });
    this.warehouse.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.id === 'wh-search') {
        this.warehouseQuery = input.value;
        this.renderWarehouse(true);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.warehouseOpen) this.closeWarehouse();
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
    this.selected = id;
    this.onSelect(id);
    this.renderPanel();
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
      ${c.lastTool ? `<div class="tt-row dim">last tool: ${esc(c.lastTool)}</div>` : ''}
      ${c.readyToShip ? `<div class="tt-row ship">ready to ship: ${esc(c.readyToShip)}</div>` : ''}`;
    this.tooltip.hidden = false;
    const r = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(x + 16, innerWidth - r.width - 8)}px`;
    this.tooltip.style.top = `${Math.min(y + 16, innerHeight - r.height - 8)}px`;
  }

  /** Registers a click handler for this render pass and returns the attribute that triggers it. */
  private act(fn: () => void | Promise<void>): string {
    const key = `a${++this.actionSeq}`;
    this.actionMap.set(key, fn);
    return `data-act="${key}"`;
  }

  private button(a: Action): string {
    return `<button class="btn ${a.kind ?? 'plain'}" ${this.act(a.run)}>${esc(a.label)}</button>`;
  }

  private render(): void {
    this.actionMap.clear();
    this.renderTop();
    this.renderPanel();
    this.renderInbox();
    if (this.warehouseOpen) this.renderWarehouse(true);
  }

  private renderTop(): void {
    const s = this.state;
    const live = s?.crates.filter((c) => !c.archived) ?? [];
    const count = (z: string) => live.filter((c) => c.zone === z).length;
    const extra = s ? this.ext.toolbarActions.map((f) => f(s)).filter((a): a is Action => !!a) : [];
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
        ${extra.map((a) => this.button(a)).join('')}
        ${this.button({ label: 'Warehouse', run: () => this.openWarehouse() })}
        <span class="conn ${this.connected ? 'up' : 'down'}" title="${this.connected ? 'connected' : 'reconnecting…'}"></span>
      </div>`;
  }

  private renderPanel(): void {
    const s = this.state;
    const c = s?.crates.find((x) => x.id === this.selected);
    if (!s || !c) {
      this.panel.hidden = true;
      return;
    }
    const sameLabel = s.crates.filter((x) => !x.archived && x.label === c.label).length;
    const actions: Action[] = [
      ...this.ext.crateActions.map((f) => f(c, s)).filter((a): a is Action => !!a),
      { label: 'Copy resume command', run: () => this.copy(resumeCommand(c, s.cleanRoot), 'Resume command') },
      {
        label: 'Archive',
        kind: 'danger',
        run: async () => {
          await post(`/api/crates/${c.id}/archive`);
          this.toast(`Shipped ${c.label} to the warehouse`);
        },
      },
    ];
    if (sameLabel > 1) {
      actions.push({
        label: `Archive all "${c.label}" (${sameLabel})`,
        kind: 'danger',
        run: async () => {
          await post('/api/labels/archive', { label: c.label });
          this.toast(`Shipped the ${c.label} pallet`);
        },
      });
    }

    const saveLabel = this.act(async () => {
      const input = document.getElementById('label-input') as HTMLInputElement;
      await post(`/api/crates/${c.id}/label`, { label: input.value });
      this.toast(input.value.trim() ? 'Label saved' : 'Label reset to automatic');
    });

    const prev = document.getElementById('label-input') as HTMLInputElement | null;
    const keep = prev && document.activeElement === prev && prev.dataset.crate === c.id ? { value: prev.value, caret: prev.selectionStart } : null;
    this.panel.innerHTML = `
      <header>
        <div>
          <div class="p-label">${esc(c.label)}</div>
          <div class="chips">
            <span class="chip" style="border-color:${repoColor(c.repo)}">${esc(c.repo)}</span>
            <span class="chip zone-${c.zone}">${esc(ZONE_NAMES[c.zone])}${c.alertReason ? `: ${esc(c.alertReason)}` : ''}</span>
            ${c.readyToShip ? `<span class="chip ship">ready to ship · ${esc(c.readyToShip)}</span>` : ''}
          </div>
        </div>
        <button class="icon" ${this.act(() => this.select(null))} title="Close">✕</button>
      </header>
      <dl>
        <dt>In this state</dt><dd>${esc(ago(s.now - c.zoneSince).replace(' ago', ''))}</dd>
        <dt>Started</dt><dd>${esc(new Date(c.startedAt).toLocaleString())}</dd>
        <dt>Turns</dt><dd>${c.turns}</dd>
        ${c.lastTool ? `<dt>Last tool</dt><dd><code>${esc(c.lastTool)}</code></dd>` : ''}
        ${c.jira?.status ? `<dt>Jira</dt><dd>${esc(c.jira.status)}</dd>` : ''}
        <dt>Session</dt><dd><code>${esc(lastSessionId(c) ?? 'not started yet')}</code></dd>
        <dt>Directory</dt><dd><code>${esc(c.cwd)}</code></dd>
      </dl>
      ${c.firstPrompt ? `<h4>First prompt</h4><p class="quote">${esc(c.firstPrompt)}</p>` : ''}
      ${c.lastMessage ? `<h4>Last reply</h4><p class="quote">${esc(c.lastMessage)}</p>` : ''}
      <h4>Label</h4>
      <div class="row"><input id="label-input" data-crate="${esc(c.id)}" value="${esc(c.labelSource === 'manual' ? c.label : '')}" placeholder="${esc(c.label)}" /><button class="btn plain" ${saveLabel}>Save</button></div>
      <div class="p-actions">${actions.map((a) => this.button(a)).join('')}</div>`;
    this.panel.hidden = false;
    if (keep) {
      const input = document.getElementById('label-input') as HTMLInputElement;
      input.value = keep.value;
      input.focus();
      if (keep.caret !== null) input.setSelectionRange(keep.caret, keep.caret);
    }
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
        const bringAll = crates.length > 1 ? this.button({ label: `Bring back all (${crates.length})`, run: async () => { for (const c of crates) await post(`/api/crates/${c.id}/unarchive`); this.toast(`${label} pallet is back on the floor`); } }) : '';
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
          <input id="wh-search" placeholder="Search ticket, topic, repo, date…" value="${esc(this.warehouseQuery)}" />
          <button class="icon" ${this.act(() => this.closeWarehouse())} title="Close">✕</button>
        </header>
        ${shelves || `<p class="empty">${q ? 'Nothing matches that search.' : 'Nothing archived yet. Archive a crate from its panel and it ships here.'}</p>`}
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
      ...this.ext.warehouseActions.map((f) => f(c, s)).filter((a): a is Action => !!a),
      { label: 'Copy resume command', run: () => this.copy(resumeCommand(c, s.cleanRoot), 'Resume command') },
    ];
    return `<article class="wh-card ${c.returned ? 'returned' : ''}">
      <div class="wh-top"><span class="dot" style="background:${repoColor(c.repo)}"></span>${esc(c.repo)}
        <span class="dim">· archived ${esc(new Date(c.archivedAt ?? 0).toLocaleDateString())}</span>
        ${c.archiveCount > 1 || c.reactivationCount ? `<span class="dim">· round ${c.archiveCount}</span>` : ''}
      </div>
      ${c.returned ? `<div class="returned-badge">returned: ${esc(c.returned.reason)}</div>` : ''}
      ${c.firstPrompt ? `<p class="quote">${esc(c.firstPrompt)}</p>` : ''}
      ${c.lastMessage ? `<p class="quote dim">${esc(c.lastMessage)}</p>` : ''}
      <div class="row wrap">${actions.map((a) => this.button(a)).join('')}</div>
    </article>`;
  }
}
