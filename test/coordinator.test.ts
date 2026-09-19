import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyReviewFinding,
  applyReviewReported,
  blocksDuoRestart,
  canCompleteReview,
  canMutateDuoState,
  canMutateWorkspace,
  canUseWorkspaceAction,
  collaborationReadyToConverge,
  completionGateNotice,
  controlPlaneDelivery,
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

test("formatKindPrefix provides human readable emoji prefixes", () => {
  assert.equal(formatKindPrefix("proposal"), "💡 Proposal");
  assert.equal(formatKindPrefix("evidence"), "🔬 Evidence");
  assert.equal(formatKindPrefix("objection"), "⚠️ Objection");
  assert.equal(formatKindPrefix("checkpoint"), "🏁 Checkpoint");
  assert.equal(formatKindPrefix("verification"), "✅ Verification");
  assert.equal(formatKindPrefix("finding"), "🔍 Finding");
  assert.equal(formatKindPrefix("question"), "❓ Question");
  assert.equal(formatKindPrefix("decision"), "📋 Decision");
  assert.equal(formatKindPrefix(undefined), "");
});

test("isBlockedByFirstSyncBarrier blocks Austin in explore phase before Tony contributes", () => {
  assert.equal(
    isBlockedByFirstSyncBarrier("austin", {
      userTurn: 1,
      phase: "explore",
      austinContributed: false,
      tonyContributed: false,
      tonyInitialContribution: false,
      contested: false,
      planRevision: 0,
    }),
    true,
  );
  assert.equal(
    isBlockedByFirstSyncBarrier("austin", {
      userTurn: 1,
      phase: "explore",
      austinContributed: false,
      tonyContributed: true,
      tonyInitialContribution: true,
      contested: false,
      planRevision: 0,
    }),
    false,
  );
  assert.equal(
    isBlockedByFirstSyncBarrier("tony", {
      userTurn: 1,
      phase: "explore",
      austinContributed: false,
      tonyContributed: false,
      tonyInitialContribution: false,
      contested: false,
      planRevision: 0,
    }),
    false,
  );
  assert.equal(
    isBlockedByFirstSyncBarrier("austin", {
      userTurn: 1,
      phase: "converge",
      austinContributed: true,
      tonyContributed: false,
      tonyInitialContribution: false,
      contested: false,
      planRevision: 1,
    }),
    false,
  );
  assert.equal(
    isBlockedByFirstSyncBarrier("austin", {
      userTurn: 1,
      phase: "explore",
      austinContributed: false,
      tonyContributed: false,
      tonyInitialContribution: false,
      contested: false,
      planRevision: 0,
      degraded: true,
    }),
    false,
  );
});

test("collaborationReadyToConverge requires bilateral contributions in normal mode", () => {
  assert.equal(collaborationReadyToConverge(undefined), false);
  // Degraded mode is immediately ready
  assert.equal(
    collaborationReadyToConverge({
      userTurn: 1,
      phase: "explore",
      austinContributed: false,
      tonyContributed: false,
      tonyInitialContribution: false,
      contested: false,
      planRevision: 0,
      degraded: true,
    }),
    true,
  );
  // Only Austin contributed
  assert.equal(
    collaborationReadyToConverge({
      userTurn: 1,
      phase: "explore",
      austinContributed: true,
      tonyContributed: false,
      tonyInitialContribution: false,
      contested: false,
      planRevision: 0,
    }),
    false,
  );
  // Only Tony contributed
  assert.equal(
    collaborationReadyToConverge({
      userTurn: 1,
      phase: "explore",
      austinContributed: false,
      tonyContributed: true,
      tonyInitialContribution: true,
      contested: false,
      planRevision: 0,
    }),
    false,
  );
  // Both contributed but tonyInitialContribution is false
  assert.equal(
    collaborationReadyToConverge({
      userTurn: 1,
      phase: "explore",
      austinContributed: true,
      tonyContributed: true,
      tonyInitialContribution: false,
      contested: false,
      planRevision: 0,
    }),
    false,
  );
  // Both contributed and tonyInitialContribution is true
  assert.equal(
    collaborationReadyToConverge({
      userTurn: 1,
      phase: "explore",
      austinContributed: true,
      tonyContributed: true,
      tonyInitialContribution: true,
      contested: false,
      planRevision: 0,
    }),
    true,
  );
});

test("validatePlanCommit enforces actor, phase, and contribution guards", () => {
  const baseCollab = {
    userTurn: 1,
    phase: "converge" as const,
    austinContributed: true,
    tonyContributed: true,
    tonyInitialContribution: true,
    contested: false,
    planRevision: 1,
  };

  // Tony cannot commit
  assert.match(
    validatePlanCommit("tony", baseCollab) ?? "",
    /Only Austin/i,
  );

  // Missing collaboration state
  assert.match(
    validatePlanCommit("austin", undefined) ?? "",
    /No active collaboration/i,
  );

  // Cannot commit in EXPLORE
  assert.match(
    validatePlanCommit("austin", { ...baseCollab, phase: "explore" }) ?? "",
    /requires CONVERGE phase/i,
  );

  // Cannot commit in EXECUTE
  assert.match(
    validatePlanCommit("austin", { ...baseCollab, phase: "execute" }) ?? "",
    /requires CONVERGE phase/i,
  );

  // Austin hasn't contributed
  assert.match(
    validatePlanCommit("austin", { ...baseCollab, austinContributed: false }) ?? "",
    /Austin has not contributed/i,
  );

  // Tony hasn't contributed
  assert.match(
    validatePlanCommit("austin", { ...baseCollab, tonyContributed: false }) ?? "",
    /Tony has not provided the required independent contribution/i,
  );

  // Valid commit in CONVERGE
  assert.equal(validatePlanCommit("austin", baseCollab), undefined);

  // Degraded mode allows commit in EXPLORE or CONVERGE
  assert.equal(
    validatePlanCommit("austin", {
      ...baseCollab,
      phase: "explore",
      degraded: true,
    }),
    undefined,
  );
  assert.equal(
    validatePlanCommit("austin", {
      ...baseCollab,
      phase: "converge",
      degraded: true,
    }),
    undefined,
  );
});

test("validateReadyForVerification enforces actor and EXECUTE phase guards", () => {
  const baseCollab = {
    userTurn: 1,
    phase: "execute" as const,
    austinContributed: true,
    tonyContributed: true,
    tonyInitialContribution: true,
    contested: false,
    planRevision: 1,
  };

  // Tony cannot declare ready
  assert.match(
    validateReadyForVerification("tony", baseCollab) ?? "",
    /Only Austin/i,
  );

  // Missing collaboration state
  assert.match(
    validateReadyForVerification("austin", undefined) ?? "",
    /No active collaboration/i,
  );

  // Cannot declare ready in EXPLORE or CONVERGE
  assert.match(
    validateReadyForVerification("austin", { ...baseCollab, phase: "explore" }) ?? "",
    /requires EXECUTE phase/i,
  );
  assert.match(
    validateReadyForVerification("austin", { ...baseCollab, phase: "converge" }) ?? "",
    /requires EXECUTE phase/i,
  );
  assert.match(
    validateReadyForVerification("austin", { ...baseCollab, phase: "verify" }) ?? "",
    /requires EXECUTE phase/i,
  );

  // Valid in EXECUTE
  assert.equal(validateReadyForVerification("austin", baseCollab), undefined);
});

test("validateManualCompletion enforces actor, phase, and reported review guards", () => {
  const baseCollab = {
    userTurn: 1,
    phase: "verify" as const,
    austinContributed: true,
    tonyContributed: true,
    tonyInitialContribution: true,
    contested: false,
    planRevision: 1,
  };

  // Tony cannot manually finalize
  assert.match(
    validateManualCompletion("tony", baseCollab, "reported") ?? "",
    /Only Austin/i,
  );

  // Missing state
  assert.match(
    validateManualCompletion("austin", undefined, "reported") ?? "",
    /No active collaboration/i,
  );

  // Already complete is allowed (noop)
  assert.equal(
    validateManualCompletion("austin", { ...baseCollab, phase: "complete" }, "reported"),
    undefined,
  );

  // Cannot complete in EXECUTE or EXPLORE
  assert.match(
    validateManualCompletion("austin", { ...baseCollab, phase: "execute" }, "reported") ?? "",
    /requires VERIFY phase/i,
  );

  // Cannot complete if review is pending or failed
  assert.match(
    validateManualCompletion("austin", baseCollab, "pending") ?? "",
    /requires a reported Tony verification/i,
  );
  assert.match(
    validateManualCompletion("austin", baseCollab, "failed") ?? "",
    /requires a reported Tony verification/i,
  );

  // Valid in VERIFY with reported review
  assert.equal(
    validateManualCompletion("austin", baseCollab, "reported"),
    undefined,
  );
});

test("validateReopen enforces actor and phase guards", () => {
  const baseCollab = {
    userTurn: 1,
    phase: "verify" as const,
    austinContributed: true,
    tonyContributed: true,
    tonyInitialContribution: true,
    contested: false,
    planRevision: 1,
  };

  // Tony cannot reopen
  assert.match(
    validateReopen("tony", baseCollab) ?? "",
    /Only Austin/i,
  );

  // Missing state
  assert.match(
    validateReopen("austin", undefined) ?? "",
    /No active collaboration/i,
  );

  // Cannot reopen in EXPLORE, CONVERGE, or EXECUTE
  assert.match(
    validateReopen("austin", { ...baseCollab, phase: "explore" }) ?? "",
    /requires VERIFY or COMPLETE phase/i,
  );
  assert.match(
    validateReopen("austin", { ...baseCollab, phase: "converge" }) ?? "",
    /requires VERIFY or COMPLETE phase/i,
  );
  assert.match(
    validateReopen("austin", { ...baseCollab, phase: "execute" }) ?? "",
    /requires VERIFY or COMPLETE phase/i,
  );

  // Valid in VERIFY or COMPLETE
  assert.equal(validateReopen("austin", baseCollab), undefined);
  assert.equal(
    validateReopen("austin", { ...baseCollab, phase: "complete" }),
    undefined,
  );
});

test("tonyShouldYieldAfterSend only yields on successful delivery or deferred persistence", () => {
  assert.equal(
    tonyShouldYieldAfterSend("Message delivered to Austin's persistent session."),
    true,
  );
  assert.equal(
    tonyShouldYieldAfterSend(
      "High-priority message saved in Austin's persistent context and audit log without triggering another turn.",
    ),
    true,
  );
  assert.equal(
    tonyShouldYieldAfterSend(
      "Choose exactly one review state: reviewFinding for requested changes, or reviewComplete for final sign-off. End this turn now.",
    ),
    false,
  );
  assert.equal(
    tonyShouldYieldAfterSend(
      "Suppressed as substantially similar to a recent message from this agent.",
    ),
    false,
  );
  assert.equal(
    tonyShouldYieldAfterSend(
      "Peer-message budget exhausted (6 this user turn); all 2 context-only overflow slots are used until the next user input. Continue independently and do not retry this message.",
    ),
    false,
  );
  assert.equal(
    tonyShouldYieldAfterSend(
      "Stale Tony message for user turn 1 was discarded; current user turn is 2. End this turn now.",
    ),
    false,
  );
  assert.equal(
    tonyShouldYieldAfterSend(
      "No pending Tony review exists. Send ordinary coordination with reviewComplete omitted.",
    ),
    false,
  );
});

test("applyReviewReported atomically transitions review and collaboration state", () => {
  const createBaseState = () => ({
    version: "0.3.1",
    revision: 1,
    status: "active" as const,
    userTurn: 1,
    agents: {
      austin: { provider: "prov", modelId: "mod" },
      tony: { provider: "prov", modelId: "mod" },
    },
    collaboration: {
      userTurn: 1,
      phase: "verify" as "explore" | "converge" | "execute" | "verify" | "complete",
      austinContributed: true,
      tonyContributed: true,
      tonyInitialContribution: true,
      contested: false,
      planRevision: 1,
    },
    review: {
      userTurn: 1,
      status: "pending" as "pending" | "reported" | "failed",
      startedAt: "2026-09-19T00:00:00.000Z",
      error: "previous error",
    },
    todo: [],
    decisions: [],
    peerMessageCount: 0,
    lastActivityAt: "2026-09-19T00:00:00.000Z",
  });

  // 1. Successful atomic transition
  const state = createBaseState();
  const ok = applyReviewReported(state as any, 1);
  assert.equal(ok, true);
  assert.equal(state.review.status, "reported");
  assert.equal(state.review.error, undefined);
  assert.equal(state.collaboration.phase, "complete");

  // 2. Rejected if phase is not verify
  const notVerify = createBaseState();
  notVerify.collaboration.phase = "execute";
  assert.equal(applyReviewReported(notVerify as any, 1), false);
  assert.equal(notVerify.review.status, "pending");
  assert.equal(notVerify.collaboration.phase, "execute");

  // 3. Rejected if review status is not pending
  const alreadyReported = createBaseState();
  (alreadyReported.review as any).status = "reported";
  assert.equal(applyReviewReported(alreadyReported as any, 1), false);

  // 4. Rejected if turn does not match
  const wrongTurn = createBaseState();
  assert.equal(applyReviewReported(wrongTurn as any, 2), false);
  assert.equal(wrongTurn.review.status, "pending");
  assert.equal(wrongTurn.collaboration.phase, "verify");

  // 5. Rejected if no review exists
  const noReview = createBaseState();
  delete (noReview as any).review;
  assert.equal(applyReviewReported(noReview as any, 1), false);
});

test("workspace mutation gate follows collaboration lifecycle", () => {
  const base = {
    userTurn: 1,
    austinContributed: true,
    tonyContributed: true,
    tonyInitialContribution: true,
    contested: false,
    planRevision: 1,
  };

  // EXPLORE without Tony's initial contribution
  assert.match(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "explore",
      tonyInitialContribution: false,
    }) ?? "",
    /First Collaboration Barrier/i,
  );

  // EXPLORE with Tony's initial contribution
  assert.match(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "explore",
    }) ?? "",
    /EXPLORE/i,
  );

  // CONVERGE
  assert.match(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "converge",
    }) ?? "",
    /CONVERGE/i,
  );

  // EXECUTE (allowed)
  assert.equal(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "execute",
    }),
    undefined,
  );

  // VERIFY
  assert.match(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "verify",
    }) ?? "",
    /verification/i,
  );

  // COMPLETE
  assert.match(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "complete",
    }) ?? "",
    /reopen/i,
  );

  // Degraded mode only unblocks Austin's planning phases.
  assert.equal(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "explore",
      degraded: true,
    }),
    undefined,
  );
  assert.equal(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "converge",
      degraded: true,
    }),
    undefined,
  );
  assert.match(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "verify",
      degraded: true,
    }) ?? "",
    /verification/i,
  );
  assert.match(
    workspaceMutationBlockReason("austin", {
      ...base,
      phase: "complete",
      degraded: true,
    }) ?? "",
    /reopen/i,
  );

  // A transferable Tony owner is subject to the same integration gate.
  assert.match(
    workspaceMutationBlockReason("tony", {
      ...base,
      phase: "explore",
    }, "tony") ?? "",
    /Only EXECUTE/i,
  );
  assert.equal(
    workspaceMutationBlockReason("tony", {
      ...base,
      phase: "execute",
    }, "tony"),
    undefined,
  );
  assert.match(
    workspaceMutationBlockReason("tony", {
      ...base,
      phase: "verify",
      degraded: true,
    }, "tony") ?? "",
    /verification/i,
  );
  assert.match(
    workspaceMutationBlockReason("tony", {
      ...base,
      phase: "complete",
      degraded: true,
    }, "tony") ?? "",
    /reopen/i,
  );

  // Undefined collaboration
  assert.equal(workspaceMutationBlockReason("austin", undefined), undefined);
});

test("applyReviewFinding transitions VERIFY to EXECUTE and clears review", () => {
  const state: any = {
    collaboration: {
      userTurn: 1,
      phase: "verify",
    },
    review: {
      status: "pending",
      userTurn: 1,
    },
  };

  const ok = applyReviewFinding(state);
  assert.equal(ok, true);
  assert.equal(state.collaboration.phase, "execute");
  assert.equal(state.review, undefined);

  // Fails if phase is not verify
  state.collaboration.phase = "execute";
  state.review = { status: "pending", userTurn: 1 };
  assert.equal(applyReviewFinding(state), false);

  // Fails if review is not pending
  state.collaboration.phase = "verify";
  state.review = { status: "reported", userTurn: 1 };
  assert.equal(applyReviewFinding(state), false);
});

test("degradeCollaborationTurn protects against stale userTurn pollution", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-degrade-test-"));
  try {
    const store = new DuoStore(cwd);
    await store.create(
      { provider: "provider-a", modelId: "model/a" },
      { provider: "provider-b", modelId: "model/b" },
    );
    await store.update((draft) => {
      draft.collaboration = {
        userTurn: 2,
        phase: "explore",
        austinContributed: false,
        tonyContributed: false,
        tonyInitialContribution: false,
        contested: false,
        planRevision: 0,
      };
    });

    // 1. Stale error from turn 1 cannot degrade turn 2
    const staleResult = await degradeCollaborationTurn(store, 1);
    assert.equal(staleResult, false);
    let state = await store.readState();
    assert.equal(state?.collaboration?.userTurn, 2);
    assert.equal(state?.collaboration?.degraded, undefined);
    assert.equal(state?.collaboration?.tonyInitialContribution, false);

    // 2. Error matching current turn 2 degrades turn 2
    const currentResult = await degradeCollaborationTurn(store, 2);
    assert.equal(currentResult, true);
    state = await store.readState();
    assert.equal(state?.collaboration?.userTurn, 2);
    assert.equal(state?.collaboration?.degraded, true);
    assert.equal(state?.collaboration?.tonyInitialContribution, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});


