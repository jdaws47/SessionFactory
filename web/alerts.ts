import type { CrateView, FactoryState } from '../src/shared/types';

const KEY = 'sf-alert-sound';

/** Plays a chime (and a desktop notification when the tab is hidden) when a crate enters the alert bay. */
export class AlertNotifier {
  private previous = new Map<string, string>();
  private primed = false;
  private audio: AudioContext | null = null;
  enabled = false;

  constructor() {
    try {
      this.enabled = localStorage.getItem(KEY) === 'on';
    } catch {
      this.enabled = false;
    }
  }

  async toggle(): Promise<void> {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem(KEY, this.enabled ? 'on' : 'off');
    } catch {
      // per-browser convenience only
    }
    if (this.enabled) {
      this.audio ??= new AudioContext();
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      this.chime();
    }
  }

  onState(state: FactoryState, open: (id: string) => void): void {
    for (const c of state.crates) {
      const was = this.previous.get(c.id);
      if (this.primed && this.enabled && !c.archived && c.zone === 'alert' && was !== 'alert') this.notify(c, open);
      this.previous.set(c.id, c.archived ? 'archived' : c.zone);
    }
    this.primed = true;
  }

  private notify(c: CrateView, open: (id: string) => void): void {
    this.chime();
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`${c.label} needs you`, { body: c.alertReason ?? 'Waiting on your answer', tag: c.id });
      n.onclick = () => {
        window.focus();
        open(c.id);
        n.close();
      };
    }
  }

  private chime(): void {
    if (!this.audio) {
      try {
        this.audio = new AudioContext();
      } catch {
        return;
      }
    }
    const ctx = this.audio;
    const t0 = ctx.currentTime;
    for (const [i, freq] of [660, 880].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.14 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + i * 0.14);
      osc.stop(t0 + i * 0.14 + 0.4);
    }
  }
}
