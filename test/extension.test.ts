import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piDuo from "../index.js";

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
