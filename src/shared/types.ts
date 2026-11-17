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
