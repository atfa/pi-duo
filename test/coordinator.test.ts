import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canMutateWorkspace,
  canUseWorkspaceAction,
  controlPlaneDelivery,
  dispatchControlPlaneTask,
  LoopGuard,
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
    guard.recordDeferredMessage();
    const blockedSecondOverflow = await guard.check(
      store,
      "austin",
      "another late critical finding",
      config,
      "decision",
    );
    assert.equal(blockedSecondOverflow?.persistWithoutTurn, false);
    assert.match(blockedSecondOverflow?.reason ?? "", /slot is unavailable/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
