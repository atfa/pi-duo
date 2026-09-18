import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  DuoStore,
  isMutatingShell,
  isWaitingShell,
  parseModelRef,
  textSimilarity,
} from "../src/store.js";

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-duo-test-"));
  const store = new DuoStore(cwd);
  await store.create(
    { provider: "provider-a", modelId: "model/a" },
    { provider: "provider-b", modelId: "model/b" },
  );
  return { cwd, store };
}

test("parses provider/model while preserving slashes in model id", () => {
  assert.deepEqual(parseModelRef("openrouter/org/model"), {
    provider: "openrouter",
    modelId: "org/model",
  });
  assert.throws(() => parseModelRef("missing-slash"));
});

test("persists config defaults and overrides", async () => {
  const { cwd, store } = await fixture();
  try {
    assert.deepEqual(await store.readConfig(), DEFAULT_CONFIG);
    await store.writeConfig({
      ...DEFAULT_CONFIG,
      autoDispatch: false,
      writePolicy: "transferable",
      agentB: { provider: "x", modelId: "y" },
    });
    const config = await store.readConfig();
    assert.equal(config.autoDispatch, false);
    assert.equal(config.writePolicy, "transferable");
    assert.deepEqual(config.agentB, { provider: "x", modelId: "y" });

    await writeFile(store.configPath, '{"autoDispatch":false}\n');
    const migrated = await store.readConfig();
    assert.equal(migrated.writePolicy, "austin-only");
    assert.equal(migrated.maxDeferredMessagesPerTurn, 2);
    await writeFile(store.configPath, '{"writePolicy":"invalid"}\n');
    assert.equal((await store.readConfig()).writePolicy, "austin-only");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Austin-only policy normalizes stale workspace ownership", async () => {
  const { cwd, store } = await fixture();
  try {
    await store.update((state) => {
      state.workspaceOwner = "tony";
    });
    const normalized = await store.enforceWritePolicy({
      ...DEFAULT_CONFIG,
      writePolicy: "austin-only",
    });
    assert.equal(normalized?.workspaceOwner, "austin");
    const revision = normalized?.revision;
    const unchanged = await store.enforceWritePolicy(DEFAULT_CONFIG);
    assert.equal(unchanged?.revision, revision);

    await store.update((state) => {
      state.workspaceOwner = "tony";
    });
    const transferable = await store.enforceWritePolicy({
      ...DEFAULT_CONFIG,
      writePolicy: "transferable",
    });
    assert.equal(transferable?.workspaceOwner, "tony");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("serializes concurrent state mutations without lost updates", async () => {
  const { cwd, store } = await fixture();
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.update((state) => {
          state.todo.push({
            id: index + 1,
            text: `task ${index + 1}`,
            status: "pending",
            updatedAt: new Date().toISOString(),
          });
        }),
      ),
    );
    const state = await store.readState();
    assert.equal(state?.todo.length, 12);
    assert.equal(state?.revision, 12);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects stale optimistic revisions", async () => {
  const { cwd, store } = await fixture();
  try {
    await store.update((state) => {
      state.goal = "new";
    });
    await assert.rejects(
      store.update((state) => {
        state.goal = "stale";
      }, 0),
      /expected revision 0/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("appends peer audit records and materializes decisions markdown", async () => {
  const { cwd, store } = await fixture();
  try {
    await store.appendMessage({
      from: "austin",
      to: "tony",
      content: "Inspect parser evidence",
      importance: "important",
      userTurn: 1,
    });
    await store.appendMessage({
      from: "tony",
      to: "austin",
      content: "Late critical finding",
      importance: "decision",
      deferred: true,
      userTurn: 1,
    });
    await store.update((state) =>
      state.decisions.push({
        id: 1,
        text: "Use an experiment",
        evidence: "test output",
        author: "tony",
        createdAt: new Date().toISOString(),
      }),
    );
    const messages = await store.recentMessages();
    assert.equal(messages.length, 2);
    assert.equal(messages[1]?.deferred, true);
    assert.match(
      await readFile(store.decisionsPath, "utf8"),
      /Use an experiment[\s\S]*test output/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("waiting shell checks stop background peer polling", () => {
  assert.equal(isWaitingShell("sleep 60; echo done"), true);
  assert.equal(isWaitingShell("watch ls"), true);
  assert.equal(isWaitingShell("tail --follow app.log"), true);
  assert.equal(isWaitingShell("ls -la"), false);
});

test("similarity and shell mutation checks are conservative", () => {
  assert.ok(
    textSimilarity(
      "Inspect the parser token stream",
      "inspect parser token stream",
    ) > 0.7,
  );
  assert.equal(isMutatingShell("rg parser src"), false);
  assert.equal(isMutatingShell("rm -rf build"), true);
  assert.equal(isMutatingShell("printf x > file"), true);
  assert.equal(isMutatingShell('printf "%s\\n" ">"'), false);
  assert.equal(
    isMutatingShell(
      "node -e 'const xs = [1]; console.log(xs.filter((x) => x > 0))'",
    ),
    false,
  );
  assert.equal(isMutatingShell("grep -o '<div[^>]*>' index.html"), false);
  assert.equal(isMutatingShell("sed 's/<redacted>/safe/g' config.txt"), false);
  assert.equal(
    isMutatingShell("node - <<'NODE'\nif (value > 1) console.log(value);\nNODE"),
    false,
  );
  assert.equal(isMutatingShell("bash -c 'printf x > file'"), true);
  assert.equal(isMutatingShell(`printf "%s\\n" "bash -c 'rm file'"`), false);
  assert.equal(isMutatingShell("git status"), false);
  assert.equal(
    isMutatingShell('find . -name "*.json" 2>/dev/null | head'),
    false,
  );
  assert.equal(isMutatingShell("command 2>&1"), false);
  assert.equal(isMutatingShell("git checkout -- file"), true);
});
