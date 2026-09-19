import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piDuo from "../index.js";
import { isBlockedByFirstSyncBarrier } from "../src/coordinator.js";
import { DuoStore } from "../src/store.js";

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
    assert.ok(statuses.some((status) => status?.includes("Tony 正在后台协作")));
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
    assert.ok(statuses.some((status) => status?.includes("协作不可用，已降级为单 Agent")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
