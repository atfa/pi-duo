import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  canMutateWorkspace,
  canUseWorkspaceAction,
  controlPlaneDelivery,
  dispatchControlPlaneTask,
  LoopGuard,
  roleDescription,
  triggeringDelivery,
  workspaceHandoffRecipient,
} from "./src/coordinator.js";
import {
  DuoStore,
  formatSharedContext,
  isMutatingShell,
  isWaitingShell,
  otherAgent,
  parseModelRef,
} from "./src/store.js";
import type {
  AgentId,
  DuoConfig,
  DuoState,
  ModelRef,
  TodoStatus,
} from "./src/types.js";

const BASE_POLICY = `## Duo cooperation policy
You are one of two peer coding agents working on the same goal. Your peer is an independent reasoning agent, not your subordinate.
Do not agree automatically. Challenge weak assumptions. Resolve disagreement with a discriminating test, code inspection, or log inspection instead of prolonged argument.
Share important discoveries, evidence, and decisions. Avoid acknowledgements with no new information. Do not wait for consensus on obvious low-risk actions. If duo_send reports that a message was saved without triggering a turn, do not resend it; the peer will see it in persistent context later.
Never run sleep commands or poll while waiting for the peer. Send your current work with duo_send and end the turn; a later peer message will trigger another turn.
For consequential architecture changes, request peer review when practical. Use duo_send selectively; the peer has an independent persistent context.`;

function cooperationPolicy(config: DuoConfig, actor: AgentId): string {
  const identityPolicy =
    actor === "austin"
      ? `## Fixed role identity
You are Austin, the foreground agent. Tony is the background peer. Never identify yourself as Tony or spend a peer message asking the peer to confirm identities.
Before your final user-facing answer, reconcile the shared duo_todo list: mark completed work done and leave genuinely unfinished work pending or blocked.`
      : `## Fixed role identity
You are Tony, the background peer. Austin is the foreground agent. Never identify yourself as Austin or spend a peer message asking the peer to confirm identities.
Consolidate review findings instead of narrating every intermediate check. If shared todos are stale, tell Austin which items need reconciliation.`;
  const workspacePolicy =
    config.writePolicy === "austin-only"
      ? `## Austin-only write policy
Austin is the sole writer of project files. Tony must not call edit/write, run recognizable workspace-mutating shell commands, request workspace ownership, or ask Austin to transfer it. Tony should work as an independent reader, investigator, tester, and reviewer. Consolidate findings into concise reports with file:line evidence, failure conditions, and acceptance tests. Austin should implement changes and request Tony review at material checkpoints. Shared .pi-duo state and Tony's own session persistence are exempt from this project-file policy.`
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
  return [
    `Duo: ${state.status} (revision ${state.revision})`,
    `Current role: ${roleDescription(actor)}`,
    `Goal: ${state.goal || "(not set)"}`,
    `Todo: ${counts.done}/${state.todo.length} done, ${counts.in_progress} active, ${counts.blocked} blocked`,
    `Austin: ${modelText(stateModel(state, "austin"))} · session ${state.agents.austin.sessionId?.slice(0, 8) ?? "?"}`,
    `Tony: ${modelText(stateModel(state, "tony"))} · session ${state.agents.tony.sessionId?.slice(0, 8) ?? "?"}`,
    `Write policy: ${config.writePolicy}`,
    `Workspace write owner: ${state.workspaceOwner ? agentName(state.workspaceOwner) : "none"}`,
    `Peer messages: ${state.peerMessageCount}`,
    `Last activity: ${state.lastActivityAt}`,
  ].join("\n");
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
  let lastTonyDelivery: { sequence: number; content: string } | undefined;
  let extensionActive = true;
  let lifecycleGeneration = 0;

  const isCurrentGeneration = (generation: number) =>
    extensionActive && generation === lifecycleGeneration;

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
  ) => {
    const generation = lifecycleGeneration;
    if (!isCurrentGeneration(generation)) return "Duo extension is reloading.";
    if (!store || !config) return "Duo is not initialized";
    const blocked = await guard.check(
      store,
      "tony",
      content,
      config,
      importance,
    );
    if (!isCurrentGeneration(generation)) return "Duo extension is reloading.";
    const deferred = blocked?.persistWithoutTurn === true;
    if (blocked && !deferred) return blocked.reason;
    if (deferred) guard.recordDeferredMessage();
    else guard.recordPeerMessage();
    tonySentSequence++;
    lastTonyDelivery = { sequence: tonySentSequence, content };
    const message = await store.appendMessage({
      from: "tony",
      to: "austin",
      content,
      importance,
      deferred: deferred || undefined,
      userTurn: guard.turn,
    });
    if (!isCurrentGeneration(generation)) return "Duo extension is reloading.";
    let delivery: Parameters<ExtensionAPI["sendMessage"]>[1] = {
      triggerTurn: false,
    };
    if (!deferred && triggerTurn)
      delivery = { triggerTurn: true, deliverAs: "steer" };
    sendMessageSafely(
      {
        customType: "pi-duo-peer",
        content: `[Tony]${deferred ? " [saved without triggering a turn]" : ""}\n${content}`,
        display: importance !== "normal",
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
      deferred: deferred || undefined,
      userTurn: guard.turn,
    });
    const sentBefore = tonySentSequence;
    const activeTony = tony;
    const wasStreaming = activeTony.isStreaming;
    let delivery: Parameters<AgentSession["sendCustomMessage"]>[1] = {
      triggerTurn: false,
    };
    if (!deferred) {
      if (wasStreaming) delivery = { triggerTurn: true, deliverAs: "steer" };
      else delivery = triggeringDelivery(false);
    }
    await activeTony.sendCustomMessage(
      {
        customType: "pi-duo-peer",
        content: `[Austin]${deferred ? " [saved without triggering a turn]" : ""}\n${content}`,
        display: false,
        details: message,
      },
      delivery,
    );
    if (!isCurrentGeneration(generation) || tony !== activeTony)
      return "Duo extension is reloading.";
    if (deferred) {
      return `High-priority message saved in Tony's persistent context and audit log without triggering another turn. ${blocked?.reason}`;
    }
    if (wasStreaming) {
      return "Message delivered into Tony's active turn. Tony is still working; no new reply is available yet. Do not treat earlier Tony text as a response to this message.";
    }
    const outcome = latestAssistantOutcome(activeTony);
    if (outcome?.error) {
      sendMessageSafely(
        {
          customType: "pi-duo-peer",
          content: `[Tony error]\n${outcome.error}`,
          display: true,
        },
        { triggerTurn: false },
        generation,
      );
      return `Tony failed to respond: ${outcome.error}`;
    }
    if (
      tonySentSequence > sentBefore &&
      lastTonyDelivery?.sequence === tonySentSequence
    ) {
      return `Tony replied:\n${lastTonyDelivery.content}`;
    }
    const final = outcome?.text.slice(0, 4000) ?? "";
    if (final) {
      await sendToAustin(final, "important", false);
      return `Tony replied:\n${final}`;
    }
    return "Tony completed the turn without returning any text.";
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
        const response =
          actor === "austin"
            ? await sendToTony(params.message, params.importance ?? "normal")
            : await sendToAustin(
                params.message,
                params.importance ?? "normal",
                true,
              );
        return result(response);
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
        if (params.action === "get")
          return result((await store.readState())?.goal || "(not set)");
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
      const mutating =
        event.toolName === "edit" ||
        event.toolName === "write" ||
        (event.toolName === "bash" && isMutatingShell(shellCommand));
      if (!mutating || !store) return;
      const latestConfig = await store.readConfig();
      const state = await enforceWritePolicy(store, latestConfig);
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
              "Austin-only write policy: Tony may inspect, test, and review, but only Austin may modify project files. Send concise file:line findings or acceptance tests with duo_send.",
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
        ].includes(event.toolName)
      )
        guard.noteMaterialActivity();
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
    if (!activeTony) return;
    try {
      if (activeTony.isStreaming) await activeTony.abort();
    } catch {
      // Cleanup must not prevent reload or session replacement.
    } finally {
      activeTony.dispose();
    }
  };

  const queueTonyTask = (prompt: string) => {
    const generation = lifecycleGeneration;
    tonyQueue = tonyQueue
      .then(async () => {
        if (!isCurrentGeneration(generation) || !tony) return;
        const activeTony = tony;
        const sentBefore = tonySentSequence;
        await activeTony.sendCustomMessage(
          {
            customType: "pi-duo-user-task",
            content: `[Shared user task for ${roleDescription("tony")}]\nAustin is the foreground agent and owns project-file edits in austin-only mode. Independently inspect, test, and review; send concise evidence instead of implementing files.\n\n${prompt}`,
            display: false,
          },
          triggeringDelivery(activeTony.isStreaming),
        );
        if (!isCurrentGeneration(generation) || tony !== activeTony) return;
        const outcome = latestAssistantOutcome(activeTony);
        if (outcome?.error) {
          sendMessageSafely(
            {
              customType: "pi-duo-peer",
              content: `[Tony error]\n${outcome.error}`,
              display: true,
            },
            { triggerTurn: false },
            generation,
          );
          return;
        }
        if (tonySentSequence === sentBefore) {
          const final = outcome?.text.slice(0, 4000) ?? "";
          if (final) await sendToAustin(final, "important", false);
        }
      })
      .catch((error) => {
        sendMessageSafely(
          {
            customType: "pi-duo-peer",
            content: `[Tony error]\n${error instanceof Error ? error.message : String(error)}`,
            display: true,
          },
          undefined,
          generation,
        );
      });
  };

  registerTools(pi, "austin");
  installWriteGuard(pi, "austin");

  pi.registerMessageRenderer(
    "pi-duo-peer",
    (message, _options, theme) =>
      new Text(theme.fg("accent", String(message.content)), 0, 0),
  );

  pi.on("session_start", async (_event, ctx) => {
    store = getStore(ctx.cwd);
    config = await store.readConfig();
    const state = await enforceWritePolicy(store, config);
    if (
      state?.status === "active" &&
      state.agents.austin.sessionId === ctx.sessionManager.getSessionId()
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
  });

  pi.on("before_agent_start", async (event) => {
    if (!store) return;
    const latestConfig = await store.readConfig();
    const state = await enforceWritePolicy(store, latestConfig);
    if (!state || state.status !== "active") return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nYou are Austin. Tony is your peer in the same workspace.\n\n${cooperationPolicy(latestConfig, "austin")}\n\n${formatSharedContext(state)}`,
    };
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.text.trimStart().startsWith("/"))
      return;
    guard.beginUserTurn();
    const currentStore = getStore(ctx.cwd);
    config = await currentStore.readConfig();
    const state = await enforceWritePolicy(currentStore, config);
    if (state?.status === "active" && config.autoDispatch) {
      try {
        await ensureTony(ctx.cwd, ctx.modelRegistry);
        queueMicrotask(() => queueTonyTask(event.text));
      } catch (error) {
        ctx.ui.notify(
          `pi-duo could not dispatch Tony: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
  });

  pi.on("model_select", async (event) => {
    if (!store || !(await store.readState())) return;
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
        const peerArg = parseFlag(args, "peer");
        const goalArg = parseFlag(args, "goal");
        const currentModel = ctx.model;
        if (!currentModel)
          return void ctx.ui.notify("Austin has no active model", "error");
        const austinRef = {
          provider: currentModel.provider,
          modelId: currentModel.id,
        };
        if (
          config.agentA &&
          modelText(config.agentA) !== modelText(austinRef)
        ) {
          return void ctx.ui.notify(
            `Austin is configured as ${modelText(config.agentA)}. Select that Pi model first, or update agentA in .pi-duo/config.json.`,
            "error",
          );
        }
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
        await ensureTony(ctx.cwd, ctx.modelRegistry);
        state = (await currentStore.readState()) ?? state;
        ctx.ui.notify(
          `Duo started: Austin (${modelText(austinRef)}) ↔ Tony (${modelText(peerRef)})`,
          "info",
        );
        pi.sendMessage({
          customType: "pi-duo-peer",
          content: renderStatus(state, config, "austin"),
          display: true,
        });
        return;
      }

      const state = await enforceWritePolicy(currentStore, config);
      if (!state)
        return void ctx.ui.notify("No Duo session. Use /duo start.", "warning");

      if (command === "stop") {
        await disposeTony();
        await currentStore.update((draft) => {
          draft.status = "stopped";
        });
        ctx.ui.notify(
          "Duo stopped; both session histories were preserved",
          "info",
        );
      } else if (command === "resume") {
        await currentStore.update((draft) => {
          draft.status = "active";
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
          if (key === "maxPeerMessagesPerTurn")
            config.maxPeerMessagesPerTurn = Number(value);
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
          "Usage: /duo [start|stop|resume|status|goal|config]",
          "warning",
        );
      }
    },
  });
}
