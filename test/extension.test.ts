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

    // 5. Ready for verification succeeds in EXECUTE -> VERIFY
    const readyOk = await checkpointExecute("4", { action: "ready_for_verification", summary: "ready" });
    assert.match(readyOk.content[0].text, /ready for independent verification/i);
    state = await store.readState();
    assert.equal(state?.collaboration?.phase, "verify");
    assert.equal(state?.review?.status, "pending");

    // 6. Manual completion rejected while review is pending
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

    // 3. Austin moves to VERIFY via duo_checkpoint
    const checkpointExecute = tools.get("duo_checkpoint");
    assert.ok(checkpointExecute);
    await checkpointExecute("3", { action: "ready_for_verification", summary: "ready" });
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
