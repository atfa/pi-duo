import type {
  AgentId,
  DuoCollaborationState,
  DuoConfig,
  DuoState,
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

export function workspaceMutationBlockReason(
  actor: AgentId,
  collaboration?: DuoCollaborationState,
): string | undefined {
  if (actor !== "austin" || !collaboration) {
    return undefined;
  }

  if (collaboration.degraded) {
    return undefined;
  }

  switch (collaboration.phase) {
    case "explore":
      if (!collaboration.tonyInitialContribution) {
        return (
          "First Collaboration Barrier: Austin must wait for Tony's " +
          "initial independent contribution before modifying project files."
        );
      }

      return (
        "Collaboration is still in EXPLORE. Austin must contribute to " +
        "the shared approach and reach CONVERGE before implementation."
      );

    case "converge":
      return (
        'Collaboration is in CONVERGE. Commit the shared working plan ' +
        'with duo_plan(action="commit") before modifying project files.'
      );

    case "execute":
      return undefined;

    case "verify":
      return (
        "The deliverable is currently under independent verification. " +
        "Project files must not change while Tony is verifying it."
      );

    case "complete":
      return (
        'The verified deliverable is COMPLETE. Use ' +
        'duo_checkpoint(action="reopen") before modifying project files.'
      );
  }
}

export function collaborationReadyToConverge(
  collaboration?: DuoCollaborationState,
): boolean {
  if (!collaboration) return false;
  if (collaboration.degraded) return true;
  return (
    collaboration.austinContributed &&
    collaboration.tonyContributed &&
    collaboration.tonyInitialContribution
  );
}

export function validatePlanCommit(
  actor: AgentId,
  collaboration?: DuoCollaborationState,
): string | undefined {
  if (actor !== "austin") {
    return "Only Austin, as the foreground integrator, may commit the shared working plan.";
  }
  if (!collaboration) {
    return "No active collaboration state.";
  }
  if (collaboration.degraded) {
    if (
      collaboration.phase === "explore" ||
      collaboration.phase === "converge"
    ) {
      return undefined;
    }
  }
  if (collaboration.phase !== "converge") {
    return `Plan commit requires CONVERGE phase; current phase is ${collaboration.phase.toUpperCase()}.`;
  }
  if (!collaboration.austinContributed) {
    return "Austin has not contributed to the working agreement yet.";
  }
  if (
    !collaboration.tonyContributed ||
    !collaboration.tonyInitialContribution
  ) {
    return "Tony has not provided the required independent contribution yet.";
  }
  return undefined;
}

export function validateReadyForVerification(
  actor: AgentId,
  collaboration?: DuoCollaborationState,
): string | undefined {
  if (actor !== "austin") {
    return "Only Austin may declare the integrated deliverable ready for verification.";
  }
  if (!collaboration) {
    return "No active collaboration state.";
  }
  if (collaboration.phase !== "execute") {
    return `ready_for_verification requires EXECUTE phase; current phase is ${collaboration.phase.toUpperCase()}.`;
  }
  return undefined;
}

export function validateManualCompletion(
  actor: AgentId,
  collaboration?: DuoCollaborationState,
  reviewStatus?: "pending" | "reported" | "failed",
): string | undefined {
  if (actor !== "austin") {
    return "Only Austin may manually finalize the deliverable.";
  }
  if (!collaboration) {
    return "No active collaboration state.";
  }
  if (collaboration.phase === "complete") {
    return undefined;
  }
  if (collaboration.phase !== "verify") {
    return `Manual completion requires VERIFY phase; current phase is ${collaboration.phase.toUpperCase()}.`;
  }
  if (reviewStatus !== "reported") {
    return "Manual completion requires a reported Tony verification.";
  }
  return undefined;
}

export function validateReopen(
  actor: AgentId,
  collaboration?: DuoCollaborationState,
): string | undefined {
  if (actor !== "austin") {
    return "Only Austin may reopen the integrated deliverable.";
  }
  if (!collaboration) {
    return "No active collaboration state.";
  }
  if (
    collaboration.phase !== "verify" &&
    collaboration.phase !== "complete"
  ) {
    return `reopen requires VERIFY or COMPLETE phase; current phase is ${collaboration.phase.toUpperCase()}.`;
  }
  return undefined;
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


export function tonyShouldYieldAfterSend(response: string): boolean {
  return (
    response.startsWith("Message delivered") ||
    response.startsWith("High-priority message saved")
  );
}

export function applyReviewReported(
  draft: DuoState,
  userTurn: number,
): boolean {
  if (
    draft.review?.status !== "pending" ||
    draft.review.userTurn !== userTurn ||
    draft.collaboration?.phase !== "verify"
  ) {
    return false;
  }
  draft.review.status = "reported";
  draft.review.updatedAt = new Date().toISOString();
  delete draft.review.error;
  if (draft.collaboration) {
    draft.collaboration.phase = "complete";
  }
  return true;
}

export function applyReviewFinding(draft: DuoState): boolean {
  if (
    draft.collaboration?.phase === "verify" &&
    draft.review?.status === "pending"
  ) {
    draft.collaboration.phase = "execute";
    delete draft.review;
    return true;
  }
  return false;
}

export async function degradeCollaborationTurn(
  store: DuoStore,
  userTurn: number,
): Promise<boolean> {
  const current = await store.readState();

  if (
    !current?.collaboration ||
    current.collaboration.userTurn !== userTurn
  ) {
    return false;
  }

  try {
    await store.update((draft) => {
      if (draft.collaboration?.userTurn === userTurn) {
        draft.collaboration.degraded = true;
        draft.collaboration.tonyInitialContribution = true;
      }
    }, current.revision);

    return true;
  } catch {
    return false;
  }
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
