import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

/** A browser terminal attached to one factory tmux session. Disposing it only detaches. */
export class AttachedTerminal {
  private readonly xterm: Terminal;
  private readonly fit = new FitAddon();
  private readonly ws: WebSocket;
  private readonly observer: ResizeObserver;

  constructor(
    readonly slot: string,
    container: HTMLElement,
  ) {
    this.xterm = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", ui-monospace, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 1000,
      theme: {
        background: '#121110',
        foreground: '#ece4d8',
        cursor: '#f6b545',
        selectionBackground: '#f28c2855',
        black: '#1c1b19',
        brightBlack: '#5c5650',
        yellow: '#f6b545',
        brightYellow: '#fcd38b',
      },
    });
    this.xterm.loadAddon(this.fit);
    container.replaceChildren();
    this.xterm.open(container);
    this.fit.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws/term/${encodeURIComponent(slot)}?cols=${this.xterm.cols}&rows=${this.xterm.rows}`);
    this.ws.onmessage = (m) => this.xterm.write(m.data as string);
    this.ws.onclose = () => this.xterm.write('\r\n\x1b[33m[terminal detached]\x1b[0m\r\n');
    this.xterm.onData((d) => this.send({ t: 'i', d }));
    this.xterm.onResize(({ cols, rows }) => this.send({ t: 'r', c: cols, r: rows }));

    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(container);
    this.xterm.focus();
  }

  private send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  refit(): void {
    try {
      this.fit.fit();
    } catch {
      // container hidden
    }
  }

  focus(): void {
    this.xterm.focus();
  }

  dispose(): void {
    this.observer.disconnect();
    this.ws.close();
    this.xterm.dispose();
  }
}
