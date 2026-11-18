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
  /** Background work the session is paused on at Stop (shell, subagent, monitor, scheduled wakeup...). */
  waitingOn?: string;
}

function describeBackground(payload: Record<string, unknown>): string | undefined {
  const tasks = Array.isArray(payload.background_tasks) ? (payload.background_tasks as Record<string, unknown>[]) : [];
  const crons = Array.isArray(payload.session_crons) ? payload.session_crons : [];
  if (tasks.length) {
    const t = tasks[0];
    const what = str(t.type) ?? 'task';
    const detail = str(t.description) ?? str(t.command) ?? str(t.agent_type) ?? str(t.name);
    const more = tasks.length > 1 ? ` +${tasks.length - 1}` : '';
    return `${what}${detail ? `: ${detail.slice(0, 60)}` : ''}${more}`;
  }
  return crons.length ? 'scheduled wakeup' : undefined;
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
      return { ...base, kind: 'prompt', prompt: str(payload.prompt), title: str(payload.session_title) };
    case 'PreToolUse':
      return { ...base, kind: 'preTool', tool: str(payload.tool_name) };
    case 'PermissionRequest':
      // Fires the moment the prompt appears (the permission_prompt notification only comes ~6 s later).
      return { ...base, kind: 'notify', notificationType: 'permission_prompt' };
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { ...base, kind: 'postTool', tool: str(payload.tool_name) };
    case 'Notification':
      return { ...base, kind: 'notify', notificationType: str(payload.notification_type), message: str(payload.message) };
    case 'Stop':
      return { ...base, kind: 'stop', lastMessage: str(payload.last_assistant_message), waitingOn: describeBackground(payload) };
    case 'SessionEnd':
      return { ...base, kind: 'end', reason: str(payload.reason) };
    default:
      return null;
  }
}
