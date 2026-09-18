import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LoopGuard, triggeringDelivery } from "../src/coordinator.js";
import { DEFAULT_CONFIG, DuoStore } from "../src/store.js";

test("idle delivery triggers immediately instead of being parked for a later turn", () => {
  assert.deepEqual(triggeringDelivery(false), { triggerTurn: true });
  assert.deepEqual(triggeringDelivery(true), {
    triggerTurn: true,
    deliverAs: "followUp",
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
