import type { AgentId, DuoConfig } from "./types.js";
import { DuoStore, textSimilarity } from "./store.js";

export type TriggerDelivery =
  | { triggerTurn: true }
  | { triggerTurn: true; deliverAs: "followUp" };

/** Idle sessions must not use nextTurn: Pi queues it without starting an agent turn. */
export function triggeringDelivery(isStreaming: boolean): TriggerDelivery {
  return isStreaming
    ? { triggerTurn: true, deliverAs: "followUp" }
    : { triggerTurn: true };
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
      const mayPersist = importance !== "normal" && this.deferredThisTurn === 0;
      return {
        reason: mayPersist
          ? `Peer-message budget exhausted (${config.maxPeerMessagesPerTurn} this user turn).`
          : `Peer-message budget exhausted (${config.maxPeerMessagesPerTurn} this user turn); the context-only overflow slot is unavailable. Continue independently or wait for the user.`,
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
