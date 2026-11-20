/** Where a crate sits on the factory floor. */
export type Zone = 'intake' | 'working' | 'alert' | 'dock' | 'storage';

/** Where the server puts a crate. The page only animates crates into their placements; it never chooses one. */
export type PlacementArea = 'intake' | 'working' | 'dock' | 'storage' | 'warehouse';

/** How many spots each area has. Extra crates pile on the area's last spot. */
export const CAPACITY: Record<PlacementArea, number> = { intake: 1, working: 10, dock: 5, storage: 6, warehouse: 96 };

export interface Placement {
  area: PlacementArea;
  /** Spot in the area: assembler, queue position (0 = front of the dock/intake), storage spot, warehouse spot. */
  slot: number;
  /** Place in the spot's pile, 0 = top (the crate put there last). */
  rank: number;
  /** How many crates share the spot. */
  pileSize: number;
  /** When the server put the crate on this spot: keeps spots sticky and orders piles. */
  since: number;
}

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
  /** Where the server has placed the crate (see placement.ts); the page animates it there. */
  placement?: Placement;
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
