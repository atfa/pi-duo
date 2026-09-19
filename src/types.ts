export type AgentId = "austin" | "tony";
export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";
export type WritePolicy = "austin-only" | "transferable";

export type CollaborationPhase =
  | "explore"
  | "converge"
  | "execute"
  | "verify"
  | "complete";

export type PeerMessageKind =
  | "proposal"
  | "evidence"
  | "objection"
  | "checkpoint"
  | "idea"
  | "question"
  | "decision"
  | "finding"
  | "verification";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface DuoConfig {
  agentA?: ModelRef;
  agentB?: ModelRef;
  maxPeerMessagesPerTurn: number;
  maxDeferredMessagesPerTurn: number;
  maxConsecutivePeerTurns: number;
  similarityThreshold: number;
  autoDispatch: boolean;
  writePolicy: WritePolicy;
}

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
  owner?: AgentId;
  updatedAt: string;
}

export interface Decision {
  id: number;
  text: string;
  evidence?: string;
  author: AgentId;
  createdAt: string;
}

export interface DuoAgentState {
  name: "Austin" | "Tony";
  provider?: string;
  modelId?: string;
  sessionId?: string;
  sessionFile?: string;
}

export interface DuoReviewState {
  userTurn: number;
  status: "pending" | "reported" | "failed";
  startedAt?: string;
  updatedAt: string;
  summary?: string;
  error?: string;
}

export interface DuoCollaborationState {
  userTurn: number;
  phase: CollaborationPhase;
  austinContributed: boolean;
  tonyContributed: boolean;
  tonyInitialContribution: boolean;
  contested: boolean;
  planRevision: number;
  plan?: string;
  unresolvedObjection?: string;
  degraded?: boolean;
}

export interface DuoState {
  version: 1;
  revision: number;
  /** Durable audit sequence. Optional only for states created before v0.1.0 migration. */
  userTurn?: number;
  sessionId: string;
  goal: string;
  todo: TodoItem[];
  decisions: Decision[];
  agents: { austin: DuoAgentState; tony: DuoAgentState };
  status: "active" | "stopped";
  workspaceOwner: AgentId | null;
  collaboration?: DuoCollaborationState;
  review?: DuoReviewState;
  peerMessageCount: number;
  /** Durable counts of messages sent across the Austin ↔ Tony control plane. */
  austinPeerMessageCount: number;
  tonyPeerMessageCount: number;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface PeerMessage {
  id: string;
  from: AgentId;
  to: AgentId;
  content: string;
  importance: "normal" | "important" | "decision";
  kind?: PeerMessageKind;
  deferred?: boolean;
  timestamp: string;
  userTurn: number;
}

