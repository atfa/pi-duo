export type AgentId = "austin" | "tony";
export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface DuoConfig {
  agentA?: ModelRef;
  agentB?: ModelRef;
  maxPeerMessagesPerTurn: number;
  maxConsecutivePeerTurns: number;
  similarityThreshold: number;
  autoDispatch: boolean;
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

export interface DuoState {
  version: 1;
  revision: number;
  sessionId: string;
  goal: string;
  todo: TodoItem[];
  decisions: Decision[];
  agents: { austin: DuoAgentState; tony: DuoAgentState };
  status: "active" | "stopped";
  workspaceOwner: AgentId | null;
  peerMessageCount: number;
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
  deferred?: boolean;
  timestamp: string;
  userTurn: number;
}
