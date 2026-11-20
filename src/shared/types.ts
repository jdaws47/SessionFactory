/** Where a crate sits on the factory floor. */
export type Zone = 'intake' | 'working' | 'alert' | 'dock' | 'storage';

export type LabelSource = 'auto' | 'jira' | 'manual';

export interface JiraInfo {
  status?: string;
  resolved?: boolean;
  statusAtArchive?: string;
  checkedAt?: number;
}

/** One tracked Claude Code session (or chain of sessions linked by /clear, resume or a factory terminal). */
export interface Crate {
  id: string;
  sessionIds: string[];
  /** Factory terminal slot (tmux session name) when the factory started this session. */
  slot?: string;
  pid?: number;
  cwd: string;
  repo: string;
  label: string;
  labelSource: LabelSource;
  jiraKey?: string;
  /** You unlinked the Jira ticket; don't detect one again. */
  jiraUnlinked?: boolean;
  title?: string;
  zone: Zone;
  zoneSince: number;
  alertReason?: string;
  lastTool?: string;
  /** Set while a finished turn is paused on background work; the crate stays in a machine. */
  waitingOn?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  lastMessage?: string;
  turns: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  archived: boolean;
  archivedAt?: number;
  archiveCount: number;
  reactivationCount: number;
  returned?: { reason: string; at: number };
  jira?: JiraInfo;
}

export interface CrateView extends Crate {
  /** Why the crate looks finished; a visual hint only, never acted on automatically. */
  readyToShip?: string;
  /** True when a live factory terminal is attached to this crate. */
  hasTerminal?: boolean;
}

export interface FactoryState {
  now: number;
  crates: CrateView[];
  /** The loading dock's queue, front first: crates waiting for you, longest-waiting first. The page lays the dock out in this order. */
  dockOrder: string[];
  cleanRoot: string;
  features: { terminals: boolean; jira: boolean; jiraHost?: string };
  stats: { turnsToday: number };
}

export interface JiraTicket {
  key: string;
  summary: string;
  status: string;
}

/** A ticket in the hopper, with the session already working on it if there is one. */
export interface HopperTicket extends JiraTicket {
  /** Live crate for this ticket (on the floor); the hopper hides these by default. */
  liveCrateId?: string;
  /** Most recent archived crate for this ticket, offered for Resume. */
  archivedCrateId?: string;
}

/** What the server pushes to the page over /ws. */
export type ServerMessage = { type: 'state'; state: FactoryState };

/** What the page sends over /ws/term/:slot: keystrokes ('i'), or the terminal's new size ('r'). */
export type TermFrame = { t: 'i'; d: string } | { t: 'r'; c: number; r: number };

/** Request bodies the page sends to the API (the server still treats them as untrusted), and the replies. */
export interface RenameRequest {
  name: string;
}
export interface ArchiveRequest {
  endSession?: boolean;
}
export interface LabelArchiveRequest {
  label: string;
}
export interface NewSessionRequest {
  label?: string;
  prompt?: string;
}
/** A factory terminal started for a crate (new session, continue, Jira start). */
export interface StartedReply {
  crateId: string;
  slot: string;
}
export interface ResumeReply {
  slot?: string;
}
export interface LabelArchiveReply {
  archived: number;
}
export interface ImportReply {
  added: number;
  scanned: number;
}
export interface HopperReply {
  tickets: HopperTicket[];
}
