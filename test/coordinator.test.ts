import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  blocksDuoRestart,
  canCompleteReview,
  canMutateDuoState,
  canMutateWorkspace,
  canUseWorkspaceAction,
  completionGateNotice,
  controlPlaneDelivery,
  dispatchControlPlaneTask,
  LoopGuard,
  openCompletionTodoIds,
  parseAgentTarget,
  reviewBelongsToTurn,
  roleDescription,
  shouldInspectPeerOutcome,
  triggeringDelivery,
  workspaceHandoffRecipient,
} from "../src/coordinator.js";
import { DEFAULT_CONFIG, DuoStore } from "../src/store.js";

test("idle delivery triggers immediately instead of being parked for a later turn", () => {
  assert.deepEqual(triggeringDelivery(false), { triggerTurn: true });
  assert.deepEqual(triggeringDelivery(true), {
    triggerTurn: true,
    deliverAs: "followUp",
  });
});

test("control-plane tasks dispatch without waiting for the peer turn", async () => {
  let finishTask: (() => void) | undefined;
  let completed = false;
  const pending = new Promise<void>((resolve) => {
    finishTask = resolve;
  });
  dispatchControlPlaneTask(
    async () => {
      await pending;
      completed = true;
    },
    (error) => assert.fail(error instanceof Error ? error : String(error)),
  );
  assert.equal(completed, false);
  finishTask?.();
  await pending;
  await Promise.resolve();
  assert.equal(completed, true);

  const expected = new Error("handoff failed");
  const caught = new Promise<unknown>((resolve) => {
    dispatchControlPlaneTask(() => Promise.reject(expected), resolve);
  });
  assert.equal(await caught, expected);

  const synchronous = new Error("synchronous handoff failure");
  let synchronousCaught: unknown;
  dispatchControlPlaneTask(
    () => {
      throw synchronous;
    },
    (error) => {
      synchronousCaught = error;
    },
  );
  assert.equal(synchronousCaught, synchronous);
});

test("steered peer deliveries are not mistaken for completed empty turns", () => {
  assert.equal(shouldInspectPeerOutcome(false), true);
  assert.equal(shouldInspectPeerOutcome(true), false);
});

test("role descriptions make the current identity unambiguous", () => {
  assert.equal(roleDescription("austin"), "Austin (foreground agent; not Tony)");
  assert.equal(roleDescription("tony"), "Tony (background peer; not Austin)");
});

test("targeted stop agent names are case-insensitive", () => {
  assert.equal(parseAgentTarget("austin"), "austin");
  assert.equal(parseAgentTarget("Austin"), "austin");
  assert.equal(parseAgentTarget("AUSTIN"), "austin");
  assert.equal(parseAgentTarget("aUsTiN"), "austin");
  assert.equal(parseAgentTarget("tony"), "tony");
  assert.equal(parseAgentTarget("Tony"), "tony");
  assert.equal(parseAgentTarget("TONY"), "tony");
  assert.equal(parseAgentTarget("tOnY"), "tony");
  assert.equal(parseAgentTarget("unknown"), undefined);
  assert.equal(parseAgentTarget(undefined), undefined);
});

test("Austin-only policy fixes project writes to Austin", () => {
  assert.equal(canMutateWorkspace("austin-only", "austin", null), true);
  assert.equal(canMutateWorkspace("austin-only", "tony", "tony"), false);
  assert.equal(canMutateWorkspace("transferable", "tony", "tony"), true);
  assert.equal(canMutateWorkspace("transferable", "tony", "austin"), false);
  assert.equal(canUseWorkspaceAction("austin-only", "austin", "status"), true);
  assert.equal(canUseWorkspaceAction("austin-only", "austin", "acquire"), true);
  assert.equal(canUseWorkspaceAction("austin-only", "austin", "transfer"), false);
  assert.equal(canUseWorkspaceAction("austin-only", "tony", "acquire"), false);
  assert.equal(canUseWorkspaceAction("transferable", "tony", "transfer"), true);
});

test("stopped Duo state is read-only until resumed", () => {
  assert.equal(canMutateDuoState("active"), true);
  assert.equal(canMutateDuoState("stopped"), false);
  assert.equal(canMutateDuoState(undefined), false);
});

test("workspace handoffs route symmetrically through the control plane", () => {
  assert.equal(workspaceHandoffRecipient("austin", "transfer", "tony"), "tony");
  assert.equal(
    workspaceHandoffRecipient("tony", "transfer", "austin"),
    "austin",
  );
  assert.equal(workspaceHandoffRecipient("austin", "release", null), "tony");
  assert.equal(workspaceHandoffRecipient("tony", "release", null), "austin");
  assert.equal(
    workspaceHandoffRecipient("austin", "transfer", "austin"),
    undefined,
  );
  assert.deepEqual(controlPlaneDelivery(false), { triggerTurn: true });
  assert.deepEqual(controlPlaneDelivery(true), {
    triggerTurn: true,
    deliverAs: "steer",
  });
});

test("completion gate distinguishes pending review from stale shared todos", () => {
  const todo = [
    {
      id: 1,
      text: "implemented",
      status: "done" as const,
      owner: "austin" as const,
    },
    {
      id: 2,
      text: "verify",
      status: "in_progress" as const,
      owner: "austin" as const,
    },
    {
      id: 3,
      text: "peer task",
      status: "pending" as const,
      owner: "tony" as const,
    },
    {
      id: 4,
      text: "known blocker",
      status: "blocked" as const,
      owner: "austin" as const,
    },
  ];
  assert.deepEqual(openCompletionTodoIds({ todo }), [2, 3]);
  assert.match(
    completionGateNotice({ review: { status: "pending" }, todo }) ?? "",
    /preliminary.*Tony is still working/i,
  );
  assert.match(
    completionGateNotice({ review: { status: "reported" }, todo }) ?? "",
    /#2/,
  );
  assert.equal(
    completionGateNotice({
      review: { status: "reported" },
      todo: todo.map((item) =>
        item.id === 2 || item.id === 3
          ? { ...item, status: "done" as const }
          : item,
      ),
    }),
    undefined,
  );
});

test("only Tony's explicit report can complete a pending review", () => {
  assert.equal(canCompleteReview("tony", true, "pending"), true);
  assert.equal(canCompleteReview("tony", false, "pending"), false);
  assert.equal(canCompleteReview("tony", undefined, "pending"), false);
  assert.equal(canCompleteReview("austin", true, "pending"), false);
  assert.equal(canCompleteReview("tony", true, "reported"), false);
  assert.equal(canCompleteReview("tony", true, "failed"), false);
});

test("Tony review reports are scoped to the user turn that started them", () => {
  assert.equal(reviewBelongsToTurn(4, 4), true);
  assert.equal(reviewBelongsToTurn(3, 4), false);
  assert.equal(reviewBelongsToTurn(undefined, 4), false);
  assert.equal(reviewBelongsToTurn(4, undefined), false);
});

test("a pending review cannot be silently replaced by a new Duo run", () => {
  assert.equal(
    blocksDuoRestart({ status: "active", review: { status: "pending" } }),
    true,
  );
  assert.equal(
    blocksDuoRestart({ status: "active", review: { status: "reported" } }),
    false,
  );
  assert.equal(
    blocksDuoRestart({ status: "active", review: { status: "failed" } }),
    false,
  );
  assert.equal(blocksDuoRestart({ status: "stopped" }), false);
  assert.equal(blocksDuoRestart(undefined), false);
});

test("loop guard enforces duplicate, total, and consecutive limits", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-guard-"));
  const store = new DuoStore(cwd);
  await store.create(
    { provider: "a", modelId: "a" },
    { provider: "b", modelId: "b" },
  );
  const guard = new LoopGuard();
  const config = {
    ...DEFAULT_CONFIG,
    maxPeerMessagesPerTurn: 2,
    maxConsecutivePeerTurns: 1,
  };
  try {
    guard.beginUserTurn();
    assert.equal(
      await guard.check(store, "austin", "first useful finding", config),
      undefined,
    );
    guard.recordPeerMessage();
    await store.appendMessage({
      from: "austin",
      to: "tony",
      content: "first useful finding",
      importance: "normal",
      userTurn: guard.turn,
    });
    assert.match(
      (await guard.check(store, "austin", "first useful finding", config))
        ?.reason ?? "",
      /chain stopped|similar/,
    );
    guard.noteMaterialActivity();
    assert.match(
      (await guard.check(store, "austin", "first useful finding", config))
        ?.reason ?? "",
      /similar/,
    );
    assert.match(
      (await guard.check(store, "tony", "routine coordination", config))
        ?.reason ?? "",
      /final slot is reserved/,
    );
    assert.equal(
      await guard.check(
        store,
        "tony",
        "independent counterexample",
        config,
        "important",
      ),
      undefined,
    );
    guard.recordPeerMessage();
    await store.appendMessage({
      from: "tony",
      to: "austin",
      content: "independent counterexample",
      importance: "important",
      userTurn: guard.turn,
    });
    guard.noteMaterialActivity();
    const duplicateOverflow = await guard.check(
      store,
      "tony",
      "independent counterexample",
      config,
      "important",
    );
    assert.match(duplicateOverflow?.reason ?? "", /similar/);
    assert.equal(duplicateOverflow?.persistWithoutTurn, false);
    const blockedNormal = await guard.check(
      store,
      "tony",
      "third message",
      config,
    );
    assert.match(blockedNormal?.reason ?? "", /budget exhausted/);
    assert.equal(blockedNormal?.persistWithoutTurn, false);
    const deferredImportant = await guard.check(
      store,
      "tony",
      "late critical finding",
      config,
      "important",
    );
    assert.match(deferredImportant?.reason ?? "", /budget exhausted/);
    assert.equal(deferredImportant?.persistWithoutTurn, true);
    await store.appendMessage({
      from: "tony",
      to: "austin",
      content: "late critical finding",
      importance: "important",
      deferred: true,
      userTurn: guard.turn,
    });
    guard.recordDeferredMessage();
    const duplicateDeferred = await guard.check(
      store,
      "tony",
      "late critical finding",
      config,
      "important",
    );
    assert.equal(duplicateDeferred?.persistWithoutTurn, false);
    assert.match(duplicateDeferred?.reason ?? "", /similar/);
    const secondDeferred = await guard.check(
      store,
      "austin",
      "another late critical finding",
      config,
      "decision",
    );
    assert.equal(secondDeferred?.persistWithoutTurn, true);
    guard.recordDeferredMessage();
    const blockedThirdOverflow = await guard.check(
      store,
      "tony",
      "third late critical finding",
      config,
      "important",
    );
    assert.equal(blockedThirdOverflow?.persistWithoutTurn, false);
    assert.match(blockedThirdOverflow?.reason ?? "", /all 2.*slots are used/);
    assert.match(blockedThirdOverflow?.reason ?? "", /do not retry/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loop guard resumes a durable user-turn sequence after reload", () => {
  const guard = new LoopGuard();
  assert.equal(guard.beginUserTurn(7), 7);
  assert.equal(guard.turn, 7);
  assert.equal(guard.beginUserTurn(8), 8);
});
