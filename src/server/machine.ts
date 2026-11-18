import type { Crate, Zone } from '../shared/types';
import type { FactoryEvent } from './events';
import { refreshLabel, repoOf, snippet } from './labels';

const QUESTION_TOOLS: Record<string, string> = { AskUserQuestion: 'question', ExitPlanMode: 'plan approval' };
/** Prompts Claude Code injects itself (background task results etc.), not typed by the user. */
export function isSyntheticPrompt(prompt: string | undefined): boolean {
  return !!prompt && /^\s*<[a-z][\w-]*[\s>]/.test(prompt);
}

/** Ways a closing paragraph waits for a go-ahead without a question mark. */
const ASKING = /\b(let me know (which|what|when|whether|how)|tell me (when|which|what|whether)|say the word|say go|when you say|if (that|this) (works|sounds|matches)|unless you|your call|up to you|want me to|should i|shall i)\b/i;

/**
 * Whether Claude's last message ends by asking you something: its final paragraph has a question or waits for a
 * go-ahead, or, when the final paragraph is a list of options, the paragraph just before it does. Code is ignored.
 */
export function endsWithQuestion(message: string | undefined): boolean {
  if (!message) return false;
  const blocks = message
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const last = blocks[blocks.length - 1];
  if (!last) return false;
  const isList = last.split('\n').every((line) => /^\s*([-*+]|\d+[.)])\s/.test(line));
  const tail = isList ? blocks.slice(-2) : [last];
  return tail.some((b) => {
    const text = b.replace(/`[^`\n]*`/g, '');
    return /\?(\s|[*_)"'\]]|$)/.test(text) || ASKING.test(text);
  });
}

const INPUT_NOTIFICATIONS = new Set(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

export function newCrate(ev: FactoryEvent, cleanRoot: string, id: string): Crate {
  const crate: Crate = {
    id,
    sessionIds: [],
    cwd: ev.cwd,
    repo: repoOf(ev.cwd, cleanRoot),
    label: '',
    labelSource: 'auto',
    zone: 'intake',
    zoneSince: ev.at,
    turns: 0,
    startedAt: ev.at,
    updatedAt: ev.at,
    archived: false,
    archiveCount: 0,
    reactivationCount: 0,
  };
  refreshLabel(crate);
  return crate;
}

/** Pure transition: returns the crate after one hook event. */
export function applyEvent(crate: Crate, ev: FactoryEvent, jiraProjects?: string[]): Crate {
  const next: Crate = { ...crate, updatedAt: ev.at };
  if (ev.kind !== 'stop' && ev.kind !== 'notify') next.waitingOn = undefined;
  if (ev.pid) next.pid = ev.pid;
  if (!next.sessionIds.includes(ev.sessionId)) next.sessionIds = [...next.sessionIds, ev.sessionId];

  const moveTo = (zone: Zone, alertReason?: string) => {
    if (next.zone !== zone) {
      next.zone = zone;
      next.zoneSince = ev.at;
    }
    next.alertReason = zone === 'alert' ? alertReason : undefined;
  };

  switch (ev.kind) {
    case 'start':
      next.endedAt = undefined;
      if (ev.title) next.title = ev.title;
      if (ev.source !== 'compact') moveTo(ev.source === 'resume' ? 'dock' : 'intake');
      break;
    case 'prompt': {
      next.endedAt = undefined;
      if (ev.title) next.title = ev.title;
      const prompt = ev.prompt && !isSyntheticPrompt(ev.prompt) ? snippet(ev.prompt, 400) : undefined;
      if (prompt && !next.firstPrompt) next.firstPrompt = prompt;
      if (prompt) next.lastPrompt = prompt;
      moveTo('working');
      break;
    }
    case 'preTool':
      next.lastTool = ev.tool;
      if (ev.tool && QUESTION_TOOLS[ev.tool]) moveTo('alert', QUESTION_TOOLS[ev.tool]);
      else moveTo('working');
      break;
    case 'postTool':
      next.lastTool = ev.tool;
      moveTo('working');
      break;
    case 'notify':
      if (ev.notificationType === 'permission_prompt') moveTo('alert', 'permission');
      else if (ev.notificationType && INPUT_NOTIFICATIONS.has(ev.notificationType)) moveTo('alert', 'input needed');
      else if (ev.notificationType === 'idle_prompt' && !next.waitingOn && (next.zone === 'working' || (next.zone === 'alert' && next.alertReason !== 'asked a question'))) moveTo('dock');
      break;
    case 'stop':
      next.turns += 1;
      if (ev.lastMessage) next.lastMessage = snippet(ev.lastMessage, 600);
      next.waitingOn = ev.waitingOn;
      if (ev.waitingOn) moveTo('working');
      else if (endsWithQuestion(ev.lastMessage)) moveTo('alert', 'asked a question');
      else moveTo('dock');
      break;
    case 'end':
      next.endedAt = ev.at;
      moveTo('storage');
      break;
  }

  if (crate.archived && (ev.kind === 'start' || ev.kind === 'prompt') && !next.returned) {
    next.returned = { reason: 'session active again', at: ev.at };
  }
  refreshLabel(next, jiraProjects);
  return next;
}
