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

export class LoopGuard {
  private userTurn = 0;
  private sentThisTurn = 0;
  private consecutivePeerTurns = 0;

  beginUserTurn(): number {
    this.userTurn += 1;
    this.sentThisTurn = 0;
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
  ): Promise<string | undefined> {
    if (this.sentThisTurn >= config.maxPeerMessagesPerTurn) {
      return `Peer-message budget exhausted (${config.maxPeerMessagesPerTurn} this user turn). Continue independently or wait for the user.`;
    }
    if (this.consecutivePeerTurns >= config.maxConsecutivePeerTurns) {
      return `Peer-only chain stopped (${config.maxConsecutivePeerTurns} consecutive messages without material tool activity). Run an experiment or stop.`;
    }
    const recent = await store.recentMessages(12);
    const duplicate = recent
      .filter((message) => message.from === from)
      .some(
        (message) =>
          textSimilarity(message.content, content) >=
          config.similarityThreshold,
      );
    if (duplicate)
      return "Suppressed as substantially similar to a recent message from this agent.";
    return undefined;
  }

  recordPeerMessage(): void {
    this.sentThisTurn += 1;
    this.consecutivePeerTurns += 1;
  }
}
