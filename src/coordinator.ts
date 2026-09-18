import type { AgentId, DuoConfig, WritePolicy } from "./types.js";
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

export type WorkspaceAction = "status" | "acquire" | "release" | "transfer";

export function roleDescription(actor: AgentId): string {
  return actor === "austin"
    ? "Austin (foreground agent; not Tony)"
    : "Tony (background peer; not Austin)";
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

export interface LoopGuardBlock {
  reason: string;
  persistWithoutTurn: boolean;
}

export class LoopGuard {
  private userTurn = 0;
  private sentThisTurn = 0;
  private deferredThisTurn = 0;
  private consecutivePeerTurns = 0;

  beginUserTurn(): number {
    this.userTurn += 1;
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
