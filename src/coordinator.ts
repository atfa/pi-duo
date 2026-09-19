import type {
  AgentId,
  DuoCollaborationState,
  DuoConfig,
  PeerMessageKind,
  WritePolicy,
} from "./types.js";
import { DuoStore, textSimilarity } from "./store.js";

export type TriggerDelivery =
  | { triggerTurn: true }
  | { triggerTurn: true; deliverAs: "followUp" };

export type ControlPlaneDelivery =
  | { triggerTurn: true }
  | { triggerTurn: true; deliverAs: "steer" };

/** Idle sessions must not use nextTurn: Pi queues it without starting an agent turn. */
export function triggeringDelivery(isStreaming: boolean): TriggerDelivery {
  return isStreaming
    ? { triggerTurn: true, deliverAs: "followUp" }
    : { triggerTurn: true };
}

export function dispatchControlPlaneTask(
  task: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  try {
    void task().catch(onError);
  } catch (error) {
    onError(error);
  }
}

/** Control-plane handoffs must wake an idle peer and interrupt a streaming peer. */
export function controlPlaneDelivery(
  isStreaming: boolean,
): ControlPlaneDelivery {
  return isStreaming
    ? { triggerTurn: true, deliverAs: "steer" }
    : { triggerTurn: true };
}

export function shouldInspectPeerOutcome(wasStreaming: boolean): boolean {
  // A steer has only been accepted into the active turn. It has not produced
  // a completed outcome yet, so inspecting it here can create a false empty
  // response failure.
  return !wasStreaming;
}

export type WorkspaceAction = "status" | "acquire" | "release" | "transfer";

export function roleDescription(actor: AgentId): string {
  return actor === "austin"
    ? "Austin (foreground agent; not Tony)"
    : "Tony (background peer; not Austin)";
}

export function formatKindPrefix(kind?: PeerMessageKind): string {
  switch (kind) {
    case "proposal":
    case "idea":
      return "💡 Proposal";
    case "evidence":
      return "🔬 Evidence";
    case "objection":
      return "⚠️ Objection";
    case "checkpoint":
      return "🏁 Checkpoint";
    case "verification":
      return "✅ Verification";
    case "finding":
      return "🔍 Finding";
    case "question":
      return "❓ Question";
    case "decision":
      return "📋 Decision";
    default:
      return "";
  }
}

export function isBlockedByFirstSyncBarrier(
  actor: AgentId,
  collaboration?: DuoCollaborationState,
): boolean {
  if (actor !== "austin") return false;
  if (!collaboration) return false;
  if (collaboration.degraded) return false;
  return (
    collaboration.phase === "explore" &&
    !collaboration.tonyInitialContribution
  );
}

export function parseAgentTarget(value: string | undefined): AgentId | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "austin" || normalized === "tony"
    ? normalized
    : undefined;
}

export function canMutateWorkspace(
  policy: WritePolicy,
  actor: AgentId,
  workspaceOwner: AgentId | null,
): boolean {
  return policy === "austin-only"
    ? actor === "austin"
    : workspaceOwner === actor;
}

export function canUseWorkspaceAction(
  policy: WritePolicy,
  actor: AgentId,
  action: WorkspaceAction,
): boolean {
  if (policy === "transferable" || action === "status") return true;
  return actor === "austin" && action === "acquire";
}

export function workspaceHandoffRecipient(
  actor: AgentId,
  action: "release" | "transfer",
  workspaceOwner: AgentId | null,
): AgentId | undefined {
  const peer = actor === "austin" ? "tony" : "austin";
  if (action === "release") return peer;
  return workspaceOwner === peer ? peer : undefined;
}

export function openCompletionTodoIds(state: {
  todo: Array<{
    id: number;
    status: "pending" | "in_progress" | "done" | "blocked";
    owner?: AgentId;
  }>;
}): number[] {
  return state.todo
    .filter(
      (item) =>
        (item.status === "pending" || item.status === "in_progress"),
    )
    .map((item) => item.id);
}

export function completionGateNotice(state: {
  collaboration?: { phase: string };
  review?: { status: "pending" | "reported" | "failed" };
  todo: Array<{
    id: number;
    status: "pending" | "in_progress" | "done" | "blocked";
    owner?: AgentId;
  }>;
}): string | undefined {
  if (state.collaboration) {
    if (
      state.collaboration.phase === "verify" &&
      state.review?.status === "pending"
    ) {
      return "Duo review pending: this is a preliminary Austin result, not the final reviewed outcome. Tony is independently verifying the deliverable.";
    }
  } else if (state.review?.status === "pending") {
    return "Duo review pending: this is a preliminary Austin result, not the final reviewed outcome. Tony is still working and will wake Austin when the first review report is ready.";
  }
  const ids = openCompletionTodoIds(state);
  if (ids.length) {
    return `Duo completion pending: shared todo ${ids.map((id) => `#${id}`).join(", ")} still need reconciliation before the result is final.`;
  }
  return undefined;
}


export function canCompleteReview(
  actor: AgentId,
  explicitlyComplete: boolean | undefined,
  status: "pending" | "reported" | "failed" | undefined,
): boolean {
  return actor === "tony" && explicitlyComplete === true && status === "pending";
}

export function reviewBelongsToTurn(
  activeTonyUserTurn: number | undefined,
  reviewUserTurn: number | undefined,
): boolean {
  return (
    activeTonyUserTurn !== undefined &&
    reviewUserTurn !== undefined &&
    activeTonyUserTurn === reviewUserTurn
  );
}

export function blocksDuoRestart(state: {
  status: "active" | "stopped";
  review?: { status: "pending" | "reported" | "failed" };
} | undefined): boolean {
  return state?.status === "active" && state.review?.status === "pending";
}

export function canMutateDuoState(
  status: "active" | "stopped" | undefined,
): boolean {
  return status === "active";
}

export interface LoopGuardBlock {
  reason: string;
  persistWithoutTurn: boolean;
}

export class LoopGuard {
  private userTurn = 0;
  private sentThisTurn = 0;
  private deferredThisTurn = 0;
  private consecutivePeerTurns = 0;

  beginUserTurn(durableTurn?: number): number {
    this.userTurn = durableTurn ?? this.userTurn + 1;
    this.sentThisTurn = 0;
    this.deferredThisTurn = 0;
    this.consecutivePeerTurns = 0;
    return this.userTurn;
  }

  noteMaterialActivity(): void {
    this.consecutivePeerTurns = 0;
  }

  get turn(): number {
    return this.userTurn;
  }

  async check(
    store: DuoStore,
    from: AgentId,
    content: string,
    config: DuoConfig,
    importance: "normal" | "important" | "decision" = "normal",
  ): Promise<LoopGuardBlock | undefined> {
    const recent = await store.recentMessages(12);
    const duplicate = recent
      .filter((message) => message.from === from)
      .some(
        (message) =>
          textSimilarity(message.content, content) >=
          config.similarityThreshold,
      );
    if (duplicate)
      return {
        reason:
          "Suppressed as substantially similar to a recent message from this agent.",
        persistWithoutTurn: false,
      };
    if (this.sentThisTurn >= config.maxPeerMessagesPerTurn) {
      const mayPersist =
        importance !== "normal" &&
        this.deferredThisTurn < config.maxDeferredMessagesPerTurn;
      return {
        reason: mayPersist
          ? `Peer-message budget exhausted (${config.maxPeerMessagesPerTurn} this user turn).`
          : `Peer-message budget exhausted (${config.maxPeerMessagesPerTurn} this user turn); all ${config.maxDeferredMessagesPerTurn} context-only overflow slots are used until the next user input. Continue independently and do not retry this message.`,
        persistWithoutTurn: mayPersist,
      };
    }
    if (this.consecutivePeerTurns >= config.maxConsecutivePeerTurns) {
      return {
        reason: `Peer-only chain stopped (${config.maxConsecutivePeerTurns} consecutive messages without material tool activity). Run an experiment or stop.`,
        persistWithoutTurn: false,
      };
    }
    const reservedImportantSlot = Math.max(
      0,
      config.maxPeerMessagesPerTurn - 1,
    );
    if (importance === "normal" && this.sentThisTurn >= reservedImportantSlot) {
      return {
        reason:
          "Normal peer-message budget exhausted; the final slot is reserved for an important result, blocker, or decision.",
        persistWithoutTurn: false,
      };
    }
    return undefined;
  }

  recordPeerMessage(): void {
    this.sentThisTurn += 1;
    this.consecutivePeerTurns += 1;
  }

  recordDeferredMessage(): void {
    this.deferredThisTurn += 1;
  }
}
