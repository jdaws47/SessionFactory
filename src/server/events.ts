/** A hook event reduced to the fields the factory uses. Transcript paths are deliberately never kept. */
export interface FactoryEvent {
  at: number;
  sessionId: string;
  cwd: string;
  pid?: number;
  slot?: string;
  kind: 'start' | 'prompt' | 'preTool' | 'postTool' | 'notify' | 'stop' | 'end';
  source?: string;
  title?: string;
  prompt?: string;
  tool?: string;
  notificationType?: string;
  message?: string;
  lastMessage?: string;
  reason?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Converts the envelope written by hooks/emit-event into a FactoryEvent, or null if it is not usable. */
export function normalize(raw: unknown): FactoryEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const { sf, payload } = raw as { sf?: Record<string, unknown>; payload?: Record<string, unknown> };
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = str(payload.session_id);
  const cwd = str(payload.cwd);
  if (!sessionId || !cwd) return null;

  const base = { at: num(sf?.at) ?? Date.now(), pid: num(sf?.pid), slot: str(sf?.slot), sessionId, cwd };
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return { ...base, kind: 'start', source: str(payload.source), title: str(payload.session_title) };
    case 'UserPromptSubmit':
      return { ...base, kind: 'prompt', prompt: str(payload.prompt) };
    case 'PreToolUse':
      return { ...base, kind: 'preTool', tool: str(payload.tool_name) };
    case 'PostToolUse':
      return { ...base, kind: 'postTool', tool: str(payload.tool_name) };
    case 'Notification':
      return { ...base, kind: 'notify', notificationType: str(payload.notification_type), message: str(payload.message) };
    case 'Stop':
      return { ...base, kind: 'stop', lastMessage: str(payload.last_assistant_message) };
    case 'SessionEnd':
      return { ...base, kind: 'end', reason: str(payload.reason) };
    default:
      return null;
  }
}
