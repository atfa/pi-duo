import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piDuo, {
  dedupeTranscriptMessages,
  syncTonyProvider,
  transcriptMessageKey,
} from "../index.js";
import {
  isBlockedByFirstSyncBarrier,
  workspaceMutationBlockReason,
} from "../src/coordinator.js";
import { DuoStore } from "../src/store.js";

initTheme(undefined, false);

test("Tony runtime receives only the selected dynamically registered provider", () => {
  const config = { baseUrl: "https://cline.example/v1" };
  const native = { id: "native-provider" };
  const calls: Array<[string, unknown]> = [];
  const registry = {
    getRegisteredProviderConfig: (provider: string) =>
      provider === "cline" ? config : undefined,
    getRegisteredNativeProvider: (provider: string) =>
      provider === "native" ? native : undefined,
  };
  const runtime = {
    registerProvider: (provider: string, value: unknown) =>
      calls.push([provider, value]),
    registerNativeProvider: (provider: unknown) => calls.push(["native", provider]),
  };

  syncTonyProvider(registry as any, runtime as any, "cline");
  syncTonyProvider(registry as any, runtime as any, "native");
  syncTonyProvider(registry as any, runtime as any, "models-json");

  assert.deepEqual(calls, [["cline", config], ["native", native]]);
});

test("transcript dedupe is bounded and never serializes full payloads", () => {
  const make = (index: number) => ({
    role: "assistant",
    timestamp: String(index),
    content: [{
      type: "text",
      text: `message-${index}-${"x".repeat(10_000)}`,
      toJSON() { throw new Error("full serialization is forbidden"); },
    }],
  });
  const messages = Array.from({ length: 200 }, (_, index) => make(index));
  const last = messages.at(-1)!;
  const duplicate = {
    ...last,
    content: [{ type: "text", text: last.content[0].text }],
  };
  assert.doesNotThrow(() => transcriptMessageKey(messages[0]));
  const unique = dedupeTranscriptMessages([...messages, duplicate]);
  assert.ok(unique.length <= 80);
  assert.equal(unique.filter((message) => message.timestamp === "199").length, 1);
});

test("extension registers commands, tools, renderer, and lifecycle hooks without network access", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const renderers: string[] = [];
  const api = {
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerMessageRenderer(name: string) {
      renderers.push(name);
    },
    on(name: string) {
      events.push(name);
    },
  } as unknown as ExtensionAPI;

  piDuo(api);

  assert.deepEqual(tools.sort(), [
    "duo_checkpoint",
    "duo_decisions",
    "duo_goal",
    "duo_plan",
    "duo_send",
    "duo_status",
    "duo_todo",
    "duo_workspace",
  ]);
  assert.deepEqual(commands, ["duo"]);
  assert.deepEqual(renderers, ["pi-duo-peer"]);
  assert.ok(events.includes("session_start"));
  assert.ok(events.includes("before_agent_start"));
  assert.ok(events.includes("input"));
  assert.ok(events.includes("tool_call"));
  assert.ok(events.includes("message_end"));
  assert.ok(events.includes("agent_end"));
});

test("duo_todo mutation does not change collaboration phase", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-todo-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.collaboration = {
        userTurn: 1,
        phase: "converge",
        austinContributed: true,
        tonyContributed: true,
        tonyInitialContribution: true,
        contested: false,
        planRevision: 1,
      };
    });

    const tools = new Map<string, (id: string, params: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const api = {
      registerTool(tool: { name: string; execute: any }) {
        tools.set(tool.name, tool.execute);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      });
    }

    const todoExecute = tools.get("duo_todo");
    assert.ok(todoExecute);

    await todoExecute("1", { action: "add", text: "new work item" });
    let state = await store.readState();
    assert.equal(state?.collaboration?.phase, "converge");
    assert.equal(state?.todo.length, 1);

    await todoExecute("2", { action: "update", id: state!.todo[0].id, status: "in_progress" });
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "converge");
    assert.equal(state?.todo[0].status, "in_progress");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("duo_plan and duo_checkpoint enforce strict phase transitions", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-plan-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.collaboration = {
        userTurn: 1,
        phase: "explore",
        austinContributed: true,
        tonyContributed: false,
        tonyInitialContribution: false,
        contested: false,
        planRevision: 0,
      };
    });

    const tools = new Map<string, (id: string, params: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const notices: string[] = [];
    const api = {
      registerTool(tool: { name: string; execute: any }) {
        tools.set(tool.name, tool.execute);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: { notify: (message: string) => notices.push(message), setStatus: () => {}, setWidget: () => {} },
      });
    }

    const planExecute = tools.get("duo_plan");
    const checkpointExecute = tools.get("duo_checkpoint");
    assert.ok(planExecute);
    assert.ok(checkpointExecute);

    // 1. Plan commit rejected in EXPLORE
    const commitFail = await planExecute("1", { action: "commit", plan: "early plan" });
    assert.match(commitFail.content[0].text, /requires CONVERGE phase/i);
    let state = await store.readState();
    assert.equal(state?.collaboration?.phase, "explore");

    // 2. Ready for verification rejected in EXPLORE or CONVERGE
    const readyFail = await checkpointExecute("2", { action: "ready_for_verification" });
    assert.match(readyFail.content[0].text, /requires EXECUTE phase/i);

    // 3. Move to CONVERGE with bilateral contributions
    await store.update((draft) => {
      draft.collaboration!.phase = "converge";
      draft.collaboration!.tonyContributed = true;
      draft.collaboration!.tonyInitialContribution = true;
      draft.collaboration!.tonyRespondedToAustin = true;
    });

    // 4. Plan commit succeeds in CONVERGE -> EXECUTE
    const commitOk = await planExecute("3", { action: "commit", plan: "agreed plan" });
    assert.match(commitOk.content[0].text, /Phase: EXECUTE/i);
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "execute");

    // 5. With Tony unavailable, no pending review can be created.
    const readyOk = await checkpointExecute("4", { action: "ready_for_verification", summary: "ready" });
    assert.match(readyOk.content[0].text, /Tony is unavailable/i);
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "execute");
    assert.equal(state?.review, undefined);

    // 6. Existing pending review still requires Tony's report before completion.
    await store.update((draft) => {
      draft.collaboration!.phase = "verify";
      draft.review = {
        userTurn: 1,
        status: "pending",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    const completeFail = await checkpointExecute("5", { action: "complete" });
    assert.match(completeFail.content[0].text, /requires a reported Tony verification/i);

    // 7. When review is reported, manual completion succeeds -> COMPLETE
    await store.update((draft) => {
      draft.review!.status = "reported";
    });
    const completeOk = await checkpointExecute("6", { action: "complete" });
    assert.match(completeOk.content[0].text, /Collaboration marked complete/i);
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "complete");
    await store.update((draft) => {
      draft.todo.push({
        id: 1,
        text: "final reconciliation",
        status: "pending",
        owner: "austin",
        updatedAt: new Date().toISOString(),
      });
    });
    assert.equal(
      notices.filter((message) => /彻底完成/.test(message)).length,
      0,
      "verification completion must not notify before Austin's final turn ends",
    );
    for (const handler of events.get("agent_end") || []) await handler();
    assert.equal(
      notices.filter((message) => /彻底完成/.test(message)).length,
      0,
      "open todos trigger reconciliation instead of completion",
    );
    await store.update((draft) => {
      draft.todo[0].status = "done";
      draft.todo[0].updatedAt = new Date().toISOString();
    });
    for (const handler of events.get("agent_end") || []) await handler();
    for (const handler of events.get("agent_end") || []) await handler();
    assert.equal(
      notices.filter((message) => /彻底完成/.test(message)).length,
      1,
      "the final completion notification is emitted once",
    );
    state = await store.readState();
    assert.equal(state?.finalizedUserTurn, 1, "final completion is durable");

    // 8. Reopen returns to EXECUTE and clears review
    const reopenOk = await checkpointExecute("7", { action: "reopen" });
    assert.match(reopenOk.content[0].text, /reopened into EXECUTE phase/i);
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "execute");
    assert.equal(state?.review, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("duo_send with kind does not alter collaboration phase or review status", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-kind-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.collaboration = {
        userTurn: 1,
        phase: "execute",
        austinContributed: true,
        tonyContributed: true,
        tonyInitialContribution: true,
        contested: false,
        planRevision: 1,
      };
    });

    const tools = new Map<string, (id: string, params: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const api = {
      registerTool(tool: { name: string; execute: any }) {
        tools.set(tool.name, tool.execute);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      });
    }

    const sendExecute = tools.get("duo_send");
    assert.ok(sendExecute);

    // 1. Austin sends message with kind="verification" during EXECUTE
    await sendExecute("1", {
      message: "here is test verification evidence",
      kind: "verification",
    });
    let state = await store.readState();
    // Phase must remain EXECUTE, review must not be created or altered
    assert.equal(state?.collaboration?.phase, "execute");
    assert.equal(state?.review, undefined);

    // 2. Austin sends message with kind="finding" during EXECUTE
    await sendExecute("2", {
      message: "here is a finding",
      kind: "finding",
    });
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "execute");
    assert.equal(state?.review, undefined);

    // 3. Existing verification state keeps duo_send phase-neutral.
    const checkpointExecute = tools.get("duo_checkpoint");
    assert.ok(checkpointExecute);
    const unavailable = await checkpointExecute("3", { action: "ready_for_verification", summary: "ready" });
    assert.match(unavailable.content[0].text, /Tony is unavailable/i);
    await store.update((draft) => {
      draft.collaboration!.phase = "verify";
      draft.review = {
        userTurn: 1,
        status: "pending",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "verify");
    assert.equal(state?.review?.status, "pending");

    // 4. Austin sends message with kind="verification" during VERIFY
    await sendExecute("4", {
      message: "more verification evidence",
      kind: "verification",
    });
    state = await store.readState();
    // Phase must remain VERIFY, review status must remain pending (not reported/complete)
    assert.equal(state?.collaboration?.phase, "verify");
    assert.equal(state?.review?.status, "pending");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop tony command unblocks First Collaboration Barrier in EXPLORE", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-stop-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.collaboration = {
        userTurn: 1,
        phase: "explore",
        austinContributed: false,
        tonyContributed: false,
        tonyInitialContribution: false,
        contested: false,
        planRevision: 0,
      };
    });

    let state = await store.readState();
    assert.equal(isBlockedByFirstSyncBarrier("austin", state?.collaboration), true);

    const commands = new Map<string, (args: string, ctx: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const api = {
      registerTool() {},
      registerCommand(name: string, def: { handler: any }) {
        commands.set(name, def.handler);
      },
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      });
    }

    const duoCommand = commands.get("duo");
    assert.ok(duoCommand);

    await duoCommand("stop tony", {
      cwd,
      sessionManager: { getSessionId: () => "mock-session-id" },
      ui: { notify: () => {} },
      isIdle: () => true,
    });

    state = await store.readState();
    assert.equal(state?.collaboration?.degraded, true);
    assert.equal(state?.collaboration?.tonyInitialContribution, true);
    assert.equal(isBlockedByFirstSyncBarrier("austin", state?.collaboration), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Execution Gate blocks Austin project writes in VERIFY and COMPLETE, allows after reopen", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-gate-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.collaboration = {
        userTurn: 1,
        phase: "verify",
        austinContributed: true,
        tonyContributed: true,
        tonyInitialContribution: true,
        contested: false,
        planRevision: 1,
      };
      draft.review = {
        userTurn: 1,
        status: "pending",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    const tools = new Map<string, (id: string, params: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const api = {
      registerTool(tool: { name: string; execute: any }) {
        tools.set(tool.name, tool.execute);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      });
    }

    const [toolCallHandler] = events.get("tool_call") || [];
    assert.ok(toolCallHandler);

    // 1. In VERIFY: Austin project write is blocked
    const verifyBlock = await toolCallHandler({
      toolName: "write",
      input: { path: "src/index.ts" },
    });
    assert.deepEqual(verifyBlock?.block, true);
    assert.match(verifyBlock?.reason ?? "", /under independent verification/i);

    // 2. Transition to COMPLETE
    await store.update((draft) => {
      draft.collaboration!.phase = "complete";
      draft.review!.status = "reported";
    });

    // In COMPLETE: Austin project write is blocked with reopen hint
    const completeBlock = await toolCallHandler({
      toolName: "edit",
      input: { path: "src/index.ts" },
    });
    assert.deepEqual(completeBlock?.block, true);
    assert.match(completeBlock?.reason ?? "", /reopen/i);

    // 3. Austin calls duo_checkpoint reopen -> returns to EXECUTE
    const checkpointExecute = tools.get("duo_checkpoint");
    assert.ok(checkpointExecute);
    const reopenRes = await checkpointExecute("1", { action: "reopen" });
    assert.match(reopenRes.content[0].text, /reopened into EXECUTE phase/i);

    // 4. In EXECUTE: Austin project write is allowed
    const executeAllowed = await toolCallHandler({
      toolName: "write",
      input: { path: "src/index.ts" },
    });
    assert.equal(executeAllowed, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Execution Gate constrains transferable Tony owner but preserves Tony scratch writes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-tony-gate-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.writeConfig({
      ...(await store.readConfig()),
      writePolicy: "transferable",
    });
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.workspaceOwner = "tony";
      draft.collaboration = {
        userTurn: 1,
        phase: "explore",
        austinContributed: true,
        tonyContributed: true,
        tonyInitialContribution: true,
        contested: false,
        planRevision: 1,
      };
    });

    const events = new Map<string, Array<(...args: any[]) => any>>();
    const api = {
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;
    piDuo(api);
    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      });
    }

    const tonyEvents = new Map<string, Array<(...args: any[]) => any>>();
    (api as any).__registerTonyTools({
      registerTool() {},
      on(name: string, handler: any) {
        if (!tonyEvents.has(name)) tonyEvents.set(name, []);
        tonyEvents.get(name)!.push(handler);
      },
    }, 1);
    const [guard] = tonyEvents.get("tool_call") || [];
    assert.ok(guard);

    const explore = await guard({ toolName: "write", input: { path: "src/index.ts" } });
    assert.equal(explore?.block, true);
    assert.match(explore?.reason ?? "", /Only EXECUTE/i);

    await store.update((draft) => { draft.collaboration!.phase = "execute"; });
    assert.equal(await guard({ toolName: "write", input: { path: "src/index.ts" } }), undefined);

    await store.update((draft) => {
      draft.collaboration!.phase = "verify";
      draft.collaboration!.degraded = true;
    });
    const verify = await guard({ toolName: "write", input: { path: "src/index.ts" } });
    assert.equal(verify?.block, true);
    assert.match(verify?.reason ?? "", /verification/i);
    assert.equal(
      await guard({ toolName: "write", input: { path: path.join(store.tonyScratchDir, "check.ts") } }),
      undefined,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("only Tony's second message completes the collaboration handshake", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-handshake-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.writeConfig({ ...(await store.readConfig()), autoDispatch: false });
    await store.update((draft) => { draft.agents.austin.sessionId = "mock-session-id"; });
    const tools = new Map<string, (id: string, params: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const api = {
      registerTool(tool: { name: string; execute: any }) { tools.set(tool.name, tool.execute); },
      registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;
    piDuo(api);
    for (const handler of events.get("session_start") || []) {
      await handler({}, { cwd, sessionManager: { getSessionId: () => "mock-session-id" }, modelRegistry: { find: () => undefined }, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} } });
    }
    for (const handler of events.get("input") || []) {
      await handler({ text: "negotiate", source: "user" }, { cwd, modelRegistry: { find: () => undefined }, ui: { notify: () => {} } });
    }
    const tonyTools = new Map<string, (id: string, params: any) => Promise<any>>();
    (api as any).__registerTonyTools({ registerTool(tool: { name: string; execute: any }) { tonyTools.set(tool.name, tool.execute); }, on() {} }, 1, { isStreaming: false, waitForIdle: async () => {}, sendCustomMessage: async () => {}, messages: [] });
    const austinSend = tools.get("duo_send");
    const tonySend = tonyTools.get("duo_send");
    const plan = tools.get("duo_plan");
    assert.ok(austinSend); assert.ok(tonySend); assert.ok(plan);

    await austinSend("1", { message: "Austin's first proposal", kind: "proposal" });
    await tonySend("2", { message: "Tony's initial proposal", kind: "proposal" });
    let state = await store.readState();
    assert.equal(state?.collaboration?.tonyInitialContribution, true);
    assert.notEqual(state?.collaboration?.tonyRespondedToAustin, true);
    assert.equal(state?.collaboration?.phase, "explore");
    const earlyCommit = await plan("3", { action: "commit", plan: "too early" });
    assert.match(earlyCommit.content[0].text, /requires CONVERGE phase/i);

    await austinSend("4", { message: "Austin's counterproposal", kind: "proposal" });
    await tonySend("5", { message: "Tony's response to Austin", kind: "proposal" });
    state = await store.readState();
    assert.equal(state?.collaboration?.tonyRespondedToAustin, true);
    assert.equal(state?.collaboration?.phase, "converge");
    const commit = await plan("6", { action: "commit", plan: "agreed" });
    assert.match(commit.content[0].text, /Phase: EXECUTE/i);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("EXPLORE collaboration indicator does not use review wording", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-collaboration-indicator-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => { draft.agents.austin.sessionId = "mock-session-id"; });
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const statuses: Array<string | undefined> = [];
    const api = {
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;
    piDuo(api);
    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: {
          notify: () => {},
          setStatus: (_key: string, value: string | undefined) => statuses.push(value),
          setWidget: () => {},
        },
      });
    }
    (api as any).__registerTonyTools({ registerTool() {}, on() {} }, 1, {
      isStreaming: false,
      waitForIdle: async () => {},
      sendCustomMessage: async () => {},
      messages: [],
    });
    for (const handler of events.get("input") || []) {
      await handler(
        { text: "explore a fix", source: "user" },
        { cwd, modelRegistry: { find: () => undefined }, ui: { notify: () => {} } },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(statuses.every((status) => !status?.includes("审查")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("verification queue fails a pending review when Tony disappears after send", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-review-race-test-"));
  try {
    const tools = new Map<string, (id: string, params: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const api = {
      registerTool(tool: { name: string; execute: any }) { tools.set(tool.name, tool.execute); },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;
    piDuo(api);
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.collaboration = {
        userTurn: 1,
        phase: "execute",
        austinContributed: true,
        tonyContributed: true,
        tonyInitialContribution: true,
        contested: false,
        planRevision: 1,
      };
    });
    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      });
    }
    const tonyApi = { registerTool() {}, on() {} } as unknown as ExtensionAPI;
    const replacement = {
      isStreaming: false,
      waitForIdle: async () => {},
      sendCustomMessage: async () => {},
      messages: [],
    };
    const activeTony = {
      isStreaming: false,
      waitForIdle: async () => {},
      sendCustomMessage: async () => {
        (api as any).__registerTonyTools(tonyApi, 1, replacement);
      },
      messages: [],
    };
    (api as any).__registerTonyTools(tonyApi, 1, activeTony);
    const checkpoint = tools.get("duo_checkpoint");
    assert.ok(checkpoint);
    await checkpoint("1", { action: "ready_for_verification" });

    for (let attempts = 0; attempts < 20; attempts++) {
      if ((await store.readState())?.review?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const review = (await store.readState())?.review;
    assert.equal(review?.status, "failed");
    assert.match(
      review?.error ?? "",
      /Tony became unavailable before verification could start/,
    );
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("Tony reviewFinding returns collaboration to EXECUTE, clears review, and allows fresh verification", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-finding-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
    });

    const tools = new Map<string, (id: string, params: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const sentMessages: any[] = [];
    const api = {
      registerTool(tool: { name: string; execute: any }) {
        tools.set(tool.name, tool.execute);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage(msg: any, opts: any) {
        sentMessages.push({ msg, opts });
      },
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
      });
    }

    // 1. Establish user turn 1 via input handler
    for (const handler of events.get("input") || []) {
      await handler(
        { text: "implement feature X", source: "user" },
        {
          cwd,
          modelRegistry: { find: () => undefined },
          ui: { notify: () => {} },
        },
      );
    }

    // 2. Set up bilateral contributions and move to EXECUTE
    await store.update((draft) => {
      draft.collaboration!.tonyContributed = true;
      draft.collaboration!.tonyInitialContribution = true;
      draft.collaboration!.austinContributed = true;
      draft.collaboration!.tonyRespondedToAustin = true;
      draft.collaboration!.phase = "execute";
    });

    // 3. Model the active verification that an available Tony started.
    const checkpointExecute = tools.get("duo_checkpoint");
    assert.ok(checkpointExecute);
    const readyRes1 = await checkpointExecute("1", {
      action: "ready_for_verification",
      summary: "First deliverable ready",
    });
    assert.match(readyRes1.content[0].text, /Tony is unavailable/i);
    await store.update((draft) => {
      draft.collaboration!.phase = "verify";
      draft.review = {
        userTurn: 1,
        status: "pending",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    let state = await store.readState();
    assert.equal(state?.collaboration?.phase, "verify");
    assert.equal(state?.review?.status, "pending");
    assert.equal(state?.review?.userTurn, 1);

    // Register Tony's tools for turn 1
    const tonyTools = new Map<string, (id: string, params: any) => Promise<any>>();
    const tonyApi = {
      registerTool(tool: { name: string; execute: any }) {
        tonyTools.set(tool.name, tool.execute);
      },
      on() {},
    } as unknown as ExtensionAPI;
    (api as any).__registerTonyTools(tonyApi, 1);

    const tonySend = tonyTools.get("duo_send");
    assert.ok(tonySend);

    // 4. Tony sends reviewFinding
    const sendRes = await tonySend("2", {
      reviewFinding: true,
      message: "Found bug in auth validation",
      kind: "finding",
    });
    assert.match(sendRes.content[0].text, /returned to EXECUTE/i);

    // 5. Verify state: phase is execute, review is deleted
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "execute");
    assert.equal(state?.review, undefined);

    // Austin was steered with verification finding message
    const findingNotice = sentMessages.find((m) =>
      m.msg.content.includes("Verification found actionable defects"),
    );
    assert.ok(findingNotice);
    assert.deepEqual(findingNotice.opts, { triggerTurn: true, deliverAs: "steer" });

    // 6. Austin project write is allowed in EXECUTE
    const [toolCallHandler] = events.get("tool_call") || [];
    assert.ok(toolCallHandler);
    const writeAllowed = await toolCallHandler({
      toolName: "write",
      input: { path: "src/auth.ts" },
    });
    assert.equal(writeAllowed, undefined);

    // 7. A new request is rejected cleanly until Tony is resumed.
    const readyRes2 = await checkpointExecute("3", {
      action: "ready_for_verification",
      summary: "Fixed auth validation bug",
    });
    assert.match(readyRes2.content[0].text, /Tony is unavailable/i);

    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "execute");
    assert.equal(state?.review, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ensureTony failure initializes new turn state in explore and degrades gracefully", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-ensure-fail-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    // Old collaboration from turn 1 was complete
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.collaboration = {
        userTurn: 1,
        phase: "complete",
        austinContributed: true,
        tonyContributed: true,
        tonyInitialContribution: true,
        contested: false,
        planRevision: 1,
      };
      draft.review = {
        userTurn: 1,
        status: "reported",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    const events = new Map<string, Array<(...args: any[]) => any>>();
    const sentMessages: any[] = [];
    const statuses: Array<string | undefined> = [];
    const api = {
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer() {},
      sendMessage(msg: any, opts: any) {
        sentMessages.push({ msg, opts });
      },
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    for (const handler of events.get("session_start") || []) {
      await handler({}, {
        cwd,
        sessionManager: { getSessionId: () => "mock-session-id" },
        modelRegistry: { find: () => undefined },
        ui: {
          notify: () => {},
          setStatus: (_key: string, value: string | undefined) => statuses.push(value),
          setWidget: () => {},
        },
      });
    }

    // User inputs new task for turn 2, but ensureTony fails (modelRegistry.find returns undefined)
    for (const handler of events.get("input") || []) {
      await handler(
        { text: "implement feature Y", source: "user" },
        {
          cwd,
          modelRegistry: { find: () => undefined },
          ui: { notify: () => {} },
        },
      );
    }

    const state = await store.readState();
    // Turn 2 must have its own state, in explore, degraded, not turn 1 complete!
    assert.equal(state?.collaboration?.userTurn, 2);
    assert.equal(state?.collaboration?.phase, "explore");
    assert.equal(state?.collaboration?.degraded, true);
    assert.equal(state?.collaboration?.tonyInitialContribution, true);
    assert.equal(state?.review, undefined);

    // Austin was steered with Tony unavailable notice
    const unavailableNotice = sentMessages.find((m) =>
      m.msg.content.includes("[Tony unavailable]"),
    );
    assert.ok(unavailableNotice);
    assert.deepEqual(unavailableNotice.opts, { triggerTurn: true, deliverAs: "steer" });
    assert.ok(statuses.every((status) => !status?.includes("协作不可用，已降级为单 Agent")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("duo mode auto-opens a persistent non-capturing workbench overlay", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-workbench-open-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );

    const commands = new Map<string, (args: string, ctx: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const overlayCalls: Array<{ options: any; sourceOptions: any; component: any }> = [];
    let renderRequests = 0;
    let hidden = 0;
    let customSettled = 0;
    let handleHides = 0;
    let onHandleCalls = 0;
    let maxStackDepth = 0;
    const widgets = new Map<string, { content: any; options: any }>();
    const terminal = { rows: 40, columns: 120 };

    // Faithful model of pi-tui's REAL overlay semantics, not just pi 0.86's
    // `ExtensionUIContext` shape:
    //   - overlays live on a LIFO stack;
    //   - the handle's `hide()` is ENTRY-TARGETED (splices its own entry);
    //   - `TUI.hideOverlay()` (what `done()` calls) pops the TOPMOST entry
    //     only and no-ops on an empty stack;
    //   - `onHandle` fires only after the factory resolves.
    // The committed test previously modelled none of this, so it could not
    // detect the topmost-pop hazard it claimed to guard.
    const stack: Array<{ handle: { hide: () => void } }> = [];
    // Captures the `done` of the most recent non-workbench overlay (history),
    // so a test can dismiss it the way a user pressing ESC would.
    let dismissTopModal: (() => void) | undefined;

    const ui = {
      notify: () => {},
      setStatus: () => {},
      setWidget: (key: string, content: any, options: any) => {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, { content, options });
      },
      custom: (factory: any, options: any) => {
        const tui = {
          requestRender: () => { renderRequests++; },
          terminal,
        };
        let closed = false;
        let entry: { handle: { hide: () => void } } | undefined;
        let resolveCustom: () => void = () => {};
        const done = () => {
          if (closed) return; // pi guards against a double close
          closed = true;
          // Pi's custom() teardown is asynchronous. Model that boundary so a
          // stop → start test catches a second overlay being opened too early.
          queueMicrotask(() => {
            if (stack.length > 0) {
              hidden++;
              stack.pop(); // topmost-only pop, exactly like hideOverlay()
            }
            customSettled++;
            resolveCustom();
          });
        };
        const component = factory(tui, {}, {}, done);
        // pi resolves `overlayOptions` AFTER the factory runs, so a function
        // sees the row budget the factory applied. Mirror that ordering.
        const resolved =
          typeof options.overlayOptions === "function"
            ? options.overlayOptions()
            : options.overlayOptions;
        overlayCalls.push({ component, sourceOptions: options, options: { ...options, overlayOptions: resolved } });
        entry = {
          handle: {
            hide: () => {
              const index = stack.indexOf(entry!);
              if (index !== -1) {
                stack.splice(index, 1);
                handleHides++;
              }
            },
          },
        };
        stack.push(entry);
        maxStackDepth = Math.max(maxStackDepth, stack.length);
        options.onHandle?.(entry.handle);
        onHandleCalls++;
        // The first overlay opened is the workbench (`/duo start`). Any later
        // one is the history modal, whose `done` a test can invoke to emulate
        // the user pressing ESC.
        if (overlayCalls.length > 1) dismissTopModal = done;
        return new Promise<void>((resolve) => {
          resolveCustom = resolve;
        });
      },
    };

    const api = {
      async setModel() { return true; },
      registerTool() {},
      registerCommand(name: string, command: { handler: any }) {
        commands.set(name, command.handler);
      },
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    const dynamicProviderConfig = { baseUrl: "https://cline.example/v1" };
    const ctx = {
      cwd,
      mode: "tui",
      ui,
      isIdle: () => true,
      abort: () => {},
      model: { provider: "provider-a", id: "model/a" },
      hasUI: true,
      sessionManager: {
        getSessionId: () => "mock-session-id",
        getSessionFile: () => undefined,
      },
      modelRegistry: {
        find: () => ({ provider: "provider-b", id: "model/b" }),
        getAvailable: () => [],
        getRegisteredProviderConfig: (provider: string) =>
          provider === "provider-b" ? dynamicProviderConfig : undefined,
        getRegisteredNativeProvider: () => undefined,
      },
    };

    const handler = commands.get("duo");
    assert.ok(handler, "/duo command must be registered");

    // `foregroundUI` is established by pi's own session_start hook, exactly as
    // in production. Firing it also exercises the state-restore path.
    for (const onSessionStart of events.get("session_start") || []) {
      await onSessionStart({}, ctx);
    }

    // `/duo start` must leave the panel visible without any extra command.
    await handler("start", ctx);
    assert.equal(overlayCalls.length, 1, "starting duo mode opens the workbench");
    let duoState = await store.readState();
    let duoConfig = await store.readConfig();
    assert.equal(duoState?.agents.tony.provider, "provider-a");
    assert.equal(duoState?.agents.tony.modelId, "model/a");
    assert.deepEqual(duoConfig.agentA, duoConfig.agentB);

    const call = overlayCalls[0];
    assert.equal(call.options.overlay, true, "workbench is mounted as an overlay");
    // Non-capturing is the whole point: the editor keeps keyboard focus so the
    // user can type the next task while watching both columns.
    assert.equal(call.options.overlayOptions.nonCapturing, true);
    // Top-anchored full-width geometry occupies the upper display region.
    assert.equal(call.options.overlayOptions.anchor, "top-left");
    assert.equal(call.options.overlayOptions.row, 0);
    assert.equal(call.options.overlayOptions.col, 0);
    assert.equal(call.options.overlayOptions.width, "100%");
    // A non-capturing overlay still composites blank body rows over its
    // underlying content, so it must reserve Pi's input dock.
    assert.equal(call.options.overlayOptions.maxHeight, 34);
    terminal.rows = 30;
    assert.equal(
      call.sourceOptions.overlayOptions().maxHeight,
      24,
      "the overlay option reuses the live dock-aware row budget after resize",
    );
    terminal.rows = 40;
    // pi's own `showOverlay` repaints when the overlay is installed, so no
    // eager render call is needed at open time. What matters is that streaming
    // refreshes are wired to the REAL TUI handed to the factory.
    assert.equal(renderRequests, 0, "no redundant eager render at open time");

    await handler("model --austin provider-b/model/b", ctx);
    duoState = await store.readState();
    duoConfig = await store.readConfig();
    assert.equal(duoState?.agents.austin.provider, "provider-b");
    assert.equal(duoState?.agents.tony.provider, "provider-a");
    assert.deepEqual(duoConfig.agentA, { provider: "provider-b", modelId: "model/b" });

    const tonyEvents: string[] = [];
    (api as any).__registerTonyTools(
      { registerTool() {}, on() {} },
      undefined,
      {
        isStreaming: false,
        modelRuntime: {
          registerProvider: (provider: string, config: unknown) => {
            assert.equal(provider, "provider-b");
            assert.equal(config, dynamicProviderConfig);
            tonyEvents.push("register");
          },
          registerNativeProvider: () => assert.fail("unexpected native provider"),
        },
        setModel: async () => {
          assert.deepEqual(tonyEvents, ["register"]);
          tonyEvents.push("setModel");
        },
      },
    );
    await handler("model provider-b/model/b", ctx);
    duoState = await store.readState();
    duoConfig = await store.readConfig();
    assert.equal(duoState?.agents.austin.provider, "provider-b");
    assert.equal(duoState?.agents.tony.provider, "provider-b");
    assert.deepEqual(duoConfig.agentA, duoConfig.agentB);
    assert.deepEqual(tonyEvents, ["register", "setModel"]);

    // The panel is a live component, not a blocked dialog: it renders rows and
    // never declares an input handler.
    const austinDocument = (call.component as any).austinDocument;
    const originalAustinRender = austinDocument.render.bind(austinDocument);
    let austinRenderCount = 0;
    austinDocument.render = (width: number) => {
      austinRenderCount++;
      return originalAustinRender(width);
    };
    const rows = call.component.render(120);
    assert.ok(Array.isArray(rows) && rows.length > 0);
    assert.equal(
      austinRenderCount,
      1,
      "one workbench frame renders Austin's scroll tree exactly once",
    );
    assert.equal(
      rows.length,
      34,
      "an empty workbench leaves the reserved native dock below the overlay",
    );
    const spacer = widgets.get("pi-duo-workbench-spacer");
    assert.ok(spacer, "an empty native transcript needs a dock spacer below the overlay");
    const spacerComponent = spacer.content({}, {});
    assert.equal(spacerComponent.render(120).length, 34);
    assert.equal(austinRenderCount, 2, "the initial stable spacer samples Austin once");
    assert.equal(spacerComponent.render(120).length, 34);
    assert.equal(austinRenderCount, 2, "unchanged frames reuse the stable spacer sample");
    terminal.rows = 30;
    assert.equal(spacerComponent.render(120).length, 24);
    assert.equal(austinRenderCount, 3, "terminal resize takes one new stable sample");
    terminal.rows = 40;
    assert.equal(call.component.handleInput, undefined);
    assert.equal(typeof call.component.invalidate, "function");

    // Runtime activity, not the durable collaboration phase, owns the spinner.
    for (const onAgentStart of events.get("agent_start") || []) {
      await onAgentStart({});
    }
    let panelText = call.component.render(120).join("\n");
    assert.match(panelText, /◐ Austin 正在工作/);
    for (const onAgentEnd of events.get("agent_end") || []) {
      await onAgentEnd({});
    }
    panelText = call.component.render(120).join("\n");
    assert.doesNotMatch(panelText, /◐ Austin 正在工作/);

    // Pi emits these extension events before SessionManager appends them. The
    // first turn must therefore be visible in its column without waiting for
    // a disk round-trip, and an ended assistant must not blink out in between.
    const austinUser = { role: "user", content: "Austin first turn" };
    const austinAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "Austin first reply" }],
    };
    for (const onStart of events.get("message_start") || []) {
      onStart({ message: austinUser });
    }
    const countBeforeUserLayout = austinRenderCount;
    assert.ok(spacerComponent.render(120).length < 34);
    assert.equal(
      austinRenderCount,
      countBeforeUserLayout + 1,
      "a complete user message recalibrates the spacer once",
    );
    let transcript = (call.component as any).austinDocument.render(59).join("\n");
    assert.match(transcript, /Austin first turn/);

    for (const onStart of events.get("message_start") || []) {
      onStart({ message: austinAssistant });
    }
    const streamingSpacerRows = spacerComponent.render(120).length;
    const countBeforeStream = austinRenderCount;
    for (const onUpdate of events.get("message_update") || []) {
      onUpdate({
        message: austinAssistant,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
      });
    }
    assert.equal(spacerComponent.render(120).length, streamingSpacerRows);
    assert.equal(
      austinRenderCount,
      countBeforeStream,
      "stream deltas do not remeasure or reflow the native dock",
    );
    for (const onEnd of events.get("message_end") || []) {
      onEnd({ message: austinAssistant });
    }
    spacerComponent.render(120);
    assert.equal(
      austinRenderCount,
      countBeforeStream + 1,
      "message completion takes one new stable sample",
    );
    transcript = (call.component as any).austinDocument.render(59).join("\n");
    assert.match(transcript, /Austin first reply/);

    // A streaming delta must repaint through the factory's TUI (the only
    // repaint channel that exists on pi 0.86's UI context).
    for (const onStart of events.get("message_start") || []) {
      onStart({ message: { role: "assistant" } });
    }
    for (const onUpdate of events.get("message_update") || []) {
      onUpdate({
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
      });
    }
    assert.ok(renderRequests > 0, "streaming repaints through the factory TUI");

    // The workbench must be installed as an overlay whose handle was delivered,
    // so the defensive teardown path is not dead code.
    assert.equal(onHandleCalls, 1, "onHandle fires for the workbench overlay");

    // ---- single-overlay ownership: /duo history must not stack ----
    // The workbench is open now. `/duo history` closes it BEFORE opening the
    // history overlay; if it did not, the stack would hold 2 pi-duo overlays
    // and the topmost-only `hideOverlay()` could later tear down the wrong one.
    const historyPromise = handler("history", ctx);
    // A modal's custom() promise does not settle until dismissed, so assert the
    // ordering while it is open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(maxStackDepth, 1, "pi-duo never holds 2 overlays at once");
    assert.equal(stack.length, 1, "history owns the stack alone");
    assert.equal(
      customSettled,
      1,
      "workbench settled before history took ownership",
    );
    assert.equal(hidden, 1, "history closed the workbench exactly once");

    // Dismiss history (ESC) and confirm it drains to zero without resurrecting
    // anything, then let the awaited handler finish.
    assert.ok(dismissTopModal, "history exposes a dismiss path");
    dismissTopModal!();
    await historyPromise;
    assert.equal(
      stack.length,
      1,
      "workbench is restored after history closes",
    );
    assert.equal(
      customSettled,
      2,
      "history settled exactly once when dismissed",
    );

    // `/duo view` toggles the panel off and then back on. The restored
    // workbench is topmost, so closing it must pop exactly one entry.
    await handler("view", ctx);
    assert.equal(customSettled, 3, "closing the workbench settles it once");
    // Three topmost pops so far: the pre-history workbench close, the history
    // dismiss, and this toggle-off. Any extra pop would mean a double-remove.
    assert.equal(hidden, 3, "each close pops exactly one overlay entry");

    await handler("view", ctx);
    assert.equal(overlayCalls.length, 4, "toggling again reopens the panel");

    // `/duo stop` must not leave a stale overlay behind.
    await handler("stop", ctx);
    assert.equal(stack.length, 0, "stopping duo mode removes every overlay");
    assert.equal(widgets.has("pi-duo-workbench-spacer"), false);
    const overlaysAfterStop = overlayCalls.length;
    await handler("view", ctx);
    assert.equal(
      overlayCalls.length,
      overlaysAfterStop,
      "a stopped Duo cannot show a misleading empty workbench",
    );
    // A fresh start immediately after an asynchronous close waits for the old
    // `custom()` promise rather than stacking a second full-screen overlay.
    await handler("start", ctx);
    assert.equal(overlayCalls.length, overlaysAfterStop + 1);
    assert.equal(stack.length, 1);
    assert.equal(handleHides, 0, "the happy path never double-removes");
    assert.equal(
      maxStackDepth,
      1,
      "pi-duo never held two overlays at any point in this scenario",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("/duo history does not resurrect a workbench that was already hidden", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-hist-norestore-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );

    const commands = new Map<string, (args: string, ctx: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    let overlayOpens = 0;
    let dismissTopModal: (() => void) | undefined;

    const ui = {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      custom: (factory: any, options: any) => {
        overlayOpens++;
        const tui = {
          requestRender: () => {},
          terminal: { rows: 40, columns: 120 },
        };
        let resolveCustom: () => void = () => {};
        const component = factory(tui, {}, {}, () => resolveCustom());
        void component;
        if (typeof options.overlayOptions === "function") options.overlayOptions();
        const done = () => resolveCustom();
        if (overlayOpens > 1) dismissTopModal = done;
        return new Promise<void>((resolve) => {
          resolveCustom = resolve;
        });
      },
    };

    const api = {
      registerTool() {},
      registerCommand(name: string, command: { handler: any }) {
        commands.set(name, command.handler);
      },
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    const ctx: any = {
      cwd,
      mode: "tui",
      ui,
      isIdle: () => true,
      abort: () => {},
      hasUI: true,
      model: { provider: "provider-a", id: "model/a" },
      sessionManager: {
        getSessionId: () => "mock-session-id",
        getSessionFile: () => undefined,
      },
      modelRegistry: {
        find: () => ({ provider: "provider-b", id: "model/b" }),
        getAvailable: () => [],
      },
    };

    const handler = commands.get("duo")!;
    for (const onSessionStart of events.get("session_start") || []) {
      await onSessionStart({}, ctx);
    }
    await handler("start", ctx);
    assert.equal(overlayOpens, 1, "workbench auto-opens on start");

    // Hide it first: the user explicitly closed the workbench, so history must
    // not bring it back. This is the guard against over-restoring.
    await handler("view", ctx);

    const before = overlayOpens;
    const historyPromise = handler("history", ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(dismissTopModal, "history opened");
    dismissTopModal!();
    await historyPromise;

    assert.equal(
      overlayOpens,
      before + 1,
      "history opened but the hidden workbench was NOT restored",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("automatic workbench opening stays silent in a non-TUI host", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-workbench-silent-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );

    const commands = new Map<string, (args: string, ctx: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const notices: Array<{ message: string; type?: string }> = [];

    // A RPC/print-style host: `notify` exists but there is no `custom`, so
    // the workbench genuinely cannot be displayed.
    const ui = {
      notify: (message: string, type?: string) => { notices.push({ message, type }); },
      setStatus: () => {},
      setWidget: () => {},
    };

    const api = {
      registerTool() {},
      registerCommand(name: string, command: { handler: any }) {
        commands.set(name, command.handler);
      },
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    const handler = commands.get("duo");
    assert.ok(handler);

    // Resuming an active session is an *automatic* open point: the user never
    // asked for the workbench. In a non-TUI host this must degrade silently
    // rather than emitting an unsolicited error.
    for (const onSessionStart of events.get("session_start") || []) {
      await onSessionStart({}, {
        cwd,
        mode: "rpc",
        ui,
        sessionManager: {
          getSessionId: () => "mock-session-id",
          getSessionFile: () => undefined,
        },
        modelRegistry: { find: () => undefined, getAvailable: () => [] },
        isIdle: () => true,
        abort: () => {},
      });
    }

    assert.equal(
      notices.filter((n) => /requires TUI mode/.test(n.message)).length,
      0,
      "automatic open must not report a TUI-mode error",
    );

    await handler("status", {
      cwd,
      mode: "rpc",
      ui,
      isIdle: () => true,
      abort: () => {},
      sessionManager: {
        getSessionId: () => "mock-session-id",
        getSessionFile: () => undefined,
      },
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
    });
    assert.ok(
      notices.some((n) => /^Duo: active/.test(n.message)),
      "/duo status must remain visible above the workbench overlay",
    );

    // An explicit request, by contrast, is allowed to explain the limitation.
    await handler("workbench", {
      cwd,
      mode: "rpc",
      ui,
      isIdle: () => true,
      abort: () => {},
      sessionManager: {
        getSessionId: () => "mock-session-id",
        getSessionFile: () => undefined,
      },
      modelRegistry: { find: () => undefined, getAvailable: () => [] },
    });

    assert.ok(
      notices.some((n) => /requires TUI mode/.test(n.message)),
      "an explicit /duo workbench request should explain the limitation",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("streaming deltas coalesce workbench redraws without delaying the first frame", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-workbench-throttle-"));
  const originalReadState = DuoStore.prototype.readState;
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );

    // Count every disk-backed state read. The render path must not call this:
    // it renders from the in-memory accumulator.
    let reads = 0;
    DuoStore.prototype.readState = function (this: DuoStore, ...args: any[]) {
      reads++;
      return (originalReadState as any).apply(this, args);
    };

    const commands = new Map<string, (args: string, ctx: any) => Promise<any>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    let renderRequests = 0;
    let panel: any;
    const ui = {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
      custom: (factory: any) => {
        const tui = {
          requestRender: () => { renderRequests++; },
          terminal: { rows: 40, columns: 120 },
        };
        panel = factory(tui, {}, {}, () => {});
        return new Promise<void>(() => {});
      },
    };

    const api = {
      registerTool() {},
      registerCommand(name: string, command: { handler: any }) {
        commands.set(name, command.handler);
      },
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    const ctx = {
      cwd,
      mode: "tui",
      ui,
      isIdle: () => true,
      abort: () => {},
      model: { provider: "provider-a", id: "model/a" },
      hasUI: true,
      sessionManager: {
        getSessionId: () => "mock-session-id",
        getSessionFile: () => undefined,
      },
      modelRegistry: {
        find: () => ({ provider: "provider-b", id: "model/b" }),
        getAvailable: () => [],
      },
    };

    for (const onSessionStart of events.get("session_start") || []) {
      await onSessionStart({}, ctx);
    }
    await commands.get("duo")!("start", ctx);

    // Measure only the streaming burst.
    reads = 0;

    const DELTAS = 300;
    for (const onStart of events.get("message_start") || []) {
      onStart({ message: { role: "assistant" } });
    }
    assert.equal(renderRequests, 1, "message_start renders the first frame immediately");
    for (let i = 0; i < DELTAS; i++) {
      for (const onUpdate of events.get("message_update") || []) {
        onUpdate({
          message: { role: "assistant" },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "x",
          },
        });
      }
    }

    assert.equal(renderRequests, 1, "a synchronous delta burst is coalesced");

    // The regression this guards: an unthrottled path read the store once per
    // delta per agent. Anything close to DELTAS means the throttle is dead.
    assert.ok(
      reads < 10,
      `${DELTAS} deltas caused ${reads} disk reads; the throttle is not holding`,
    );

    // One trailing repaint catches the final delta without rebuilding the
    // entire native component tree once per token.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(renderRequests, 2, "the final delta gets one trailing render");

    // Each update is a distinct assistant object. It must replace the one
    // start entry, not become another visible transcript message.
    const started = {
      role: "assistant",
      content: [{ type: "text", text: "stream started" }],
    };
    const finished = {
      role: "assistant",
      content: [{ type: "text", text: "stream finished" }],
    };
    for (const onStart of events.get("message_start") || []) {
      onStart({ message: started });
    }
    for (const onUpdate of events.get("message_update") || []) {
      onUpdate({
        message: { role: "assistant", content: [{ type: "text", text: "delta" }] },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "delta" },
      });
    }
    for (const onEnd of events.get("message_end") || []) {
      onEnd({ message: finished });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const transcript = (panel as any).austinDocument.render(59).join("\n");
    assert.equal((transcript.match(/stream finished/g) || []).length, 1);
    assert.doesNotMatch(
      transcript,
      /stream started|^delta$/m,
      "superseded assistant snapshots must not survive beside the final message",
    );

    // SessionManager may return a cloned object, so identity-only merging must
    // not render the same user turn twice either.
    const userText = "same user turn";
    for (const onStart of events.get("message_start") || []) {
      onStart({ message: { role: "user", content: userText } });
    }
    for (const onEnd of events.get("message_end") || []) {
      onEnd({ message: { role: "user", content: userText } });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const userTranscript = (panel as any).austinDocument.render(59).join("\n");
    assert.equal((userTranscript.match(/same user turn/g) || []).length, 1);

    // Native transcript rendering has no store-backed footer, so the stream
    // must not schedule a trailing disk read either.
    assert.equal(reads, 0, `native transcript unexpectedly read state ${reads} times`);
  } finally {
    DuoStore.prototype.readState = originalReadState;
    await rm(cwd, { recursive: true, force: true });
  }
});

async function closeoutRecoveryHarness(
  phase: "explore" | "execute" = "execute",
  recoverOnStart = false,
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-closeout-test-"));
  const store = new DuoStore(cwd);
  await store.create(
    { provider: "provider-a", modelId: "model/a" },
    { provider: "provider-b", modelId: "model/b" },
  );
  await store.update((draft) => {
    draft.agents.austin.sessionId = "closeout-session";
    draft.collaboration = {
      userTurn: 1,
      phase: recoverOnStart ? phase : "complete",
      austinContributed: true,
      tonyContributed: true,
      tonyInitialContribution: true,
      tonyRespondedToAustin: true,
      contested: false,
      planRevision: 1,
    };
    if (!recoverOnStart) {
      draft.review = { userTurn: 1, status: "reported", updatedAt: new Date().toISOString() };
    }
  });

  const events = new Map<string, Array<(...args: any[]) => any>>();
  const sent: Array<{ message: any; options: any }> = [];
  const notices: string[] = [];
  const api = {
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
    on(name: string, handler: any) {
      if (!events.has(name)) events.set(name, []);
      events.get(name)!.push(handler);
    },
  } as unknown as ExtensionAPI;
  piDuo(api);
  for (const handler of events.get("session_start") || []) {
    await handler({}, {
      cwd,
      sessionManager: { getSessionId: () => "closeout-session" },
      modelRegistry: { find: () => undefined },
      ui: {
        notify: (message: string) => notices.push(message),
        setStatus() {},
        setWidget() {},
      },
    });
  }
  if (!recoverOnStart) {
    await store.update((draft) => {
      if (draft.collaboration) draft.collaboration.phase = phase;
      delete draft.review;
    });
    sent.length = 0;
    notices.length = 0;
  }
  const emit = async (name: string, event: any = {}) => {
    for (const handler of events.get(name) || []) await handler(event);
  };
  return { cwd, store, sent, notices, emit };
}

test("session restore resumes an interrupted EXECUTE closeout", async () => {
  const harness = await closeoutRecoveryHarness("execute", true);
  try {
    assert.equal(
      harness.sent.filter(({ message }) =>
        message.customType === "pi-duo-closeout-recovery"
      ).length,
      1,
    );
    assert.equal(
      (await harness.store.readState())?.collaboration?.closeoutRecoveryAttempts,
      1,
    );
  } finally {
    await rm(harness.cwd, { recursive: true, force: true });
  }
});

test("EXECUTE agent end recovers empty Austin closeout twice, then pauses", async () => {
  const harness = await closeoutRecoveryHarness();
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      await harness.emit("agent_start");
      await harness.emit("message_end", {
        message: { role: "assistant", content: [], stopReason: "stop" },
      });
      await harness.emit("agent_end");
      const recovery = harness.sent.filter(({ message }) =>
        message.customType === "pi-duo-closeout-recovery"
      );
      assert.equal(recovery.length, attempt);
      assert.match(recovery.at(-1)!.message.content, /response was empty/i);
      assert.deepEqual(recovery.at(-1)!.options, {
        triggerTurn: true,
        deliverAs: "followUp",
      });
    }

    await harness.emit("agent_start");
    await harness.emit("message_end", {
      message: { role: "assistant", content: [], stopReason: "stop" },
    });
    await harness.emit("agent_end");
    assert.equal(
      harness.sent.filter(({ message }) =>
        message.customType === "pi-duo-closeout-recovery"
      ).length,
      2,
    );
    assert.ok(harness.notices.some((message) => /两次自动推进/.test(message)));
    const state = await harness.store.readState();
    assert.equal(state?.collaboration?.closeoutRecoveryAttempts, 2);
    assert.equal(state?.collaboration?.closeoutRecoveryPaused, true);
  } finally {
    await rm(harness.cwd, { recursive: true, force: true });
  }
});

test("idle EXPLORE Austin is automatically recovered", async () => {
  const harness = await closeoutRecoveryHarness("explore");
  try {
    await harness.emit("agent_start");
    await harness.emit("agent_end");
    const recovery = harness.sent.find(({ message }) =>
      message.customType === "pi-duo-closeout-recovery"
    );
    assert.ok(recovery);
    assert.match(recovery.message.content, /EXPLORE.*duo_send.*duo_plan/i);
    assert.equal(
      (await harness.store.readState())?.collaboration?.closeoutRecoveryAttempts,
      1,
    );
  } finally {
    await rm(harness.cwd, { recursive: true, force: true });
  }
});

test("recovery retries reset when the collaboration phase advances and never wake reported completion", async () => {
  const harness = await closeoutRecoveryHarness("explore");
  try {
    for (let index = 0; index < 2; index++) {
      await harness.emit("agent_start");
      await harness.emit("agent_end");
    }
    await harness.store.update((draft) => { draft.collaboration!.phase = "execute"; });
    await harness.emit("agent_start");
    await harness.emit("agent_end");
    const state = await harness.store.readState();
    assert.equal(state?.collaboration?.closeoutRecoveryAttempts, 1);
    assert.equal(state?.collaboration?.closeoutRecoveryPhase, "execute");

    await harness.store.update((draft) => {
      draft.collaboration!.phase = "complete";
      draft.review = { userTurn: 1, status: "reported", updatedAt: new Date().toISOString() };
    });
    const sent = harness.sent.length;
    await harness.emit("agent_end");
    assert.equal(harness.sent.length, sent);
  } finally {
    await rm(harness.cwd, { recursive: true, force: true });
  }
});

// --- Bug: the write guard leaked across sessions ----------------------------

/**
 * Builds an extension harness on a fresh temp cwd and returns the captured
 * `tool_call` handlers plus the store, so write-guard behavior can be asserted
 * directly. `sessionId` is what pi's `sessionManager.getSessionId()` reports
 * for the *current* session - the whole point of these tests is to make it
 * differ from the session recorded in the shared duo state.
 */
async function writeGuardHarness(options: {
  sessionId: string;
  recordedAustinSessionId: string;
  status?: "active" | "stopped";
  tonyInitialContribution?: boolean;
}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-guard-test-"));
  const store = new DuoStore(cwd);
  await store.create(
    { provider: "provider-a", modelId: "model/a" },
    { provider: "provider-b", modelId: "model/b" },
  );
  await store.update((draft) => {
    draft.agents.austin.sessionId = options.recordedAustinSessionId;
    draft.status = options.status ?? "active";
    draft.workspaceOwner = "austin";
    draft.collaboration = {
      userTurn: 1,
      phase: "explore",
      austinContributed: true,
      tonyContributed: false,
      tonyInitialContribution: options.tonyInitialContribution ?? false,
      contested: false,
      planRevision: 0,
    };
  });

  const events = new Map<string, Array<(...args: any[]) => any>>();
  const api = {
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage() {},
    on(name: string, handler: any) {
      if (!events.has(name)) events.set(name, []);
      events.get(name)!.push(handler);
    },
  } as unknown as ExtensionAPI;

  piDuo(api);

  for (const handler of events.get("session_start") || []) {
    await handler({}, {
      cwd,
      sessionManager: { getSessionId: () => options.sessionId },
      modelRegistry: { find: () => undefined },
      ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    });
  }

  const callTool = async (toolName: string, input: unknown) => {
    const handlers = events.get("tool_call") || [];
    for (const handler of handlers) {
      const result = await handler({ toolName, toolCallId: "c1", input });
      if (result) return result;
    }
    return undefined;
  };

  return { cwd, store, callTool };
}

test("write guard does not lock a session that does not own the duo run", async () => {
  // The recorded Austin session is someone else's; the current session merely
  // shares the cwd. Leaving the guard armed here is what blocked an unrelated
  // Pi session in the same directory from editing any file.
  const { callTool } = await writeGuardHarness({
    sessionId: "current-session",
    recordedAustinSessionId: "other-session",
  });

  assert.equal(
    await callTool("edit", { path: "index.ts", oldText: "a", newText: "b" }),
    undefined,
    "a non-owner session must be able to write",
  );
  assert.equal(
    await callTool("write", { path: "index.ts", content: "x" }),
    undefined,
    "a non-owner session must be able to write",
  );
  assert.equal(
    await callTool("bash", { command: "touch probe.txt" }),
    undefined,
    "a non-owner session must be able to run a mutating shell command",
  );
});

test("write guard does not lock writes once the duo run is stopped", async () => {
  // `/duo stop` only flips `status` and leaves `collaboration` in EXPLORE.
  // The phase constraint must not outlive the run it belongs to.
  const { callTool } = await writeGuardHarness({
    sessionId: "owner-session",
    recordedAustinSessionId: "owner-session",
    status: "stopped",
  });

  assert.equal(
    await callTool("edit", { path: "index.ts", oldText: "a", newText: "b" }),
    undefined,
    "a stopped run must not keep gating writes",
  );
  assert.equal(
    await callTool("bash", { command: "mkdir -p out" }),
    undefined,
    "a stopped run must not keep gating mutating shell commands",
  );
});

test("write guard still enforces the EXPLORE barrier for the owning session", async () => {
  // The negative case: the fix must not disarm the real collaboration barrier.
  const { callTool } = await writeGuardHarness({
    sessionId: "owner-session",
    recordedAustinSessionId: "owner-session",
  });

  const edit = await callTool("edit", {
    path: "index.ts",
    oldText: "a",
    newText: "b",
  });
  assert.ok(edit, "the owning session is still blocked in EXPLORE");
  assert.equal(edit.block, true);
  assert.match(edit.reason, /EXPLORE|Barrier/i);

  const readOnly = await callTool("bash", { command: "git status" });
  assert.equal(readOnly, undefined, "read-only shell is never blocked");
});

test("write guard still blocks the owner in EXPLORE after Tony contributes", async () => {
  // EXPLORE never permits writes for Austin: Tony's initial contribution only
  // changes which barrier message is shown (it lifts the First Collaboration
  // Barrier and leaves the CONVERGE requirement). Only EXECUTE opens writes.
  const { callTool } = await writeGuardHarness({
    sessionId: "owner-session",
    recordedAustinSessionId: "owner-session",
    tonyInitialContribution: true,
  });

  const edit = await callTool("edit", {
    path: "index.ts",
    oldText: "a",
    newText: "b",
  });
  assert.ok(edit, "EXPLORE still blocks the owning session");
  assert.equal(edit.block, true);
  assert.match(edit.reason, /EXPLORE/);
  assert.doesNotMatch(edit.reason, /First Collaboration Barrier/);
});

test("write guard permits the owner to write in EXECUTE", async () => {
  const { store, callTool } = await writeGuardHarness({
    sessionId: "owner-session",
    recordedAustinSessionId: "owner-session",
  });
  await store.update((draft) => {
    draft.collaboration!.phase = "execute";
  });

  assert.equal(
    await callTool("edit", { path: "index.ts", oldText: "a", newText: "b" }),
    undefined,
    "the owning session may write in EXECUTE",
  );
});

test("/duo stop clears the collaboration block so the write gate cannot outlive the run", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-stop-gate-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    // An armed EXPLORE gate that would block every writer in this directory.
    await store.update((draft) => {
      draft.agents.austin.sessionId = "mock-session-id";
      draft.status = "active";
      draft.workspaceOwner = "austin";
      draft.collaboration = {
        userTurn: 1,
        phase: "explore",
        austinContributed: false,
        tonyContributed: false,
        tonyInitialContribution: false,
        contested: false,
        planRevision: 0,
      };
    });

    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    const events = new Map<string, Array<(...args: any[]) => any>>();
    const api = {
      registerTool() {},
      registerCommand(name: string, command: { handler: any }) {
        commands.set(name, command.handler);
      },
      registerMessageRenderer() {},
      sendMessage() {},
      on(name: string, handler: any) {
        if (!events.has(name)) events.set(name, []);
        events.get(name)!.push(handler);
      },
    } as unknown as ExtensionAPI;

    piDuo(api);

    const ctx = {
      cwd,
      sessionManager: { getSessionId: () => "mock-session-id" },
      modelRegistry: { find: () => undefined },
      ui: {
        notify: () => {},
        setStatus: () => {},
        setWidget: () => {},
        hideOverlay: () => {},
        custom: async () => ({ hidden: Promise.resolve() }),
      },
      isIdle: () => true,
      abort: () => {},
    };

    for (const handler of events.get("session_start") || []) {
      await handler({}, ctx);
    }

    const handler = commands.get("duo");
    assert.ok(handler, "/duo command must be registered");

    const before = await store.readState();
    assert.match(
      String(
        workspaceMutationBlockReason(
          "austin",
          before?.collaboration,
          before?.workspaceOwner ?? null,
        ),
      ),
      /EXPLORE|Barrier/,
      "precondition: the active run really is gating writes",
    );

    await handler("stop", ctx);

    const after = await store.readState();
    assert.equal(after?.status, "stopped");
    // Regression: `/duo stop` used to flip only `status`, leaving
    // `collaboration.phase === "explore"` behind. Every later session in this
    // cwd was then permanently blocked from writing files.
    assert.equal(
      after?.collaboration,
      undefined,
      "stop must clear the collaboration block",
    );
    assert.equal(after?.workspaceOwner, null, "stop must release the lock");
    assert.equal(
      workspaceMutationBlockReason(
        "austin",
        after?.collaboration,
        after?.workspaceOwner ?? null,
      ),
      undefined,
      "a stopped run must not gate writes",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
