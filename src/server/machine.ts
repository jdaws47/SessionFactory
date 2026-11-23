import type { Crate, Zone } from '../shared/types';
import type { FactoryEvent } from './events';
import { refreshLabel, repoOf, snippet } from './labels';

const QUESTION_TOOLS: Record<string, string> = { AskUserQuestion: 'question', ExitPlanMode: 'plan approval' };
/** Prompts Claude Code injects itself (background task results etc.), not typed by the user. */
export function isSyntheticPrompt(prompt: string | undefined): boolean {
  return !!prompt && /^\s*<[a-z][\w-]*[\s>]/.test(prompt);
}

/** A closing paragraph that needs a choice or information from you before Claude can go on. */
const DECISION =
  /\b(if you (pick|choose|go with)|(how|what) (do|would|should) you want|how should (i|we)|which (one|option|approach|way|do you|would you|of)|pick (one|between|either)|choose (between|one)|let me know (which|what|whether|how)|tell me (which|what|whether)|i need (you|to know|your)|your call|up to you)\b/i;

/** A closing paragraph only waiting for a go-ahead: the plan is set, you just say go (or do your part first). */
const GO_AHEAD =
  /\b(want me to|do you want me to|should i|shall i|ready to|say the word|say go|when you say|tell me when|once you|go ahead|good to go|ok(ay)? to)\b/i;

/**
 * Whether Claude's last message ends needing a decision or an answer from you, as opposed to being done or only
 * waiting for a go-ahead. Looks at the final paragraph (and, when that is a list of options, the paragraph before
 * it): a choice ("which…", "if you pick…", "I need…") or an open question counts; a yes/no go-ahead ("want me
 * to…?", "say the word", "once you've created the branch, I'll start") does not. Code and quotes are ignored.
 */
export function endsWithQuestion(message: string | undefined): boolean {
  if (!message) return false;
  // Code, quoted text and blockquotes are things being cited, not Claude asking (e.g. a PR template's "How was it tested?").
  const blocks = message
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, '""')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const last = blocks[blocks.length - 1];
  if (!last) return false;
  const isList = last.split('\n').every((line) => /^\s*([-*+]|\d+[.)])\s/.test(line));
  // A one-sentence closing paragraph doesn't hide the sentence just before it ("Which do you want?\n\nI'll wait.").
  const sentences = (b: string) => b.match(/[^.?!]+(?:[.?!]+|$)/g) ?? [];
  const before = blocks.length > 1 && !isList && sentences(last).length === 1 ? sentences(blocks[blocks.length - 2]).slice(-1) : [];
  const text = (isList ? blocks.slice(-2) : [...before, last]).join('\n').replace(/`[^`\n]*`/g, '');
  if (DECISION.test(text)) return true;
  // Judge each question on its own: one offering alternatives ("…, or should I create one?"), or any question that
  // isn't a yes/no go-ahead, needs you; a go-ahead question alone ("Want me to start?") doesn't.
  const questions = text.match(/[^.?!\n]*\?(?=\s|[*_)"'\]]|$)/g) ?? [];
  return questions.some((q) => /\b(or|which)\b/i.test(q) || !GO_AHEAD.test(q));
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
