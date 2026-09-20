import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { DuoTranscript, type LiveToolState } from "../src/workbench.js";

const tui = { requestRender() {} } as any;
initTheme(undefined, false);
const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "native message" }],
  stopReason: "stop",
};

test("DuoTranscript keeps Austin left and Tony right with native messages", () => {
  const transcript = new DuoTranscript(tui, process.cwd());
  transcript.update(
    { label: "Austin", cwd: process.cwd(), messages: [{ ...assistant, content: [{ type: "text", text: "Austin history" }] }] },
    { label: "Tony", cwd: process.cwd(), messages: [{ ...assistant, content: [{ type: "text", text: "Tony history" }] }] },
  );
  const rows = stripTerminalSequences(transcript.render(100).join("\n"));
  assert.match(rows, /Austin/);
  assert.match(rows, /Tony/);
  assert.match(rows, /Austin history/);
  assert.match(rows, /Tony history/);
});

test("DuoTranscript splits columns evenly and draws both separators", () => {
  const transcript = new DuoTranscript(tui, process.cwd());
  transcript.update(
    { label: "Austin", cwd: process.cwd(), messages: [] },
    { label: "Tony", cwd: process.cwd(), messages: [] },
  );
  const rows = transcript.render(101).map(stripTerminalSequences);
  assert.equal(rows[0].indexOf("│"), 50);
  assert.equal(rows[1], "─".repeat(101));
  assert.equal(rows.at(-5), "─".repeat(101));
  assert.equal(rows.at(-1), "─".repeat(101));
});

test("DuoTranscript keeps short Austin content when Tony grows taller", () => {
  const transcript = new DuoTranscript(tui, process.cwd());
  transcript.setMaxRows(10);
  transcript.update(
    {
      label: "Austin",
      cwd: process.cwd(),
      messages: [{ ...assistant, content: [{ type: "text", text: "Austin stays visible" }] }],
      footer: ["模型  Austin", "交谈  Austin → Tony 0", "状态  · Austin 待命"],
    },
    {
      label: "Tony",
      cwd: process.cwd(),
      messages: Array.from({ length: 8 }, (_, index) => ({
        ...assistant,
        content: [{ type: "text", text: `Tony row ${index}` }],
      })),
      footer: ["模型  Tony", "交谈  Tony → Austin 0", "状态  · Tony 待命"],
    },
  );

  const rows = transcript.render(100).map(stripTerminalSequences);
  const output = rows.join("\n");
  assert.equal(rows.length, 10);
  assert.match(rows[0], /Austin/);
  assert.match(rows[0], /Tony/);
  assert.equal(rows[1], "─".repeat(100));
  assert.match(output, /Austin stays visible/);
  assert.match(output, /Tony row 7/);
  assert.ok(rows.slice(2, 5).every((row) => row.indexOf("│") === 49));
  assert.equal(rows[5], "─".repeat(100));
  assert.match(rows[6], /模型  Austin/);
  assert.match(rows[6], /模型  Tony/);
  assert.match(rows[8], /Austin 待命/);
  assert.match(rows[8], /Tony 待命/);
  assert.equal(rows[0].indexOf("│"), 49);
  assert.equal(rows.at(-1), "─".repeat(100));
});

test("DuoTranscript marks the active assistant component as streaming", () => {
  const transcript = new DuoTranscript(tui, process.cwd());
  transcript.update(
    { label: "Austin", cwd: process.cwd(), messages: [assistant], streaming: assistant },
    { label: "Tony", cwd: process.cwd(), messages: [] },
  );
  const component = (transcript as any).austinDocument.children
    .find((child: unknown) => child instanceof AssistantMessageComponent);
  assert.equal((component as any).isStreaming, true);
});

test("DuoTranscript applies live partial and final tool results", () => {
  const message = {
    ...assistant,
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }],
  };
  const transcript = new DuoTranscript(tui, process.cwd());
  const tools = new Map<string, LiveToolState>([["call-1", {
    name: "read", args: { path: "x" }, started: true,
    partial: { content: [{ type: "text", text: "partial" }], isError: false },
  }]]);
  transcript.update(
    { label: "Austin", cwd: process.cwd(), messages: [message], tools },
    { label: "Tony", cwd: process.cwd(), messages: [] },
  );
  let tool = (transcript as any).austinDocument.children
    .find((child: unknown) => child instanceof ToolExecutionComponent) as any;
  assert.equal(tool.executionStarted, true);
  assert.equal(tool.isPartial, true);
  tools.set("call-1", { name: "read", args: { path: "x" }, final: { content: [{ type: "text", text: "done" }], isError: false } });
  transcript.update(
    { label: "Austin", cwd: process.cwd(), messages: [message], tools },
    { label: "Tony", cwd: process.cwd(), messages: [] },
  );
  tool = (transcript as any).austinDocument.children
    .find((child: unknown) => child instanceof ToolExecutionComponent) as any;
  assert.equal(tool.isPartial, false);
  assert.equal(tool.result.content[0].text, "done");
});
