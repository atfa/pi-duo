import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  applyReviewFinding,
  applyReviewReported,
  blocksDuoRestart,
  canCompleteReview,
  canMutateDuoState,
  canMutateWorkspace,
  canUseWorkspaceAction,
  collaborationReadyToConverge,
  controlPlaneDelivery,
  completionGateNotice,
  degradeCollaborationTurn,
  dispatchControlPlaneTask,
  formatKindPrefix,
  isBlockedByFirstSyncBarrier,
  LoopGuard,
  openCompletionTodoIds,
  parseAgentTarget,
  reviewBelongsToTurn,
  roleDescription,
  shouldInspectPeerOutcome,
  tonyShouldYieldAfterSend,
  triggeringDelivery,
  validateManualCompletion,
  validatePlanCommit,
  validateReadyForVerification,
  validateReopen,
  workspaceHandoffRecipient,
  workspaceMutationBlockReason,
} from "./src/coordinator.js";
import {
  DuoStore,
  formatSharedContext,
  isMutatingShell,
  isWaitingShell,
  MIN_PEER_MESSAGES_PER_TURN,
  otherAgent,
  parseModelRef,
} from "./src/store.js";
import type {
  AgentId,
  CollaborationPhase,
  DuoCollaborationState,
  DuoConfig,
  DuoState,
  ModelRef,
  PeerMessage,
  PeerMessageKind,
  TodoStatus,
} from "./src/types.js";
import { DuoTranscript, type LiveToolState } from "./src/workbench.js";

const BASE_POLICY = `## Duo collaboration policy
You are one of two peer coding agents collaborating on the same goal. Your peer is an independent reasoning agent, not your subordinate.
Do not agree automatically. Challenge weak assumptions with code inspection, discriminating tests, or evidence.
Share important discoveries, evidence, and proposals. Avoid empty acknowledgements. If duo_send reports that a message was saved without triggering a turn, do not resend it; the peer will see it in persistent context later.
Never run sleep commands or poll while waiting for the peer. Send your current work or thoughts with duo_send and end the turn.
For consequential architecture changes, align with your peer. Use duo_send selectively; the peer has an independent persistent context.`;

/**
 * The concrete TUI handed to an extension overlay factory by
 * `ExtensionUIContext.custom()`.
 *
 * pi 0.86+ removed `showOverlay`, `requestRender` and `terminal` from
 * `ExtensionUIContext` itself; they are reachable only through the `tui`
 * argument the `custom()` factory receives. This structural type documents
 * exactly what the workbench relies on, so the workbench never has to guess
 * at the host's shape.
 */
interface OverlayHost {
  requestRender(force?: boolean): void;
  terminal?: { rows?: number; columns?: number };
}

function cooperationPolicy(config: DuoConfig, actor: AgentId): string {
  const identityPolicy =
    actor === "austin"
      ? `## Austin role identity (Foreground Driver & Integrator)
You are Austin, the foreground agent and primary integrator. Tony is your background peer collaborator.
- In the EXPLORE phase, independently analyze the user's task. Do not edit project files immediately; wait for Tony's initial perspective or exchange ideas.
- In the CONVERGE phase, align on a working plan using duo_plan or duo_todo. You may disagree and proceed when justified.
- In the EXECUTE phase, implement changes while Tony conducts tests, investigates edge cases, and provides empirical evidence.
- When the deliverable is ready, declare it using duo_checkpoint(action="ready_for_verification") to initiate Tony's independent verification.
- Before your final user-facing answer, reconcile the shared duo_todo list: mark completed work done and leave genuinely unfinished work pending or blocked.`
      : `## Tony role identity (Background Collaborator & Verifier)
You are Tony, the background peer collaborator. Austin is the foreground agent.
- In the EXPLORE phase, independently analyze the task before relying on Austin's conclusions. Inspect code, logs, and constraints. Share your view with duo_send(kind='proposal' | 'evidence' | 'objection').
- In the CONVERGE phase, collaborate on the solution approach, challenge assumptions, or propose concrete steps.
- In the EXECUTE phase, design tests, reproduce issues, analyze logs, and supply empirical evidence to Austin.
- In the VERIFY phase (triggered after Austin calls duo_checkpoint), independently inspect the changed code, run verification tests, and report findings or confirm completion.
- After any duo_send, end your turn immediately; the control plane will block further tools until Austin sends new work.
- In the VERIFY phase, use reviewFinding=true for actionable defects while keeping review pending; use reviewComplete=true when verification succeeds.
- Never identify yourself as Austin or spend a peer message asking to confirm identities.`;
  const workspacePolicy =
    config.writePolicy === "austin-only"
      ? `## Austin-only write policy
Austin is the sole writer of project files during implementation. Tony should focus on independent investigation, test design, counterexamples, and verification. Tony may use write/edit only inside .pi-duo/tmp/tony for disposable test harnesses; run them with read-only shell commands and leave project files untouched. Austin implements changes and requests Tony's verification via duo_checkpoint. Shared .pi-duo state and Tony's own session persistence are exempt from this project-file policy.`
      : `## Transferable write policy
Workspace ownership may move between Austin and Tony. A release or transfer wakes the peer in either direction; do not spend another peer message merely repeating that handoff.`;
  return `${BASE_POLICY}\n\n${identityPolicy}\n\n${workspacePolicy}`;
}

const SendSchema = Type.Object({
  message: Type.String({
    minLength: 1,
    description: "Concise, materially useful message to the peer",
  }),
  importance: Type.Optional(
    Type.Union([
      Type.Literal("normal"),
      Type.Literal("important"),
      Type.Literal("decision"),
    ]),
  ),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("proposal"),
      Type.Literal("evidence"),
      Type.Literal("objection"),
      Type.Literal("checkpoint"),
      Type.Literal("idea"),
      Type.Literal("question"),
      Type.Literal("decision"),
      Type.Literal("finding"),
      Type.Literal("verification"),
    ]),
  ),
  reviewComplete: Type.Optional(
    Type.Boolean({
      description:
        "Tony only: mark this consolidated report as the completed independent review of the current deliverable",
    }),
  ),
  reviewFinding: Type.Optional(
    Type.Boolean({
      description:
        "Tony only: send one consolidated actionable review report that must wake Austin while leaving the review pending",
    }),
  ),
});
const PlanSchema = Type.Object({
  action: Type.Union([
    Type.Literal("get"),
    Type.Literal("propose"),
    Type.Literal("revise"),
    Type.Literal("commit"),
  ]),
  plan: Type.Optional(Type.String({ description: "Working agreement plan" })),
  unresolvedObjection: Type.Optional(
    Type.String({ description: "Recorded objection if agreeing to disagree" }),
  ),
  expectedRevision: Type.Optional(Type.Number()),
});
const CheckpointSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("ready_for_verification"),
    Type.Literal("complete"),
    Type.Literal("reopen"),
  ]),
  summary: Type.Optional(
    Type.String({ description: "Summary of changes or verification result" }),
  ),
});
const GoalSchema = Type.Object({
  action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
  goal: Type.Optional(Type.String()),
  expectedRevision: Type.Optional(Type.Number()),
});
const TodoSchema = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("add"),
    Type.Literal("update"),
    Type.Literal("remove"),
  ]),
  id: Type.Optional(Type.Number()),
  text: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("done"),
      Type.Literal("blocked"),
    ]),
  ),
  owner: Type.Optional(
    Type.Union([Type.Literal("austin"), Type.Literal("tony")]),
  ),
  expectedRevision: Type.Optional(Type.Number()),
});
const DecisionSchema = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("add")]),
  text: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
  expectedRevision: Type.Optional(Type.Number()),
});
const WorkspaceSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("acquire"),
    Type.Literal("release"),
    Type.Literal("transfer"),
  ]),
  to: Type.Optional(Type.Union([Type.Literal("austin"), Type.Literal("tony")])),
});
const EmptySchema = Type.Object({});

function result(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function agentName(id: AgentId): "Austin" | "Tony" {
  return id === "austin" ? "Austin" : "Tony";
}

function modelText(ref: ModelRef | undefined): string {
  return ref ? `${ref.provider}/${ref.modelId}` : "not configured";
}

function stateModel(state: DuoState, actor: AgentId): ModelRef | undefined {
  const value = state.agents[actor];
  return value.provider && value.modelId
    ? { provider: value.provider, modelId: value.modelId }
    : undefined;
}

async function enforceWritePolicy(
  store: DuoStore,
  config: DuoConfig,
): Promise<DuoState | undefined> {
  return store.enforceWritePolicy(config);
}

function renderStatus(
  state: DuoState,
  config: DuoConfig,
  actor: AgentId,
): string {
  const counts = { pending: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const item of state.todo) counts[item.status]++;
  const lines = [
    `Duo: ${state.status} (revision ${state.revision})`,
    `Current role: ${roleDescription(actor)}`,
  ];
  if (state.collaboration) {
    lines.push(`Phase: ${state.collaboration.phase.toUpperCase()}`);
    if (state.collaboration.plan) {
      lines.push(
        `Plan (rev ${state.collaboration.planRevision}): ${state.collaboration.plan}`,
      );
    }
    if (state.collaboration.unresolvedObjection) {
      lines.push(
        `Unresolved objection: ${state.collaboration.unresolvedObjection}`,
      );
    }
  }
  lines.push(
    `Goal: ${state.goal || "(not set)"}`,
    `Todo: ${counts.done}/${state.todo.length} done, ${counts.in_progress} active, ${counts.blocked} blocked`,
    `Austin: ${modelText(stateModel(state, "austin"))} · session ${state.agents.austin.sessionId?.slice(0, 8) ?? "?"}`,
    `Tony: ${modelText(stateModel(state, "tony"))} · session ${state.agents.tony.sessionId?.slice(0, 8) ?? "?"}`,
    `Write policy: ${config.writePolicy}`,
    `Workspace write owner: ${state.workspaceOwner ? agentName(state.workspaceOwner) : "none"}`,
    `Tony review: ${state.review ? `${state.review.status} (user turn ${state.review.userTurn})` : "not started"}`,
    `Peer messages: ${state.peerMessageCount} total · Austin → Tony ${state.austinPeerMessageCount ?? 0} · Tony → Austin ${state.tonyPeerMessageCount ?? 0}`,
    `Last activity: ${state.lastActivityAt}`,
  );
  return lines.join("\n");
}


function latestAssistantOutcome(
  session: AgentSession,
): { text: string; error?: string } | undefined {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index];
    if (message?.role !== "assistant" || !Array.isArray(message.content))
      continue;
    const text: string[] = [];
    for (const part of message.content) {
      if (part.type === "text") text.push(part.text);
    }
    const error =
      message.stopReason === "error"
        ? message.errorMessage || "Tony's model returned an unspecified error"
        : undefined;
    return { text: text.join("\n").trim(), error };
  }
  return undefined;
}

function parseFlag(args: string, name: string): string | undefined {
  const marker = `--${name}`;
  let offset = 0;
  while (offset < args.length) {
    const index = args.indexOf(marker, offset);
    if (index < 0) return undefined;
    const before = index === 0 ? " " : args[index - 1];
    const after = args[index + marker.length];
    if (
      /\s/.test(before) &&
      (after === "=" || after === undefined || /\s/.test(after))
    ) {
      let value = args.slice(index + marker.length);
      if (value.startsWith("=")) value = value.slice(1);
      value = value.trimStart();
      if (!value) return undefined;
      const quote = value[0];
      if (quote === '"' || quote === "'") {
        const end = value.indexOf(quote, 1);
        return end < 0 ? value.slice(1) : value.slice(1, end);
      }
      return value.split(/\s/, 1)[0];
    }
    offset = index + marker.length;
  }
  return undefined;
}

export default function piDuo(pi: ExtensionAPI) {
  const guard = new LoopGuard();
  let store: DuoStore | undefined;
  let config: DuoConfig | undefined;
  let tony: AgentSession | undefined;
  let tonyUnsubscribe: (() => void) | undefined;
  let tonyQueue: Promise<void> = Promise.resolve();
  let tonySentSequence = 0;
  let tonyMustYield = false;
  let activeTonyUserTurn: number | undefined;
  let completionReconcileTurn = -1;
  let extensionActive = true;
  let lifecycleGeneration = 0;
  let foregroundUI: ExtensionUIContext | undefined;
  // An active Duo belongs to one concrete foreground Austin session. Merely
  // opening another Pi session in the same cwd must not enable Duo behavior.
  let foregroundDuoActive = false;
  let reviewIndicatorPhase:
    | "collaborating"
    | "working"
    | "waiting"
    | "complete"
    | "failed"
    | "collaboration-failed"
    | "clear" = "clear";
  let reviewIndicatorDetail = "";
  let reviewIndicatorStartedAt = 0;
  let austinPeerMessages = 0;
  let tonyPeerMessages = 0;
  // Live message references supplement each session's persisted transcript.
  let austinSessionManager: any;
  let austinStreaming: any;
  let tonyStreaming: any;
  // Pi emits extension message events before SessionManager appends them.
  // Keep those references just long enough for the transcript to bridge that
  // gap; persisted entries evict themselves on the next redraw.
  const austinCapturedMessages: any[] = [];
  const tonyCapturedMessages: any[] = [];
  let workbenchCwd = process.cwd();
  const austinTools = new Map<string, LiveToolState>();
  const tonyTools = new Map<string, LiveToolState>();
  // Active duo workbench panel (set while the panel is shown). The panel is a
  // non-capturing overlay, so the editor keeps keyboard focus.
  let workbenchPanel: DuoTranscript | undefined;
  /**
   * Settles the pending `custom()` promise backing the workbench overlay.
   *
   * This is the single owner of teardown. pi's `custom()` close path for an
   * overlay calls `TUI.hideOverlay()`, which can only pop the *topmost*
   * overlay, so the workbench must always be topmost when this runs. The
   * single-overlay-ownership rule enforced in `showHistory`/`showWorkbench`
   * guarantees that, so `hideOverlay()` removes exactly this overlay and
   * settles the promise in one step.
   */
  let workbenchClose: (() => void) | undefined;
  /**
   * Entry-targeted remover for the workbench overlay, used only on the
   * defensive path when the workbench is somehow not the topmost overlay.
   * `TUI.hideOverlay()` cannot express "remove this one", but the handle
   * returned by `showOverlay` can, because it closes over its own entry.
   */
  let workbenchOverlayHide: (() => void) | undefined;
  let workbenchRequestRender: ((force?: boolean) => void) | undefined;
  // Stream deltas can arrive much faster than a terminal can render. Keep the
  // first event responsive, then coalesce the rest into one trailing redraw.
  let workbenchRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let lastWorkbenchRefreshAt = 0;
  const WORKBENCH_REFRESH_MS = 100;
  const WORKBENCH_MESSAGE_LIMIT = 80;
  const DEFAULT_PANEL_ROWS = 12;
  // Header + header rule + metadata rule + 3 metadata rows + bottom rule.
  const MIN_PANEL_ROWS = 7;
  /**
   * Rows available to the panel: the terminal height minus the space pi needs
   * for the input dock (editor + status + widgets + footer). Falls back to the
   * default budget when terminal metrics are unavailable (e.g. in tests).
   *
   * Why the reserve is derived and not a constant: pi composes the bottom of
   * the screen as a `VStack` dock anchored at the bottom with `basis: "auto"`
   * (`dist/modes/interactive/chat-viewport.js`), so the editor does **not** sit
   * at a fixed offset from the terminal bottom - its top edge moves with the
   * dock's natural height. A fixed reserve therefore cannot be right for more
   * than one terminal size.
   */
  const panelRowBudget = (tui: OverlayHost, reserve: number): number => {
    const rows = tui.terminal?.rows;
    if (!rows || !Number.isFinite(rows)) return DEFAULT_PANEL_ROWS;
    return Math.max(MIN_PANEL_ROWS, Math.floor(rows - reserve));
  };

  const transcriptMessages = (
    session: any,
    streaming: any,
    captured: any[],
  ) => {
    const entries = session?.buildContextEntries?.() ?? session?.getBranch?.() ?? [];
    const historical = entries
      .filter((entry: any) => entry.type === "message")
      .map((entry: any) => entry.message);
    const messages = historical.length
      ? historical
      : session?.messages ?? session?.buildSessionContext?.().messages ?? [];
    const messageKey = (message: any): string => {
      try {
        return JSON.stringify([
          message?.role,
          message?.toolCallId,
          message?.content,
          message?.stopReason,
          message?.isError,
        ]);
      } catch {
        return `${message?.role ?? ""}:${String(message)}`;
      }
    };
    const known = new Set(messages);
    const knownKeys = new Set(messages.map(messageKey));
    const pending = captured.filter((message) =>
      !known.has(message) && !knownKeys.has(messageKey(message))
    );
    captured.splice(0, captured.length, ...pending);
    if (
      streaming &&
      !known.has(streaming) &&
      !knownKeys.has(messageKey(streaming)) &&
      !pending.includes(streaming)
    )
      pending.push(streaming);
    const all = pending.length ? [...messages, ...pending] : messages;
    const unique = all.filter((message: any, index: number, source: any[]) =>
      source.findIndex((candidate: any) => messageKey(candidate) === messageKey(message)) === index
    );
    // The overlay is a live view, not another session history. Bound its
    // component tree; if a cut starts on orphaned tool results, omit those
    // results rather than rendering a misleading unpaired native tool row.
    const recent = unique.slice(-WORKBENCH_MESSAGE_LIMIT);
    const callIds = new Set(
      recent.flatMap((message: any) => message?.role === "assistant"
        ? (Array.isArray(message.content) ? message.content : [])
            .filter((content: any) => content?.type === "toolCall")
            .map((content: any) => content.id)
        : []),
    );
    while (
      recent[0]?.role === "toolResult" &&
      !callIds.has(recent[0].toolCallId)
    ) recent.shift();
    return recent;
  };

  const workbenchFooter = (side: "austin" | "tony"): readonly string[] => {
    const active = reviewIndicatorPhase === "working" || reviewIndicatorPhase === "collaborating";
    const icon = active ? (side === "austin" ? "◐" : "◑") : "·";
    const model = side === "austin"
      ? (config?.agentA ? modelText(config.agentA) : "Austin")
      : (config?.agentB ? modelText(config.agentB) : "Tony");
    const status = active
      ? side === "austin" ? "Austin 正在工作" : "Tony 正在后台协作"
      : side === "austin" ? "Austin 待命" : "Tony 待命";
    return [
      `模型  ${model}`,
      side === "austin"
        ? `交谈  Austin → Tony ${austinPeerMessages}`
        : `交谈  Tony → Austin ${tonyPeerMessages}`,
      `状态  ${icon} ${status}`,
    ];
  };

  /**
   * Rows of the bottom dock the workbench must not paint over.
   *
   * Pi's `max(5, floor(rows * 0.3))` editor value is only a maximum visible
   * line cap. Treating it as the editor's current height left a large uncovered
   * gap where Pi's native Austin transcript showed through beneath the Duo
   * overlay. An empty/single-line editor actually renders three rows: top
   * border, content, bottom border.
   *
   * The dock is `pendingMessages + status + widgetsAbove + editor +
   * widgetsBelow + footer`. We reserve the terms we control or can bound:
   *  - editor: 3 rows (top border + one content row + bottom border);
   *  - footer: 3 rows (pwd row + stats row + optional status row;
   *    `components/footer.js` renders 2-3).
   *
   * Other extensions' widgets/pending messages can still add rows we cannot
   * see, so this remains a best-effort floor; the panel additionally
   * self-truncates to the newest rows.
   */
  const workbenchEditorReserve = (rows: number): number => {
    return EDITOR_ROWS + FOOTER_ROWS + DOCK_SLACK_ROWS;
  };

  const renderReviewIndicator = (force = false) => {
    const ui = foregroundUI;
    if (!ui) return;
    if (reviewIndicatorPhase === "clear") {
      ui.setStatus("pi-duo-review", undefined);
      ui.setWidget("pi-duo-review", undefined, { placement: "belowEditor" });
      return;
    }
    // The native Pi footer remains Austin-only. Duo metadata is rendered in
    // the fixed, split footer inside the two-column workbench.
    ui.setStatus("pi-duo-review", undefined);
    ui.setWidget("pi-duo-review", undefined, { placement: "belowEditor" });
    workbenchPanel?.updateFooters(
      workbenchFooter("austin"),
      workbenchFooter("tony"),
    );
    workbenchRequestRender?.(force);
  };

  const setReviewIndicator = (
    phase:
      | "collaborating"
      | "working"
      | "waiting"
      | "complete"
      | "failed"
      | "collaboration-failed"
      | "clear",
    detail?: string,
  ) => {
    const wasActive =
      reviewIndicatorPhase === "collaborating" ||
      reviewIndicatorPhase === "working" ||
      reviewIndicatorPhase === "waiting";
    reviewIndicatorPhase = phase;
    reviewIndicatorDetail = detail ?? "";
    if (
      (phase === "collaborating" || phase === "working" || phase === "waiting") &&
      !wasActive
    )
      reviewIndicatorStartedAt = Date.now();
    if (phase === "clear") reviewIndicatorStartedAt = 0;
    renderReviewIndicator(phase === "complete");
    if (phase === "complete" && wasActive) {
      foregroundUI?.notify(
        "Duo 协作已完成，可以继续输入。",
        "info",
      );
    }
  };

  const showHistory = async (ctx: ExtensionCommandContext) => {
    if (!foregroundUI || !store || ctx.mode !== "tui") {
      ctx.ui.notify("/duo history requires TUI mode", "error");
      return;
    }
    // Single-overlay ownership. `TUI.hideOverlay()` can only pop the topmost
    // overlay, so pi-duo must never have two of its own overlays stacked at
    // once. Close the workbench first; the history overlay then owns the
    // stack, and its own `done()` removes exactly itself on escape.
    //
    // Remember whether the workbench was actually open so it can be restored
    // afterwards. Closing it without restoring would make `/duo history`
    // silently destroy the dual-column view the user was watching.
    const restoreWorkbench = workbenchPanel !== undefined;
    closeWorkbench();
    const messages = await store.recentMessages(Number.MAX_SAFE_INTEGER);
    await foregroundUI.custom<void>((tui, _theme, _keybindings, done) => {
      let scrollOffset = 0;
      return {
        render(width: number, height?: number) {
          const panelWidth = Math.max(30, width);
          const inner = Math.max(26, panelWidth - 2);
          const bubbleWidth = Math.max(20, Math.floor(inner * 0.58));
          const bodyWidth = Math.max(16, bubbleWidth - 4);
          // TUI columns are wider for CJK characters. Wrapping by JS string
          // length lets Chinese messages cross the frame and clips Tony's
          // right-aligned bubbles. Keep every rendered line within `inner`.
          const displayWidth = (value: string) =>
            [...value].reduce((total, char) =>
              total + (/[,\u1100-\u115f\u2e80-\u303e\u3040-\u30ff\u3130-\u318f\u31a0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1), 0);
          const wrap = (value: string) => {
            const result: string[] = [];
            let line = "";
            let columns = 0;
            for (const char of value) {
              const charWidth = displayWidth(char);
              if (line && columns + charWidth > bodyWidth) {
                result.push(line);
                line = "";
                columns = 0;
              }
              line += char;
              columns += charWidth;
            }
            if (line || !result.length) result.push(line);
            return result;
          };
          const conversation: string[] = [];
          for (const message of messages) {
            const body = wrap(message.content.replace(/\s+/g, " ").trim());
            const fromAustin = message.from === "austin";
            const label = fromAustin ? "Austin" : "Tony";
            const stamp = new Date(message.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            const header = `${label}  ·  ${stamp}`;
            conversation.push(
              (fromAustin ? "  " : " ".repeat(Math.max(2, inner - header.length - 1))) +
                _theme.fg(fromAustin ? "accent" : "success", header),
              ...body.map((line) => {
                const bodyIndent = fromAustin
                  ? "  "
                  : " ".repeat(Math.max(2, inner - bubbleWidth));
                return bodyIndent + _theme.fg("text", `  ${line}`);
              }),
              "",
            );
          }
          // Keep the frame fully visible even on short terminals. More
          // messages remain available through ↑/↓ scrolling.
          // `content` has five fixed lines (title, counters, scroll hint,
          // spacer, footer) and the frame adds two borders. Reserve those
          // rows so the bottom border is always inside the overlay viewport.
          const maxVisible = Math.max(1, (height ?? 40) - 7);
          const maxOffset = Math.max(0, conversation.length - maxVisible);
          scrollOffset = Math.min(scrollOffset, maxOffset);
          const visible = conversation.slice(scrollOffset, scrollOffset + maxVisible);
          const content: string[] = [
            _theme.fg("accent", "Duo history · Austin ↔ Tony"),
            _theme.fg(
              "dim",
              `Austin → Tony ${austinPeerMessages}   Tony → Austin ${tonyPeerMessages}`,
            ),
            _theme.fg(
              "dim",
              `↑/↓ 滚动 · ${maxOffset ? `${scrollOffset + 1}-${Math.min(scrollOffset + maxVisible, conversation.length)}/${conversation.length}` : "全部消息"}`,
            ),
            "",
            ...visible,
            _theme.fg("dim", "ESC 返回 Duo"),
          ];
          const border = _theme.fg("border", `┌${"─".repeat(inner)}┐`);
          const bottom = _theme.fg("border", `└${"─".repeat(inner)}┘`);
          const framed = [border];
          for (const line of content) {
            const plainLine = line.replace(/\x1b\[[0-9;]*m/g, "");
            const plainLength = displayWidth(plainLine);
            // Defensive clipping also protects the frame from unexpected
            // wide glyphs or terminal escape sequences in future messages.
            const safeLine = plainLength > inner
              ? plainLine.slice(0, inner)
              : line;
            framed.push(
              _theme.fg("border", "│") +
                safeLine +
                " ".repeat(Math.max(0, inner - Math.min(inner, plainLength))) +
                _theme.fg("border", "│"),
            );
          }
          framed.push(bottom);
          return framed;
        },
        invalidate() {
          // Static history content needs no cache invalidation.
        },
        handleInput(data: string) {
          if (matchesKey(data, "escape")) {
            done();
            return true;
          }
          if (data === "\u001b[A" || data === "k") {
            scrollOffset = Math.max(0, scrollOffset - 1);
            tui.requestRender();
            return true;
          }
          if (data === "\u001b[B" || data === "j") {
            scrollOffset += 1;
            tui.requestRender();
            return true;
          }
          return true;
        },
      };
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "96%",
        maxHeight: "90%",
      },
    });

    // The awaited `custom()` above only resolves once the history overlay has
    // been dismissed, at which point pi-duo owns no overlays. Re-opening the
    // workbench here therefore cannot stack two pi-duo overlays, so the
    // topmost-pop invariant still holds.
    if (restoreWorkbench && ctx.mode === "tui") {
      await openWorkbench(ctx);
    }
  };

  const isCurrentGeneration = (generation: number) =>
    extensionActive && generation === lifecycleGeneration;

  /**
   * Rows of bottom-screen chrome that the workbench must never paint over.
   * See {@link workbenchEditorReserve} for how they are combined; these are the
   * bounded terms (the editor height is derived from the terminal size).
   */
  /** Pi's empty/single-line editor: top border + content + bottom border. */
  const EDITOR_ROWS = 3;
  /** `components/footer.js` renders a pwd row + stats row + optional status. */
  const FOOTER_ROWS = 3;
  /** Room for transient status/pending rows added by other loaded extensions. */
  const DOCK_SLACK_ROWS = 2;

  /**
   * Shows the dual-column workbench as a **persistent, non-capturing**
   * overlay filling the upper part of the screen.
   *
   * Why an overlay instead of a widget: pi's flexible upper region belongs to
   * its internal `transcript` scroll view and is not replaceable by an
   * extension, while widgets live in the non-growing `dock`. A non-capturing
   * overlay is the only carrier that covers the upper region *and* leaves
   * keyboard focus in the editor, which is the whole point of duo mode.
   *
   * `nonCapturing: true` makes the overlay skip `setFocus`, so the user can
   * keep typing tasks while watching both columns. Unlike a blocking dialog,
   * `openWorkbench` returns immediately, so callers are not blocked.
   *
   * `options.silent` suppresses the "requires TUI mode" notice for the
   * **automatic** open points (`/duo start`, `/duo resume`, `session_start`).
   * A user resuming an active duo in RPC/print mode never asked for this view,
   * so failing to show it must not produce an unsolicited error.
   *
   * Why `custom({ overlay: true })` instead of a direct `showOverlay` call:
   * pi 0.86 removed `showOverlay`/`requestRender`/`terminal` from
   * `ExtensionUIContext`, so the only supported way to install a persistent
   * overlay is through `custom()`. It is reachable with `nonCapturing` so the
   * editor keeps keyboard focus, and it hands back the real TUI (with the
   * terminal row count and `requestRender`) inside the factory.
   *
   * `custom()` only settles when its `done` callback runs, so this function
   * deliberately does **not** await it: `openWorkbench` must return
   * immediately (it runs on the `session_start` / `/duo start` chain).
   */
  const openWorkbench = async (
    ctx?: { cwd?: string; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
    options?: { silent?: boolean },
  ) => {
    const ui = foregroundUI;
    if (!ui || typeof ui.custom !== "function" || !ui.setStatus) {
      if (!options?.silent) {
        ctx?.ui.notify("/duo workbench requires TUI mode", "error");
      }
      return;
    }

    // Re-opening is a no-op: keep the existing panel instance so its cached
    // frame and row budget survive (`/duo view` uses toggleWorkbench instead).
    if (workbenchPanel) return;

    // The overlay's `done` callback and its entry-targeted `hide` are both
    // delivered asynchronously: `done` inside the factory, `onHandle` after the
    // factory resolves. Record them so `closeWorkbench` can tear down safely.
    let settled = false;
    let panelRows = DEFAULT_PANEL_ROWS;
    try {
      void ui
        .custom<void>(
          (tui, _theme, _keybindings, done) => {
            // Row budget comes from the real TUI, which is only reachable here.
            // `ctx.ui` exposes no terminal metrics in pi 0.86.
            const panel = new DuoTranscript(tui, ctx?.cwd ?? process.cwd());
            panelRows = panelRowBudget(
              tui as OverlayHost,
              workbenchEditorReserve((tui as OverlayHost).terminal?.rows ?? DEFAULT_PANEL_ROWS),
            );
            panel.setMaxRows(panelRows);
            workbenchPanel = panel;
            panel.update(
              { label: "Austin", cwd: workbenchCwd, messages: transcriptMessages(austinSessionManager, austinStreaming, austinCapturedMessages), streaming: austinStreaming, tools: austinTools, footer: workbenchFooter("austin") },
              { label: "Tony", cwd: workbenchCwd, messages: transcriptMessages(tony, tonyStreaming, tonyCapturedMessages), streaming: tonyStreaming, tools: tonyTools, footer: workbenchFooter("tony") },
            );
            workbenchClose = () => {
              if (settled) return;
              settled = true;
              done();
            };
            workbenchRequestRender = (force = false) => {
              tui.requestRender(force);
            };
            return panel;
          },
          {
            overlay: true,
            // A function, not a literal: pi resolves these *after* the factory
            // has run, so `panel.rowBudget` already reflects the real terminal
            // height applied by `setMaxRows` inside the factory. Reading it
            // eagerly here would capture the constructor's default instead.
            overlayOptions: () => ({
              // Fill the width and anchor at the very top so the panel occupies
              // the upper display region rather than floating as a centred
              // dialog, while the editor below keeps keyboard focus.
              anchor: "top-left",
              row: 0,
              col: 0,
              width: "100%",
              maxHeight: panelRows,
              nonCapturing: true,
            }),
            onHandle: (handle) => {
              workbenchOverlayHide = () => handle.hide();
            },
          },
        )
        .catch(() => {
          // The host tears overlays down on shutdown, which can reject the
          // pending promise. The workbench is an observability aid, never a
          // hard dependency: degrade silently.
          closeWorkbench();
        });
    } catch {
      // This runs on the `session_start` / `/duo start` await chain. If the
      // terminal is already tearing down, `custom` can throw, and an uncaught
      // throw would abort the remaining startup work.
      closeWorkbench();
      return;
    }

  };

  /**
   * Legacy entry point kept for `/duo workbench`: validates TUI mode and an
   * active session before opening the persistent panel.
   */
  const showWorkbench = async (ctx: ExtensionCommandContext) => {
    if (!foregroundUI || !store || ctx.mode !== "tui") {
      ctx.ui.notify("/duo workbench requires TUI mode", "error");
      return;
    }
    const state = await store.readState();
    if (!state) {
      ctx.ui.notify("No Duo session. Use /duo start.", "warning");
      return;
    }
    if (state.status !== "active") {
      ctx.ui.notify("Duo is stopped. Use /duo resume first.", "warning");
      return;
    }
    await openWorkbench(ctx);
  };

  /** Toggles the workbench panel (`/duo view`). */
  const toggleWorkbench = async (ctx: ExtensionCommandContext) => {
    if (workbenchPanel) {
      closeWorkbench();
      ctx.ui.notify("Duo 工作现场已隐藏（/duo view 重新打开）", "info");
      return;
    }
    await showWorkbench(ctx);
  };

  const refreshWorkbench = (immediate = false) => {
    if (!workbenchPanel || !workbenchRequestRender) return;
    const render = () => {
      workbenchRefreshTimer = undefined;
      if (!workbenchPanel || !workbenchRequestRender) return;
      lastWorkbenchRefreshAt = Date.now();
      workbenchPanel.update(
        { label: "Austin", cwd: workbenchCwd, messages: transcriptMessages(austinSessionManager, austinStreaming, austinCapturedMessages), streaming: austinStreaming, tools: austinTools, footer: workbenchFooter("austin") },
        { label: "Tony", cwd: workbenchCwd, messages: transcriptMessages(tony, tonyStreaming, tonyCapturedMessages), streaming: tonyStreaming, tools: tonyTools, footer: workbenchFooter("tony") },
      );
      workbenchRequestRender();
    };
    if (immediate) {
      if (workbenchRefreshTimer) clearTimeout(workbenchRefreshTimer);
      render();
      return;
    }
    if (workbenchRefreshTimer) return;
    const wait = Math.max(0, WORKBENCH_REFRESH_MS - (Date.now() - lastWorkbenchRefreshAt));
    if (!lastWorkbenchRefreshAt || wait === 0) {
      render();
      return;
    }
    workbenchRefreshTimer = setTimeout(render, wait);
    workbenchRefreshTimer.unref?.();
  };

  /**
   * Removes the workbench overlay and clears its handles.
   *
   * `done()` is the single owner of teardown on the happy path: under the
   * single-overlay-ownership rule (see `showHistory`) the workbench is the only
   * pi-duo overlay on the stack, so pi's `custom()` close path pops exactly
   * this overlay via `TUI.hideOverlay()` and settles the pending promise in one
   * step. The entry-targeted handle is used only when no `done` was ever
   * installed (the factory never ran), so that an overlay which did get pushed
   * cannot be leaked.
   */
  const closeWorkbench = () => {
    if (workbenchRefreshTimer) clearTimeout(workbenchRefreshTimer);
    workbenchRefreshTimer = undefined;
    lastWorkbenchRefreshAt = 0;
    const close = workbenchClose;
    const hideEntry = workbenchOverlayHide;
    workbenchClose = undefined;
    workbenchOverlayHide = undefined;
    workbenchPanel = undefined;
    workbenchRequestRender = undefined;
    if (close) close();
    else hideEntry?.();
  };

  const sendMessageSafely = (
    message: Parameters<ExtensionAPI["sendMessage"]>[0],
    options?: Parameters<ExtensionAPI["sendMessage"]>[1],
    generation = lifecycleGeneration,
  ) => {
    if (!isCurrentGeneration(generation)) return false;
    try {
      pi.sendMessage(message, options);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("extension ctx is stale")
      )
        return false;
      throw error;
    }
  };

  const getStore = (cwd: string) => {
    if (!store || store.dir !== path.join(cwd, ".pi-duo"))
      store = new DuoStore(cwd);
    return store;
  };

  const sendToAustin = async (
    content: string,
    importance: "normal" | "important" | "decision" = "important",
    triggerTurn = false,
    bypassGuard = false,
    kind?: PeerMessageKind,
  ) => {
    const generation = lifecycleGeneration;
    if (!isCurrentGeneration(generation)) return "Duo extension is reloading.";
    if (!store || !config) return "Duo is not initialized";
    const messageUserTurn = activeTonyUserTurn ?? guard.turn;
    const currentState = await store.readState();
    if (
      currentState?.status === "active" &&
      !reviewBelongsToTurn(messageUserTurn, currentState.userTurn)
    )
      return `Stale Tony message for user turn ${messageUserTurn} was discarded; current user turn is ${currentState.userTurn}. End this turn now.`;
    const blocked = bypassGuard
      ? undefined
      : await guard.check(store, "tony", content, config, importance);
    if (!isCurrentGeneration(generation)) return "Duo extension is reloading.";
    const deferred = blocked?.persistWithoutTurn === true;
    if (blocked && !deferred) return blocked.reason;
    if (deferred) guard.recordDeferredMessage();
    else guard.recordPeerMessage();
    tonySentSequence++;
    const message = await store.appendMessage({
      from: "tony",
      to: "austin",
      content,
      importance,
      kind,
      deferred: deferred || undefined,
      userTurn: messageUserTurn,
    });
    tonyPeerMessages++;
    if (!isCurrentGeneration(generation)) return "Duo extension is reloading.";

    await store.update((draft) => {
      if (!draft.collaboration) {
        draft.collaboration = {
          userTurn: messageUserTurn,
          phase: "explore",
          austinContributed: false,
          tonyContributed: true,
          tonyInitialContribution: true,
          tonyRespondedToAustin: false,
          contested: false,
          planRevision: 0,
        };
        return;
      }

      const hadTonyInitialContribution =
        draft.collaboration.tonyInitialContribution;
      draft.collaboration.tonyContributed = true;
      if (
        draft.collaboration.austinContributed &&
        hadTonyInitialContribution
      )
        draft.collaboration.tonyRespondedToAustin = true;
      draft.collaboration.tonyInitialContribution = true;

      if (kind === "objection") {
        draft.collaboration.contested = true;
        draft.collaboration.unresolvedObjection = content.slice(0, 300);
      }

      if (
        draft.collaboration.phase === "explore" &&
        collaborationReadyToConverge(draft.collaboration)
      ) {
        draft.collaboration.phase = "converge";
      }
    });

    let delivery: Parameters<ExtensionAPI["sendMessage"]>[1] = {
      triggerTurn: false,
    };
    if (!deferred && triggerTurn)
      delivery = { triggerTurn: true, deliverAs: "steer" };
    const kindPrefix = formatKindPrefix(kind);
    const prefixStr = kindPrefix ? ` ${kindPrefix}` : "";
    sendMessageSafely(
      {
        customType: "pi-duo-peer",
        content: `[Tony${prefixStr}]${deferred ? " [saved without triggering a turn]" : ""}\n${content}`,
        display: importance !== "normal" || Boolean(kind),
        details: message,
      },
      delivery,
      generation,
    );
    return deferred
      ? `High-priority message saved in Austin's persistent context and audit log without triggering another turn. ${blocked?.reason}`
      : "Message delivered to Austin's persistent session.";
  };

  const sendToTony = async (
    content: string,
    importance: "normal" | "important" | "decision" = "important",
    kind?: PeerMessageKind,
  ) => {
    const generation = lifecycleGeneration;
    if (!isCurrentGeneration(generation)) return "Duo extension is reloading.";
    if (!store || !config || !tony)
      return "Tony is not running. Use /duo resume.";
    const blocked = await guard.check(
      store,
      "austin",
      content,
      config,
      importance,
    );
    if (!isCurrentGeneration(generation)) return "Duo extension is reloading.";
    const deferred = blocked?.persistWithoutTurn === true;
    if (blocked && !deferred) return blocked.reason;
    if (deferred) guard.recordDeferredMessage();
    else guard.recordPeerMessage();
    const message = await store.appendMessage({
      from: "austin",
      to: "tony",
      content,
      importance,
      kind,
      deferred: deferred || undefined,
      userTurn: guard.turn,
    });
    austinPeerMessages++;

    const state = await store.update((draft) => {
      if (!draft.collaboration) {
        draft.collaboration = {
          userTurn: guard.turn,
          phase: "explore",
          austinContributed: true,
          tonyContributed: false,
          tonyInitialContribution: false,
          tonyRespondedToAustin: false,
          contested: false,
          planRevision: 0,
        };
        return;
      }

      draft.collaboration.austinContributed = true;
      if (
        draft.collaboration.phase === "explore" &&
        collaborationReadyToConverge(draft.collaboration)
      ) {
        draft.collaboration.phase = "converge";
      }
    });

    const activeTony = tony;
    const wasStreaming = activeTony.isStreaming;
    let delivery: Parameters<AgentSession["sendCustomMessage"]>[1] = {
      triggerTurn: false,
    };
    if (!deferred) {
      if (wasStreaming) delivery = { triggerTurn: true, deliverAs: "steer" };
      else delivery = triggeringDelivery(false);
    }
    const kindPrefix = formatKindPrefix(kind);
    const prefixStr = kindPrefix ? ` ${kindPrefix}` : "";
    if (deferred) {
      await activeTony.sendCustomMessage(
        {
          customType: "pi-duo-peer",
          content: `[Austin${prefixStr}] [saved without triggering a turn]\n${content}`,
          display: false,
          details: message,
        },
        delivery,
      );
      return `High-priority message saved in Tony's persistent context and audit log without triggering another turn. ${blocked?.reason}`;
    }
    setReviewIndicator(
      state.collaboration?.phase === "verify" ? "working" : "collaborating",
      state.collaboration?.phase === "verify"
        ? "正在检查 Austin 的更新"
        : "正在处理 Austin 的协作消息",
    );
    tonyMustYield = false;
    const sentBefore = tonySentSequence;
    dispatchControlPlaneTask(
      async () => {
        const ownsTurnContext = activeTonyUserTurn === undefined;
        if (ownsTurnContext) activeTonyUserTurn = message.userTurn;
        try {
          await activeTony.sendCustomMessage(
            {
              customType: "pi-duo-peer",
              content: `[Austin${prefixStr}]\n${content}`,
              display: false,
              details: message,
            },
            delivery,
          );
          if (!isCurrentGeneration(generation) || tony !== activeTony) return;
          if (!shouldInspectPeerOutcome(wasStreaming)) return;
          const outcome = latestAssistantOutcome(activeTony);
          if (outcome?.error) {
            const pending = await store?.readState();
            if (
              pending?.review?.status === "pending" &&
              reviewBelongsToTurn(message.userTurn, pending.review.userTurn)
            )
              await markReviewFailed(message.userTurn, outcome.error);
            sendMessageSafely(
              {
                customType: "pi-duo-peer",
                content: `[Tony error]\n${outcome.error}`,
                display: true,
              },
              { triggerTurn: true },
              generation,
            );
            return;
          }

          if (tonySentSequence === sentBefore) {
            const final = outcome?.text.slice(0, 4000) ?? "";
            if (final) {
              await sendToAustin(final, "important", true);
            } else {
              const pending = await store?.readState();
              if (
                pending?.review?.status === "pending" &&
                reviewBelongsToTurn(message.userTurn, pending.review.userTurn)
              ) {
                await markReviewFailed(
                  message.userTurn,
                  "Tony completed a requested review turn with an empty response",
                );
                sendMessageSafely(
                  {
                    customType: "pi-duo-peer",
                    content:
                      "[Tony review unavailable]\nTony's requested review turn ended with an empty model response. Austin must not claim peer verification; disclose the failed review and rely on independent checks.",
                    display: true,
                  },
                  { triggerTurn: true, deliverAs: "steer" },
                  generation,
                );
              }
            }
          }
        } finally {
          if (ownsTurnContext && activeTonyUserTurn === message.userTurn)
            activeTonyUserTurn = undefined;
        }
      },
      (error) => {
        sendMessageSafely(
          {
            customType: "pi-duo-peer",
            content: `[Tony delivery error]\n${error instanceof Error ? error.message : String(error)}`,
            display: true,
          },
          { triggerTurn: true },
          generation,
        );
      },
    );
    return wasStreaming
      ? "Message delivered into Tony's active turn. Delivery is non-blocking; Tony will wake Austin with the result."
      : "Message delivered to Tony. Delivery is non-blocking; Tony will wake Austin with the result.";
  };

  const notifyPeerOfWorkspaceHandoff = async (
    actor: AgentId,
    recipient: AgentId,
    state: DuoState,
    action: "release" | "transfer",
  ): Promise<boolean> => {
    const generation = lifecycleGeneration;
    if (!store || !isCurrentGeneration(generation)) return false;
    const actorName = agentName(actor);
    const recipientName = agentName(recipient);
    let content: string;
    if (action === "release") {
      content = `[Workspace handoff]\n${actorName} released the workspace write lock. ${recipientName} may acquire it and continue.`;
    } else {
      const ownerName = state.workspaceOwner
        ? agentName(state.workspaceOwner)
        : "nobody";
      content = `[Workspace handoff]\n${actorName} transferred the workspace write lock to ${ownerName}. ${recipientName} should continue the pending work now.`;
    }
    // Workspace ownership is a control-plane event and intentionally bypasses LoopGuard.
    let message: Awaited<ReturnType<DuoStore["appendMessage"]>> | undefined;
    try {
      message = await store.appendMessage({
        from: actor,
        to: recipient,
        content,
        importance: "important",
        userTurn: guard.turn,
      });
      if (actor === "austin") austinPeerMessages++;
      else tonyPeerMessages++;
    } catch {
      // A lock handoff must still wake the peer if the audit append fails.
    }
    if (!isCurrentGeneration(generation)) return false;
    if (recipient === "austin") {
      return sendMessageSafely(
        {
          customType: "pi-duo-peer",
          content,
          display: true,
          details: message,
        },
        { triggerTurn: true, deliverAs: "steer" },
        generation,
      );
    }
    const activeTony = tony;
    if (!activeTony) return false;
    tonyMustYield = false;
    const wasStreaming = activeTony.isStreaming;
    dispatchControlPlaneTask(
      async () => {
        await activeTony.sendCustomMessage(
          {
            customType: "pi-duo-peer",
            content,
            display: false,
            details: message,
          },
          controlPlaneDelivery(wasStreaming),
        );
        if (
          wasStreaming ||
          !isCurrentGeneration(generation) ||
          tony !== activeTony
        )
          return;
        const error = latestAssistantOutcome(activeTony)?.error;
        if (!error) return;
        sendMessageSafely(
          {
            customType: "pi-duo-peer",
            content: `[Tony error]\n${error}`,
            display: true,
          },
          { triggerTurn: false },
          generation,
        );
      },
      (error) => {
        sendMessageSafely(
          {
            customType: "pi-duo-peer",
            content: `[Tony handoff error]\n${error instanceof Error ? error.message : String(error)}`,
            display: true,
          },
          { triggerTurn: false },
          generation,
        );
      },
    );
    return true;
  };

  const registerTools = (api: ExtensionAPI, actor: AgentId) => {
    api.registerTool({
      name: "duo_send",
      label: "Duo Send",
      description: `Send a concise, materially useful message to ${agentName(otherAgent(actor))}. This enters the peer's real persistent context.`,
      parameters: SendSchema,
      execute: async (_id, params) => {
        if (actor === "tony" && params.reviewComplete && params.reviewFinding) {
          return result(
            "Choose exactly one review state: reviewFinding for requested changes, or reviewComplete for final sign-off. End this turn now.",
          );
        }
        if (actor === "tony" && params.reviewFinding) {
          if (!store) return result("Duo has not been started");
          const current = await store.readState();
          if (
            current?.review?.status !== "pending" ||
            !reviewBelongsToTurn(
              activeTonyUserTurn,
              current.review.userTurn,
            )
          )
            return result(
              "This Tony turn does not own the current pending review. Its report is stale and was not delivered; end this turn without retrying.",
              current,
            );
          const response = await sendToAustin(
            params.message,
            "decision",
            true,
            true,
            params.kind ?? "finding",
          );
          if (tonyShouldYieldAfterSend(response)) {
            tonyMustYield = true;
          }
          await store.update((draft) => {
            applyReviewFinding(draft);
          });
          setReviewIndicator("waiting", "Tony 发现缺陷，已退回 EXECUTE 阶段");
          sendMessageSafely(
            {
              customType: "pi-duo-peer",
              content:
                "[Tony verification finding]\n" +
                "Verification found actionable defects. The collaboration returned to EXECUTE. " +
                "Fix the reported issues, then call duo_checkpoint(action=\"ready_for_verification\") again for a fresh independent verification.",
              display: true,
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
          return result(
            tonyMustYield
              ? `${response} Verification found actionable defects; collaboration returned to EXECUTE. End this turn now; wait for Austin's fixes.`
              : response,
          );
        }
        if (actor === "tony" && params.reviewComplete) {
          if (!store) return result("Duo has not been started");
          const current = await store.readState();
          if (
            !current?.review ||
            !reviewBelongsToTurn(
              activeTonyUserTurn,
              current.review.userTurn,
            ) ||
            !canCompleteReview(
              actor,
              params.reviewComplete,
              current.review.status,
            )
          )
            return result(
              "No pending Tony review exists. Send ordinary coordination with reviewComplete omitted.",
              current,
            );
          const response = await sendToAustin(
            params.message,
            "decision",
            false,
            true,
            params.kind ?? "verification",
          );
          if (!response.startsWith("Message delivered")) return result(response);
          const reported = await markReviewReported(current.review.userTurn);
          if (!reported)
            return result(
              "Review report was saved, but verification state changed or a newer user turn replaced this review before it could be marked complete.",
            );
          tonyMustYield = true;
          sendMessageSafely(
            {
              customType: "pi-duo-peer",
              content:
                "[Tony review complete]\nTony submitted the explicit independent review report. Austin may now reconcile todos and provide the final reviewed result.",
              display: true,
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
          setReviewIndicator("complete");
          return result(
            "Final review report recorded and Austin was notified. End this turn now.",
          );
        }
        const response =
          actor === "austin"
            ? await sendToTony(
                params.message,
                params.importance ?? "normal",
                params.kind,
              )
            : await sendToAustin(
                params.message,
                params.importance ?? "normal",
                true,
                false,
                params.kind,
              );
        if (actor === "tony" && tonyShouldYieldAfterSend(response)) {
          tonyMustYield = true;
        }
        return result(
          actor === "tony" && tonyMustYield
            ? `${response} End this turn now; wait for Austin's next message.`
            : response,
        );
      },
    });
    api.registerTool({
      name: "duo_plan",
      label: "Duo Plan",
      description:
        "Get, propose, revise, or commit a shared working plan agreement (CONVERGE -> EXECUTE).",
      parameters: PlanSchema,
      execute: async (_id, params) => {
        if (!store) return result("Duo has not been started");
        if (params.action === "get") {
          const state = await store.readState();
          return result(
            state?.collaboration?.plan
              ? `Plan (rev ${state.collaboration.planRevision}): ${state.collaboration.plan}${state.collaboration.unresolvedObjection ? `\nUnresolved objection: ${state.collaboration.unresolvedObjection}` : ""}`
              : "(no plan set)",
            state,
          );
        }
        const planText = params.plan?.trim();
        if (!planText) {
          return result("plan is required for propose, revise, or commit");
        }

        if (params.action === "commit") {
          const current = await store.readState();
          const error = validatePlanCommit(actor, current?.collaboration);
          if (error) {
            return result(error, current);
          }
        }

        const state = await store.update((draft) => {
          if (!draft.collaboration) {
            draft.collaboration = {
              userTurn: guard.turn,
              phase: params.action === "commit" ? "execute" : "explore",
              austinContributed: actor === "austin",
              tonyContributed: actor === "tony",
              tonyInitialContribution: actor === "tony",
              tonyRespondedToAustin: false,
              contested: Boolean(params.unresolvedObjection),
              planRevision: 1,
              plan: planText,
              unresolvedObjection: params.unresolvedObjection,
            };
          } else {
            draft.collaboration.plan = planText;
            draft.collaboration.planRevision += 1;
            if (params.unresolvedObjection !== undefined) {
              draft.collaboration.unresolvedObjection =
                params.unresolvedObjection;
              draft.collaboration.contested = true;
            }
            if (actor === "austin") draft.collaboration.austinContributed = true;
            if (actor === "tony") {
              draft.collaboration.tonyContributed = true;
              draft.collaboration.tonyInitialContribution = true;
            }
            if (params.action === "commit") {
              draft.collaboration.phase = "execute";
            } else if (
              draft.collaboration.phase === "explore" &&
              collaborationReadyToConverge(draft.collaboration)
            ) {
              draft.collaboration.phase = "converge";
            }
          }
        }, params.expectedRevision);
        return result(
          `Plan ${params.action} recorded at revision ${state.revision} (Phase: ${state.collaboration?.phase.toUpperCase()}): ${state.collaboration?.plan}`,
          state,
        );
      },
    });
    api.registerTool({
      name: "duo_checkpoint",
      label: "Duo Checkpoint",
      description:
        "Inspect, declare deliverable ready for independent verification, complete, or reopen.",
      parameters: CheckpointSchema,
      execute: async (_id, params) => {
        if (!store) return result("Duo has not been started");
        const currentState = await store.readState();
        if (!currentState) return result("Duo has not been started");
        if (params.action === "status") {
          return result(
            `Phase: ${currentState.collaboration?.phase ?? "unknown"}, Review: ${currentState.review?.status ?? "none"}`,
            currentState,
          );
        }
        if (params.action === "ready_for_verification") {
          const err = validateReadyForVerification(
            actor,
            currentState.collaboration,
          );
          if (err) return result(err, currentState);
          if (!tony) {
            return result(
              "Tony is unavailable; resume Tony before requesting independent verification.",
              currentState,
            );
          }
          const timestamp = new Date().toISOString();
          const state = await store.update((draft) => {
            if (!draft.collaboration) {
              draft.collaboration = {
                userTurn: guard.turn,
                phase: "verify",
                austinContributed: true,
                tonyContributed: false,
                tonyInitialContribution: true,
                contested: false,
                planRevision: 0,
              };
            } else {
              draft.collaboration.phase = "verify";
            }
            draft.review = {
              userTurn: guard.turn,
              status: "pending",
              summary: params.summary,
              startedAt: timestamp,
              updatedAt: timestamp,
            };
          });
          setReviewIndicator("working", "Tony 独立验证中");
          queueTonyVerificationTask(params.summary, guard.turn);
          return result(
            `Checkpoint reached: deliverable ready for independent verification by Tony (revision ${state.revision})`,
            state,
          );
        }
        if (params.action === "complete") {
          if (currentState.collaboration?.phase === "complete") {
            return result("Collaboration is already complete.", currentState);
          }
          const err = validateManualCompletion(
            actor,
            currentState.collaboration,
            currentState.review?.status,
          );
          if (err) return result(err, currentState);
          const state = await store.update((draft) => {
            if (draft.collaboration) draft.collaboration.phase = "complete";
            if (draft.review) {
              draft.review.status = "reported";
              if (params.summary) draft.review.summary = params.summary;
              draft.review.updatedAt = new Date().toISOString();
            }
          });
          setReviewIndicator("complete");
          return result(
            `Collaboration marked complete (revision ${state.revision})`,
            state,
          );
        }
        if (params.action === "reopen") {
          const err = validateReopen(actor, currentState.collaboration);
          if (err) return result(err, currentState);
          const state = await store.update((draft) => {
            if (draft.collaboration) draft.collaboration.phase = "execute";
            delete draft.review;
          });
          setReviewIndicator("working", "重新打开执行");
          return result(
            `Collaboration reopened into EXECUTE phase (revision ${state.revision})`,
            state,
          );
        }
        return result("Unknown checkpoint action");
      },
    });
    api.registerTool({
      name: "duo_status",
      label: "Duo Status",
      description:
        "Read shared Duo status, goal, models, todo progress, and activity.",
      parameters: EmptySchema,
      execute: async () => {
        if (!store) return result("Duo has not been started");
        const latestConfig = await store.readConfig();
        const state = await enforceWritePolicy(store, latestConfig);
        return result(
          state
            ? renderStatus(state, latestConfig, actor)
            : "Duo has not been started",
          state,
        );
      },
    });
    api.registerTool({
      name: "duo_goal",
      label: "Duo Goal",
      description: "Get or atomically set the durable shared goal.",
      parameters: GoalSchema,
      execute: async (_id, params) => {
        if (!store) return result("Duo has not been started");
        const current = await store.readState();
        if (params.action === "get")
          return result(current?.goal || "(not set)");
        if (!canMutateDuoState(current?.status))
          return result("Duo is stopped; use /duo resume before changing shared state.", current);
        const goal = params.goal?.trim();
        if (!goal) return result("goal is required for set");
        const state = await store.update((draft) => {
          draft.goal = goal;
        }, params.expectedRevision);
        return result(
          `Goal updated at revision ${state.revision}: ${state.goal}`,
          state,
        );
      },
    });
    api.registerTool({
      name: "duo_todo",
      label: "Duo Todo",
      description:
        "List or atomically add/update/remove durable shared todo items.",
      parameters: TodoSchema,
      execute: async (_id, params) => {
        if (!store) return result("Duo has not been started");
        if (params.action === "list") {
          const state = await store.readState();
          return result(
            state?.todo.length
              ? state.todo
                  .map(
                    (t) =>
                      `#${t.id} [${t.status}] ${t.text}${t.owner ? ` (${t.owner})` : ""}`,
                  )
                  .join("\n")
              : "No todo items",
            state,
          );
        }
        const current = await store.readState();
        if (!canMutateDuoState(current?.status))
          return result("Duo is stopped; use /duo resume before changing shared state.", current);
        let message = "";
        const state = await store.update((draft) => {
          if (params.action === "add") {
            if (!params.text?.trim())
              throw new Error("text is required for add");
            const id = Math.max(0, ...draft.todo.map((item) => item.id)) + 1;
            draft.todo.push({
              id,
              text: params.text.trim(),
              status: params.status ?? "pending",
              owner: params.owner,
              updatedAt: new Date().toISOString(),
            });
            message = `Added todo #${id}`;
            return;
          }
          const item = draft.todo.find(
            (candidate) => candidate.id === params.id,
          );
          if (!item) throw new Error(`Todo #${params.id ?? "?"} not found`);
          if (params.action === "remove") {
            draft.todo = draft.todo.filter(
              (candidate) => candidate.id !== item.id,
            );
            message = `Removed todo #${item.id}`;
          } else {
            if (params.text !== undefined) item.text = params.text.trim();
            if (params.status !== undefined)
              item.status = params.status as TodoStatus;
            if (params.owner !== undefined) item.owner = params.owner;
            item.updatedAt = new Date().toISOString();
            message = `Updated todo #${item.id}`;
          }
        }, params.expectedRevision);
        return result(`${message} at revision ${state.revision}`, state);
      },
    });
    api.registerTool({
      name: "duo_decisions",
      label: "Duo Decisions",
      description: "List or add durable decisions with optional evidence.",
      parameters: DecisionSchema,
      execute: async (_id, params) => {
        if (!store) return result("Duo has not been started");
        if (params.action === "list") {
          const state = await store.readState();
          return result(
            state?.decisions.length
              ? state.decisions
                  .map(
                    (d) =>
                      `#${d.id} ${d.text}${d.evidence ? ` — ${d.evidence}` : ""}`,
                  )
                  .join("\n")
              : "No decisions",
            state,
          );
        }
        const current = await store.readState();
        if (!canMutateDuoState(current?.status))
          return result("Duo is stopped; use /duo resume before changing shared state.", current);
        const decisionText = params.text?.trim();
        if (!decisionText) return result("text is required for add");
        const state = await store.update((draft) => {
          const id = Math.max(0, ...draft.decisions.map((item) => item.id)) + 1;
          draft.decisions.push({
            id,
            text: decisionText,
            evidence: params.evidence?.trim(),
            author: actor,
            createdAt: new Date().toISOString(),
          });
        }, params.expectedRevision);
        return result(`Decision recorded at revision ${state.revision}`, state);
      },
    });
    api.registerTool({
      name: "duo_workspace",
      label: "Duo Workspace",
      description:
        "Inspect project write ownership. In transferable mode, acquire, release, or transfer the shared write lock; read-only work never needs it.",
      parameters: WorkspaceSchema,
      execute: async (_id, params) => {
        if (!store) return result("Duo has not been started");
        const latestConfig = await store.readConfig();
        const currentState = await enforceWritePolicy(store, latestConfig);
        if (params.action === "status")
          return result(
            latestConfig.writePolicy === "austin-only"
              ? "Workspace write owner: austin (fixed by writePolicy=austin-only)"
              : `Workspace write owner: ${currentState?.workspaceOwner ?? "none"}`,
            currentState,
          );
        if (!canMutateDuoState(currentState?.status))
          return result("Duo is stopped; use /duo resume before changing shared state.", currentState);
        if (
          !canUseWorkspaceAction(
            latestConfig.writePolicy,
            actor,
            params.action,
          )
        ) {
          return result(
            "Workspace ownership is fixed to Austin by writePolicy=austin-only; no handoff was performed.",
            currentState,
          );
        }
        const state = await store.update((draft) => {
          if (params.action === "acquire") {
            if (draft.workspaceOwner && draft.workspaceOwner !== actor)
              throw new Error(
                `Lock is owned by ${agentName(draft.workspaceOwner)}`,
              );
            draft.workspaceOwner = actor;
          } else if (params.action === "release") {
            if (draft.workspaceOwner !== actor)
              throw new Error("Only the current owner can release the lock");
            draft.workspaceOwner = null;
          } else {
            if (draft.workspaceOwner !== actor)
              throw new Error("Only the current owner can transfer the lock");
            if (!params.to) throw new Error("to is required for transfer");
            draft.workspaceOwner = params.to;
          }
        });
        let handoffStatus = "";
        if (params.action === "release" || params.action === "transfer") {
          const recipient = workspaceHandoffRecipient(
            actor,
            params.action,
            state.workspaceOwner,
          );
          if (recipient) {
            const dispatched = await notifyPeerOfWorkspaceHandoff(
              actor,
              recipient,
              state,
              params.action,
            );
            handoffStatus = dispatched
              ? ` ${agentName(recipient)} wake-up was dispatched through the workspace control plane; this does not wait for the peer's full turn.`
              : ` ${agentName(recipient)} could not be notified; resume Duo before relying on the handoff.`;
          }
        }
        return result(
          `Workspace ownership committed at revision ${state.revision}: ${state.workspaceOwner ?? "none"}.${handoffStatus}`,
          state,
        );
      },
    });
  };

  const installWriteGuard = (api: ExtensionAPI, actor: AgentId) => {
    api.on("tool_call", async (event) => {
      if (actor === "tony" && tonyMustYield) {
        return {
          block: true,
          reason:
            "Tony already sent this turn's consolidated peer message. End the turn now; further tools and polling are blocked until Austin sends new work.",
        };
      }
      const shellCommand =
        event.toolName === "bash"
          ? String((event.input as { command?: unknown }).command ?? "")
          : "";
      if (actor === "tony" && isWaitingShell(shellCommand)) {
        return {
          block: true,
          reason:
            "Tony must not sleep or poll for Austin. Send current work with duo_send and end the turn; a peer message will start another turn.",
        };
      }
      const toolPath =
        event.toolName === "edit" || event.toolName === "write"
          ? String((event.input as { path?: unknown }).path ?? "")
          : "";
      if (
        actor === "tony" &&
        (event.toolName === "edit" || event.toolName === "write") &&
        store?.isTonyScratchPath(toolPath)
      )
        return;
      const mutating =
        event.toolName === "edit" ||
        event.toolName === "write" ||
        (event.toolName === "bash" && isMutatingShell(shellCommand));
      if (!mutating || !store) return;
      // The collaboration gate only governs the session that actually owns the
      // active Duo run. A stale `state.json` left behind by another Pi session
      // (or by a run that was stopped) must never lock this session's writes:
      // `foregroundDuoActive` is set at session_start only when this session is
      // the recorded Austin session of an active run. Tony carries its own
      // guard on its isolated background API, so it is exempt here.
      if (actor === "austin" && !foregroundDuoActive) return;
      const latestConfig = await store.readConfig();
      const state = await enforceWritePolicy(store, latestConfig);
      // A non-active run (stopped/complete) no longer owns the workspace gate.
      // `/duo stop` only flips `status`, so without this the EXPLORE/VERIFY
      // phase constraint would stay armed forever after a stop.
      if (actor === "austin" && state && state.status !== "active") return;
      const phaseBlockReason = workspaceMutationBlockReason(
        actor,
        state?.collaboration,
        state?.workspaceOwner ?? null,
      );
      if (phaseBlockReason) {
        return {
          block: true,
          reason: phaseBlockReason,
        };
      }
      if (
        !canMutateWorkspace(
          latestConfig.writePolicy,
          actor,
          state?.workspaceOwner ?? null,
        )
      ) {
        if (latestConfig.writePolicy === "austin-only") {
          return {
            block: true,
            reason:
              `Austin-only write policy: Tony may inspect, test, and review, but only Austin may modify project files. Disposable harnesses may be written with write/edit under ${store.tonyScratchDir}. Send concise file:line findings or acceptance tests with duo_send.`,
          };
        }
        const owner = state?.workspaceOwner
          ? agentName(state.workspaceOwner)
          : "nobody";
        return {
          block: true,
          reason: `Workspace write lock is owned by ${owner}. Use duo_workspace and coordinate a transfer.`,
        };
      }
    });
    api.on("tool_result", (event) => {
      if (
        ![
          "duo_send",
          "duo_status",
          "duo_goal",
          "duo_todo",
          "duo_decisions",
          "duo_workspace",
          "duo_plan",
          "duo_checkpoint",
        ].includes(event.toolName)
      )
        guard.noteMaterialActivity();
    });
  };

  /**
   * Capture one agent's live stream (thinking / tool calls / tool results /
   * plain text) into the native transcript. Austin's events arrive through
   * the foreground API; Tony's through the same API injected via duoFactory.
   */
  const installWorkbenchCapture = (api: ExtensionAPI, actor: AgentId) => {
    const tools = actor === "austin" ? austinTools : tonyTools;
    const captured = actor === "austin"
      ? austinCapturedMessages
      : tonyCapturedMessages;
    const captureMessage = (message: any, replace?: any) => {
      if (!message || !["user", "assistant", "toolResult"].includes(message.role))
        return;
      if (replace) {
        const index = captured.indexOf(replace);
        if (index >= 0) {
          captured[index] = message;
          return;
        }
      }
      if (!captured.includes(message)) captured.push(message);
      // ponytail: retain only a short append-lag window; increase if Pi ever
      // delays SessionManager persistence by more than a normal turn.
      if (captured.length > 64) captured.splice(0, captured.length - 64);
    };
    const result = (value: any, isError: boolean) =>
      value && typeof value === "object"
        ? { ...value, isError }
        : { content: [{ type: "text", text: String(value ?? "") }], isError };
    api.on("message_start", (event) => {
      captureMessage(event.message);
      if (event.message?.role === "assistant") {
        if (actor === "austin") austinStreaming = event.message;
        else tonyStreaming = event.message;
      }
      refreshWorkbench(true);
    });
    api.on("message_update", (event) => {
      if (event.message?.role !== "assistant") return;
      if (actor === "austin") austinStreaming = event.message;
      else tonyStreaming = event.message;
      refreshWorkbench();
    });
    api.on("message_end", (event) => {
      const streaming = event.message?.role === "assistant"
        ? (actor === "austin" ? austinStreaming : tonyStreaming)
        : undefined;
      // Each stream update is a fresh assistant object. Replace the one
      // message captured at start with the final object instead of appending
      // every delta snapshot as a separate transcript row.
      captureMessage(event.message, streaming);
      if (event.message?.role === "assistant") {
        if (actor === "austin") austinStreaming = undefined;
        else tonyStreaming = undefined;
      }
      // Tool results are persisted after their execution event; this redraw
      // makes the native component converge even when that happens later.
      refreshWorkbench();
    });
    api.on("tool_execution_start", (event) => {
      tools.set(event.toolCallId, {
        ...tools.get(event.toolCallId),
        name: event.toolName,
        args: event.args,
        started: true,
      });
      refreshWorkbench();
    });
    api.on("tool_execution_update", (event) => {
      tools.set(event.toolCallId, {
        ...tools.get(event.toolCallId),
        name: event.toolName,
        args: event.args,
        partial: result(event.partialResult, false),
      });
      refreshWorkbench();
    });
    api.on("tool_execution_end", (event) => {
      tools.set(event.toolCallId, {
        ...tools.get(event.toolCallId),
        name: event.toolName,
        args: tools.get(event.toolCallId)?.args,
        final: result(event.result, event.isError),
      });
      refreshWorkbench();
    });
  };

  const ensureTony = async (
    cwd: string,
    registry: ModelRegistry,
  ): Promise<void> => {
    const generation = lifecycleGeneration;
    if (!isCurrentGeneration(generation)) return;
    const currentStore = getStore(cwd);
    store = currentStore;
    config = await currentStore.readConfig();
    const state = await enforceWritePolicy(currentStore, config);
    if (!state || state.status !== "active")
      throw new Error("No active Duo session. Use /duo start.");
    if (tony) return;
    const ref = config.agentB ?? stateModel(state, "tony");
    if (!ref)
      throw new Error("Tony's model is missing from .pi-duo/config.json");
    const model = registry.find(ref.provider, ref.modelId);
    if (!model)
      throw new Error(
        `Configured Tony model is unavailable: ${modelText(ref)}`,
      );

    const duoFactory = (api: ExtensionAPI) => {
      registerTools(api, "tony");
      installWriteGuard(api, "tony");
      installWorkbenchCapture(api, "tony");
      api.on("before_agent_start", async (event) => {
        const latestConfig = await currentStore.readConfig();
        const latest = await enforceWritePolicy(currentStore, latestConfig);
        return {
          systemPrompt: `${event.systemPrompt}\n\nYou are Tony. Austin is your peer in the same workspace.\n\n${cooperationPolicy(latestConfig, "tony")}\n\n${latest ? formatSharedContext(latest) : ""}`,
        };
      });
    };
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      extensionFactories: [
        { name: "pi-duo-tony", factory: duoFactory, hidden: true },
      ],
    });
    await loader.reload();
    await currentStore.ensureTonyScratch();
    if (!isCurrentGeneration(generation)) return;
    const manager = state.agents.tony.sessionFile
      ? SessionManager.open(state.agents.tony.sessionFile)
      : SessionManager.create(cwd, path.join(currentStore.dir, "sessions"));
    const created = await createAgentSession({
      cwd,
      model,
      resourceLoader: loader,
      sessionManager: manager,
    });
    const activeTony = created.session;
    if (!isCurrentGeneration(generation)) {
      activeTony.dispose();
      return;
    }
    tony = activeTony;
    tonyCapturedMessages.length = 0;
    if (!state.agents.tony.sessionFile)
      activeTony.sessionManager.appendSessionInfo("pi-duo · Tony");
    tonyUnsubscribe = activeTony.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "toolResult" &&
        !String(event.message.toolName).startsWith("duo_")
      )
        guard.noteMaterialActivity();
    });
    await currentStore.update((draft) => {
      draft.agents.tony.sessionId = activeTony.sessionId;
      draft.agents.tony.sessionFile = activeTony.sessionFile;
      draft.agents.tony.provider = ref.provider;
      draft.agents.tony.modelId = ref.modelId;
    });
  };

  const disposeTony = async () => {
    tonyUnsubscribe?.();
    tonyUnsubscribe = undefined;
    const activeTony = tony;
    tony = undefined;
    tonyStreaming = undefined;
    tonyCapturedMessages.length = 0;
    tonyTools.clear();
    refreshWorkbench();
    if (!activeTony) return;
    try {
      if (activeTony.isStreaming) await activeTony.abort();
    } catch {
      // Cleanup must not prevent reload or session replacement.
    } finally {
      activeTony.dispose();
    }
  };

  const markReviewFailed = async (userTurn: number, error: string) => {
    if (!store) return;
    const current = await store.readState();
    if (current?.review?.status !== "pending" || current.review.userTurn !== userTurn)
      return;
    try {
      await store.update((draft) => {
        if (
          draft.review?.status === "pending" &&
          draft.review.userTurn === userTurn
        ) {
          draft.review.status = "failed";
          draft.review.error = error;
          draft.review.updatedAt = new Date().toISOString();
        }
      }, current.revision);
      setReviewIndicator("failed", error);
    } catch {
      // A newer user turn may have replaced this review; leave that state intact.
    }
  };

  const markReviewReported = async (userTurn: number): Promise<boolean> => {
    if (!store) return false;

    const current = await store.readState();

    if (
      !current ||
      current.review?.status !== "pending" ||
      current.review.userTurn !== userTurn ||
      current.collaboration?.phase !== "verify"
    ) {
      return false;
    }

    try {
      await store.update((draft) => {
        const ok = applyReviewReported(draft, userTurn);
        if (!ok) {
          throw new Error("Verification state changed");
        }
      }, current.revision);

      setReviewIndicator("complete");
      return true;
    } catch {
      return false;
    }
  };

  const queueTonyCollaborationTask = (prompt: string, userTurn: number) => {
    const generation = lifecycleGeneration;
    tonyQueue = tonyQueue
      .then(async () => {
        if (!isCurrentGeneration(generation) || !tony) return;
        const activeTony = tony;
        setReviewIndicator("collaborating", "Tony 正在独立探索");
        // A followUp sent while Tony is streaming is only queued; its promise
        // resolves before that future turn finishes. Wait for the current turn
        // to become idle, then start this collaboration as its own attributable turn.
        await activeTony.waitForIdle();
        if (!isCurrentGeneration(generation) || tony !== activeTony) return;
        tonyMustYield = false;
        activeTonyUserTurn = userTurn;
        const sentBefore = tonySentSequence;
        try {
          await activeTony.sendCustomMessage(
            {
              customType: "pi-duo-user-task",
              content: `[Shared user task for Tony (Peer Collaborator)]\nYou are Tony, Austin's peer collaborator in this workspace.\nIndependently analyze the user's task before relying on Austin's conclusions.\n\nInspect relevant code, logs, architecture, and constraints.\nDevelop your own view of:\n- what the real problem is,\n- plausible approaches,\n- important risks,\n- useful experiments,\n- work that can be split between you and Austin.\n\nWhen you have a materially useful position, send it to Austin using duo_send(kind='proposal' | 'evidence' | 'objection').\nYou are encouraged to disagree when evidence supports it.\nDuring this EXPLORE phase, you are collaborating on the solution, not reviewing Austin's work.\nAustin will wait for your initial independent contribution before modifying project files.\n\nUser task:\n${prompt}`,
              display: false,
            },
            triggeringDelivery(false),
          );
          if (!isCurrentGeneration(generation) || tony !== activeTony) return;
          const outcome = latestAssistantOutcome(activeTony);
          if (outcome?.error) {
            if (store) {
              await degradeCollaborationTurn(store, userTurn);
            }
            setReviewIndicator("collaboration-failed", "Tony 协作异常，已降级");
            sendMessageSafely(
              {
                customType: "pi-duo-peer",
                content: `[Tony error]\n${outcome.error}\n(Collaboration degraded to single-agent mode)`,
                display: true,
              },
              { triggerTurn: true, deliverAs: "steer" },
              generation,
            );
            return;
          }
          if (tonySentSequence === sentBefore) {
            const final = outcome?.text.slice(0, 4000) ?? "";
            if (final) {
              await sendToAustin(final, "important", true, false, "proposal");
            } else {
              if (store) {
                await degradeCollaborationTurn(store, userTurn);
              }
              setReviewIndicator("collaboration-failed", "Tony 未提供可用协作结论，已降级");

              sendMessageSafely(
                {
                  customType: "pi-duo-peer",
                  content:
                    "[Tony collaboration unavailable]\n" +
                    "Tony completed the EXPLORE turn without producing a usable contribution. " +
                    "The collaboration has degraded to single-agent mode for this user turn.",
                  display: true,
                },
                { triggerTurn: true, deliverAs: "steer" },
                generation,
              );
            }
          }
        } finally {
          if (activeTonyUserTurn === userTurn) activeTonyUserTurn = undefined;
        }
      })
      .catch(async (error) => {
        if (activeTonyUserTurn === userTurn) activeTonyUserTurn = undefined;
        const errorText = error instanceof Error ? error.message : String(error);
        if (store) {
          await degradeCollaborationTurn(store, userTurn);
        }
        setReviewIndicator("collaboration-failed", "Tony 协作异常，已降级");
        sendMessageSafely(
          {
            customType: "pi-duo-peer",
            content: `[Tony error]\n${errorText}\n(Collaboration degraded to single-agent mode)`,
            display: true,
          },
          { triggerTurn: true },
          generation,
        );
      });
  };

  const failUnavailableVerification = async (
    userTurn: number,
    generation: number,
  ) => {
    await markReviewFailed(
      userTurn,
      "Tony became unavailable before verification could start",
    );
    sendMessageSafely(
      {
        customType: "pi-duo-peer",
        content:
          "[Tony verification unavailable]\n" +
          "Tony became unavailable before independent verification could start. " +
          "The pending review was marked failed; resume Tony and request verification again.",
        display: true,
      },
      { triggerTurn: true, deliverAs: "steer" },
      generation,
    );
  };

  const queueTonyVerificationTask = (summary?: string, userTurn?: number) => {
    const generation = lifecycleGeneration;
    const taskTurn = userTurn ?? guard.turn;
    tonyQueue = tonyQueue
      .then(async () => {
        if (!isCurrentGeneration(generation)) return;
        if (!tony) {
          await failUnavailableVerification(taskTurn, generation);
          return;
        }
        const activeTony = tony;
        setReviewIndicator("working", "Tony 独立验证中");
        await activeTony.waitForIdle();
        if (!isCurrentGeneration(generation)) return;
        if (tony !== activeTony) {
          await failUnavailableVerification(taskTurn, generation);
          return;
        }
        tonyMustYield = false;
        activeTonyUserTurn = taskTurn;
        const sentBefore = tonySentSequence;
        try {
          await activeTony.sendCustomMessage(
            {
              customType: "pi-duo-user-task",
              content: `[Verification Request from Austin]\nAustin reports that the current deliverable is ready for independent verification.${summary ? `\nSummary: ${summary}` : ""}\n\nNow switch roles:\n- Independently verify the actual current implementation.\n- Re-read the changed files.\n- Run appropriate tests and validations.\n- Look for regressions and violated assumptions.\n\nIf actionable problems remain:\n  Send one consolidated report with:\n  duo_send(\n    kind='finding',\n    reviewFinding=true,\n    importance='important'\n  )\n\nIf verification succeeds:\n  Send one consolidated final report with:\n  duo_send(\n    kind='verification',\n    reviewComplete=true,\n    importance='important'\n  )\n\nreviewComplete=true is the final verification action.\nDo not call duo_checkpoint after duo_send.\nThe control plane will record completion and wake Austin automatically.`,
              display: false,
            },
            triggeringDelivery(false),
          );
          if (!isCurrentGeneration(generation)) return;
          if (tony !== activeTony) {
            await failUnavailableVerification(taskTurn, generation);
            return;
          }
          const outcome = latestAssistantOutcome(activeTony);
          if (outcome?.error) {
            await markReviewFailed(taskTurn, outcome.error);
            sendMessageSafely(
              {
                customType: "pi-duo-peer",
                content: `[Tony verification error]\n${outcome.error}`,
                display: true,
              },
              { triggerTurn: true },
              generation,
            );
            return;
          }
          if (tonySentSequence === sentBefore) {
            const final = outcome?.text.slice(0, 4000) ?? "";

            if (final) {
              await sendToAustin(
                `[Unstructured verification output]\n${final}`,
                "important",
                true,
                false,
                "finding",
              );
            }

            await markReviewFailed(
              taskTurn,
              "Tony completed the verification turn without an explicit reviewFinding or reviewComplete control-plane report",
            );

            sendMessageSafely(
              {
                customType: "pi-duo-peer",
                content:
                  "[Tony verification incomplete]\n" +
                  "Tony returned from verification without an explicit " +
                  "reviewFinding=true or reviewComplete=true report. " +
                  "The result was not accepted as peer verification.",
                display: true,
              },
              { triggerTurn: true, deliverAs: "steer" },
              generation,
            );
          }
        } finally {
          if (activeTonyUserTurn === taskTurn) activeTonyUserTurn = undefined;
        }
      })
      .catch(async (error) => {
        if (activeTonyUserTurn === taskTurn) activeTonyUserTurn = undefined;
        const errorText = error instanceof Error ? error.message : String(error);
        await markReviewFailed(taskTurn, errorText);
        sendMessageSafely(
          {
            customType: "pi-duo-peer",
            content: `[Tony verification error]\n${errorText}`,
            display: true,
          },
          { triggerTurn: true },
          generation,
        );
      });
  };

  registerTools(pi, "austin");
  installWriteGuard(pi, "austin");
  installWorkbenchCapture(pi, "austin");

  (pi as any).__registerTonyTools = (
    tonyApi: ExtensionAPI,
    activeTurn?: number,
    testTony?: AgentSession,
  ) => {
    if (activeTurn !== undefined) activeTonyUserTurn = activeTurn;
    if (testTony) {
      tony = testTony;
      tonyCapturedMessages.length = 0;
    }
    registerTools(tonyApi, "tony");
    installWriteGuard(tonyApi, "tony");
    installWorkbenchCapture(tonyApi, "tony");
  };

  pi.registerMessageRenderer("pi-duo-peer", (message, _options, theme) => {
    const details = message.details as PeerMessage | undefined;
    const kind = details?.kind;
    let color: "accent" | "warning" | "success" | "muted" = "accent";
    if (kind === "objection") color = "warning";
    else if (kind === "verification") color = "success";
    else if (kind === "evidence") color = "muted";
    return new Text(theme.fg(color, String(message.content)), 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    foregroundUI = ctx.ui;
    austinSessionManager = ctx.sessionManager;
    austinCapturedMessages.length = 0;
    tonyCapturedMessages.length = 0;
    workbenchCwd = ctx.cwd;
    austinTools.clear();
    tonyTools.clear();
    store = getStore(ctx.cwd);
    config = await store.readConfig();
    let state = await enforceWritePolicy(store, config);
    austinPeerMessages = state?.austinPeerMessageCount ?? 0;
    tonyPeerMessages = state?.tonyPeerMessageCount ?? 0;
    const isAustinSession =
      state?.status === "active" &&
      state.agents.austin.sessionId === ctx.sessionManager.getSessionId();
    foregroundDuoActive = isAustinSession;
    let interruptedReview = false;
    if (isAustinSession && state?.review?.status === "pending") {
      state = await store.update((draft) => {
        if (draft.review?.status === "pending") {
          draft.review.status = "failed";
          draft.review.error =
            "Tony review was interrupted by a session restart or extension reload";
          draft.review.updatedAt = new Date().toISOString();
          interruptedReview = true;
        }
      });
    }
    if (
      isAustinSession
    ) {
      try {
        await ensureTony(ctx.cwd, ctx.modelRegistry);
      } catch (error) {
        ctx.ui.notify(
          `pi-duo: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
    if (interruptedReview) {
      ctx.ui.notify(
        "pi-duo: the pending Tony review was interrupted; Austin will resume with independent verification",
        "warning",
      );
      sendMessageSafely(
        {
          customType: "pi-duo-peer",
          content:
            "[Tony review interrupted]\nThe pending background review was interrupted by a session restart or extension reload. Re-check the current workspace, reconcile shared todos, and clearly disclose any verification that remains unavailable.",
          display: true,
        },
        { triggerTurn: true },
      );
      setReviewIndicator(
        "failed",
        "reload/session restart 中断了后台审查",
      );
    } else if (!isAustinSession) {
      setReviewIndicator("clear");
    } else if (state?.review?.status === "pending") {
      setReviewIndicator("working");
    } else if (state?.review?.status === "reported") {
      setReviewIndicator("complete");
    } else if (state?.review?.status === "failed") {
      setReviewIndicator("failed", state.review.error);
    } else {
      setReviewIndicator("clear");
    }

    // Duo mode shows the dual-column workbench by default. Restoring an active
    // Austin session must bring it back, so the user can immediately type the
    // next task into the editor while watching both columns.
    if (isAustinSession) {
      // Automatic: resuming an active duo in a non-TUI host must not emit an
      // unsolicited "requires TUI mode" error.
      await openWorkbench(ctx, { silent: true });
    } else {
      closeWorkbench();
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!store || !foregroundDuoActive) return;
    const latestConfig = await store.readConfig();
    const state = await enforceWritePolicy(store, latestConfig);
    if (!state || state.status !== "active") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nYou are Austin. Tony is your peer in the same workspace.\n\n${cooperationPolicy(latestConfig, "austin")}\n\n${formatSharedContext(state)}`,
    };
  });

  pi.on("message_end", async (event) => {
    if (!store || !foregroundDuoActive || event.message.role !== "assistant") return;
    if (
      event.message.stopReason !== "stop" &&
      event.message.stopReason !== "length"
    )
      return;
    const state = await store.readState();
    if (!state || state.status !== "active") return;
    const notice = completionGateNotice(state);
    if (!notice) return;
    return {
      message: {
        ...event.message,
        content: [
          { type: "text" as const, text: `[${notice}]\n\n` },
          ...event.message.content,
        ],
      },
    };
  });

  pi.on("agent_end", async () => {
    if (!store || !foregroundDuoActive) return;
    const state = await store.readState();
    if (
      !state ||
      state.status !== "active" ||
      state.review?.status === "pending" ||
      completionReconcileTurn === guard.turn
    )
      return;
    const ids = openCompletionTodoIds(state);
    if (!ids.length) return;
    completionReconcileTurn = guard.turn;
    sendMessageSafely(
      {
        customType: "pi-duo-completion-gate",
        content: `Before giving the final reviewed answer, reconcile shared todo ${ids.map((id) => `#${id}`).join(", ")}. Mark completed work done; leave genuinely unfinished work pending or blocked and disclose it.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.text.trimStart().startsWith("/"))
      return;
    const currentStore = getStore(ctx.cwd);
    config = await currentStore.readConfig();
    const state = await enforceWritePolicy(currentStore, config);
    const userTurn = guard.beginUserTurn(
      foregroundDuoActive && state?.status === "active"
        ? await currentStore.advanceUserTurn()
        : undefined,
    );
    if (foregroundDuoActive && state?.status === "active" && config.autoDispatch) {
      await currentStore.update((draft) => {
        draft.collaboration = {
          userTurn,
          phase: "explore",
          austinContributed: false,
          tonyContributed: false,
          tonyInitialContribution: false,
          tonyRespondedToAustin: false,
          contested: false,
          planRevision: 0,
        };
        delete draft.review;
      });

      try {
        await ensureTony(ctx.cwd, ctx.modelRegistry);
        setReviewIndicator("clear");
        queueMicrotask(() => queueTonyCollaborationTask(event.text, userTurn));
      } catch (error) {
        await degradeCollaborationTurn(currentStore, userTurn);
        setReviewIndicator("collaboration-failed", "Tony 无法启动，已降级");
        ctx.ui.notify(
          `pi-duo could not dispatch Tony: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning",
        );
        sendMessageSafely(
          {
            customType: "pi-duo-peer",
            content:
              "[Tony unavailable]\n" +
              "Tony could not start for this user turn. " +
              "Continue in degraded single-agent mode and do not claim peer verification.",
            display: true,
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
    }
  });

  pi.on("model_select", async (event) => {
    if (!store || !foregroundDuoActive || !(await store.readState())) return;
    const selected = {
      provider: event.model.provider,
      modelId: event.model.id,
    };
    await store.update((state) => {
      state.agents.austin.provider = selected.provider;
      state.agents.austin.modelId = selected.modelId;
    });
    const latestConfig = await store.readConfig();
    latestConfig.agentA = selected;
    await store.writeConfig(latestConfig);
    config = latestConfig;
  });

  pi.on("session_shutdown", async () => {
    setReviewIndicator("clear");
    closeWorkbench();
    foregroundUI = undefined;
    foregroundDuoActive = false;
    extensionActive = false;
    lifecycleGeneration++;
    await disposeTony();
  });

  pi.registerCommand("duo", {
    description: "Manage persistent Austin ↔ Tony peer collaboration",
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      const [command = "status"] = args.split(/\s+/);
      const currentStore = getStore(ctx.cwd);
      store = currentStore;
      config = await currentStore.readConfig();

      if (command === "start") {
        const existing = await currentStore.readState();
        if (blocksDuoRestart(existing))
          return void ctx.ui.notify(
            "Cannot replace an active Duo while Tony review is pending. Use /duo stop first to explicitly record the interrupted review, then run /duo start.",
            "error",
          );
        const peerArg = parseFlag(args, "peer");
        const goalArg = parseFlag(args, "goal");
        const currentModel = ctx.model;
        if (!currentModel)
          return void ctx.ui.notify("Austin has no active model", "error");
        const austinRef = {
          provider: currentModel.provider,
          modelId: currentModel.id,
        };
        let peerRef = peerArg ? parseModelRef(peerArg) : config.agentB;
        if (!peerRef && ctx.hasUI) {
          const choices = ctx.modelRegistry
            .getAvailable()
            .map((m) => `${m.provider}/${m.id}`);
          const selected = await ctx.ui.select("Select Tony's model", choices);
          if (selected) peerRef = parseModelRef(selected);
        }
        if (!peerRef)
          return void ctx.ui.notify(
            "Set agentB in .pi-duo/config.json or use /duo start --peer provider/model",
            "error",
          );
        if (!ctx.modelRegistry.find(peerRef.provider, peerRef.modelId))
          return void ctx.ui.notify(
            `Unavailable model: ${modelText(peerRef)}`,
            "error",
          );
        config.agentA = austinRef;
        config.agentB = peerRef;
        await currentStore.writeConfig(config);
        await disposeTony();
        let state = await currentStore.create(austinRef, peerRef);
        state = await currentStore.update((draft) => {
          draft.agents.austin.sessionId = ctx.sessionManager.getSessionId();
          draft.agents.austin.sessionFile = ctx.sessionManager.getSessionFile();
          if (goalArg) draft.goal = goalArg;
        });
        austinPeerMessages = 0;
        tonyPeerMessages = 0;
        foregroundDuoActive = true;
        await ensureTony(ctx.cwd, ctx.modelRegistry);
        state = (await currentStore.readState()) ?? state;
        ctx.ui.notify(
          `Duo started: Austin (${modelText(austinRef)}) ↔ Tony (${modelText(peerRef)})`,
          "info",
        );
        setReviewIndicator("clear");
        pi.sendMessage({
          customType: "pi-duo-peer",
          content: renderStatus(state, config, "austin"),
          display: true,
        });
        // Duo mode shows the dual-column workbench by default, so entering duo
        // mode is enough to see both agents working side by side. Silent: the
        // start itself already notified, and a non-TUI host cannot show it.
        await openWorkbench(ctx, { silent: true });
        return;
      }

      const state = await enforceWritePolicy(currentStore, config);
      if (!state)
        return void ctx.ui.notify("No Duo session. Use /duo start.", "warning");

      if (command === "history") {
        await showHistory(ctx);
        return;
      }

      if (command === "view") {
        await toggleWorkbench(ctx);
        return;
      }

      if (command === "workbench") {
        await showWorkbench(ctx);
        return;
      }

      if (command === "stop") {
        const rawTarget = args.split(/\s+/)[1];
        const target = parseAgentTarget(rawTarget);
        if (rawTarget && !target)
          return void ctx.ui.notify(
            "Usage: /duo stop [austin|tony] (agent names are case-insensitive)",
            "error",
          );
        if (target === "austin") {
          if (!ctx.isIdle()) {
            ctx.abort();
            ctx.ui.notify(
              "Austin's active turn was aborted; Tony and the Duo session remain active",
              "info",
            );
          } else {
            ctx.ui.notify(
              "Austin is already idle; Tony and the Duo session remain active",
              "info",
            );
          }
          return;
        }
        if (target === "tony") {
          await currentStore.update((draft) => {
            if (draft.collaboration) {
              draft.collaboration.degraded = true;

              if (
                draft.collaboration.phase === "explore" &&
                !draft.collaboration.tonyInitialContribution
              ) {
                draft.collaboration.tonyInitialContribution = true;
              }
            }

            if (draft.review?.status === "pending") {
              draft.review.status = "failed";
              draft.review.error =
                "Tony verification was interrupted by /duo stop tony";
              draft.review.updatedAt = new Date().toISOString();
            }
          });
          setReviewIndicator("failed", "Tony 已被用户定向停止");
          sendMessageSafely(
            {
              customType: "pi-duo-peer",
              content:
                "[Tony stopped]\n" +
                "Tony was stopped by the user. Continue this turn in degraded single-agent mode. " +
                "Do not claim peer verification while Tony is unavailable.",
              display: true,
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
          ctx.ui.notify(
            "Tony is being stopped; Austin and the Duo session remain active. Use /duo resume to start Tony again.",
            "info",
          );
          dispatchControlPlaneTask(disposeTony, (error) => {
            ctx.ui.notify(
              `Tony stop cleanup reported: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          });
          return;
        }
        await currentStore.update((draft) => {
          draft.status = "stopped";
          // Clear the collaboration block, not just the status. The workspace
          // write gate is derived from `collaboration.phase`
          // (`workspaceMutationBlockReason`), so a surviving block keeps a
          // stopped run armed: any session in this directory would stay locked
          // out of writes until someone cleared the file by hand. Stopping must
          // be terminal.
          draft.collaboration = undefined;
          draft.workspaceOwner = null;
          if (draft.review?.status === "pending") {
            draft.review.status = "failed";
            draft.review.error = "Tony review was interrupted by /duo stop";
            draft.review.updatedAt = new Date().toISOString();
          }
        });
        foregroundDuoActive = false;
        setReviewIndicator("clear");
        closeWorkbench();
        if (!ctx.isIdle()) ctx.abort();
        ctx.ui.notify(
          "Duo stopped immediately; active Austin/Tony turns are being aborted and both session histories were preserved",
          "info",
        );
        dispatchControlPlaneTask(disposeTony, (error) => {
          ctx.ui.notify(
            `Duo stopped, but Tony cleanup reported: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        });
      } else if (command === "resume") {
        await currentStore.update((draft) => {
          draft.status = "active";
          if (draft.review?.status === "pending") {
            draft.review.status = "failed";
            draft.review.error =
              "Tony review was interrupted before /duo resume; run a new task for a fresh review";
            draft.review.updatedAt = new Date().toISOString();
          }
        });
        const austinFile = state.agents.austin.sessionFile;
        if (
          state.agents.austin.sessionId !== ctx.sessionManager.getSessionId() &&
          austinFile
        ) {
          await ctx.switchSession(austinFile, {
            withSession: async (newCtx) => {
              // The new extension instance restores Tony from session_start.
              newCtx.ui.notify("Duo resumed", "info");
            },
          });
          return;
        }
        await ensureTony(ctx.cwd, ctx.modelRegistry);
        foregroundDuoActive = true;
        await openWorkbench(ctx, { silent: true });
        ctx.ui.notify("Duo resumed", "info");
      } else if (command === "goal") {
        const goal = args.slice("goal".length).trim();
        if (goal) {
          const updated = await currentStore.update((draft) => {
            draft.goal = goal;
          });
          ctx.ui.notify(`Goal updated (revision ${updated.revision})`, "info");
        } else
          pi.sendMessage({
            customType: "pi-duo-peer",
            content: `GOAL\n${state.goal || "(not set)"}`,
            display: true,
          });
      } else if (command === "config") {
        const updates = args
          .slice("config".length)
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        for (const update of updates) {
          const [key, value] = update.split("=");
          if (key === "maxPeerMessagesPerTurn") {
            const parsed = Number(value);
            if (
              !Number.isSafeInteger(parsed) ||
              parsed < MIN_PEER_MESSAGES_PER_TURN
            )
              return void ctx.ui.notify(
                `maxPeerMessagesPerTurn must be an integer >= ${MIN_PEER_MESSAGES_PER_TURN} so a review/fix/re-review cycle cannot deadlock`,
                "error",
              );
            config.maxPeerMessagesPerTurn = parsed;
          }
          else if (key === "maxDeferredMessagesPerTurn")
            config.maxDeferredMessagesPerTurn = Number(value);
          else if (key === "maxConsecutivePeerTurns")
            config.maxConsecutivePeerTurns = Number(value);
          else if (key === "similarityThreshold")
            config.similarityThreshold = Number(value);
          else if (key === "autoDispatch")
            config.autoDispatch = value === "true";
          else if (key === "writePolicy") {
            if (value !== "austin-only" && value !== "transferable")
              return void ctx.ui.notify(
                "writePolicy must be austin-only or transferable",
                "error",
              );
            config.writePolicy = value;
          } else return void ctx.ui.notify(`Unknown config key: ${key}`, "error");
        }
        await currentStore.writeConfig(config);
        config = await currentStore.readConfig();
        await enforceWritePolicy(currentStore, config);
        pi.sendMessage({
          customType: "pi-duo-peer",
          content: JSON.stringify(config, null, 2),
          display: true,
        });
      } else if (command === "status" || command === "") {
        pi.sendMessage({
          customType: "pi-duo-peer",
          content: renderStatus(state, config, "austin"),
          display: true,
        });
      } else {
        ctx.ui.notify(
          "Usage: /duo [start|stop|resume|history|view|workbench|status|goal|config]",
          "warning",
        );
      }
    },
  });
}
