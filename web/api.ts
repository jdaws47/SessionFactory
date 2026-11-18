import type { FactoryState, ServerMessage } from '../src/shared/types';

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Subscribes to state pushes, reconnecting with backoff. */
export function subscribe(onState: (s: FactoryState) => void, onConnection: (up: boolean) => void): void {
  let delay = 500;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      delay = 500;
      onConnection(true);
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data as string) as ServerMessage;
      if (msg.type === 'state') onState(msg.state);
    };
    ws.onclose = () => {
      onConnection(false);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  connect();
}
