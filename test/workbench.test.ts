import assert from "node:assert/strict";
import test from "node:test";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  DuoTranscript,
  isDuoPolicyBlock,
  toWorkbenchPreview,
  type LiveToolState,
} from "../src/workbench.js";

const tui = { requestRender() {} } as any;
initTheme(undefined, false);
const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "native message" }],
  stopReason: "stop",
};

test("workbench previews bound local-model payloads without mutating sessions", () => {
  const long = "x".repeat(100_000);
  const args: any = {};
  args.self = args;
  args.body = long;
  args.nested = { deeper: { value: long } };
  const message = {
    role: "assistant",
    diagnostics: [{ payload: long }],
    content: [
      { type: "thinking", thinking: long },
      { type: "toolCall", id: "large", name: "write", arguments: args },
      { type: "text", text: long },
    ],
  };
  const preview = toWorkbenchPreview(message);

  assert.equal((message.content[0] as any).thinking.length, 100_000);
  assert.equal((message.content[1] as any).arguments.body.length, 100_000);
  assert.equal((message.content[1] as any).arguments.self, args);
  assert.equal((message.content[2] as any).text.length, 100_000);
  assert.ok(preview.content[0]!.thinking.length <= 1_500);
  assert.match(preview.content[0]!.thinking, /display truncated/);
  const argumentPreview = JSON.stringify(preview.content[1]!.arguments);
  assert.ok(argumentPreview.length < 2_500);
  assert.match(argumentPreview, /circular value omitted/);
  assert.ok(preview.content[2]!.text.length <= 4_000);
  assert.equal(preview.diagnostics, undefined);

  const result = toWorkbenchPreview({
    role: "toolResult",
    content: [{ type: "text", text: long }],
    details: { diff: long },
  });
  assert.ok(result.content[0].text.length <= 4_000);
  assert.equal(result.details, undefined);
});

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
  assert.equal(rows[6], "─".repeat(101));
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
      footer: ["模型  Austin", "交谈  Austin → Tony 0", "状态  · Austin 等待任务"],
    },
    {
      label: "Tony",
      cwd: process.cwd(),
      messages: Array.from({ length: 8 }, (_, index) => ({
        ...assistant,
        content: [{ type: "text", text: `Tony row ${index}` }],
      })),
      footer: ["模型  Tony", "交谈  Tony → Austin 0", "状态  · Tony 等待任务"],
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
  assert.ok(rows.slice(7, 9).every((row) => row.indexOf("│") === 49));
  assert.equal(rows[6], "─".repeat(100));
  assert.match(rows[3], /模型  Austin/);
  assert.match(rows[3], /模型  Tony/);
  assert.match(rows[5], /Austin 等待任务/);
  assert.match(rows[5], /Tony 等待任务/);
  assert.equal(rows[0].indexOf("│"), 49);
  assert.equal(rows.at(-1), "─".repeat(100));
});

test("DuoTranscript keeps a fixed height for short content without duplicating it", () => {
  const transcript = new DuoTranscript(tui, process.cwd());
  transcript.setMaxRows(12);
  transcript.update(
    {
      label: "Austin",
      cwd: process.cwd(),
      messages: [{ ...assistant, content: [{ type: "text", text: "Austin appears once" }] }],
    },
    { label: "Tony", cwd: process.cwd(), messages: [] },
  );

  const rows = transcript.render(100).map(stripTerminalSequences);
  const output = rows.join("\n");
  assert.equal(rows.length, 12);
  assert.equal(output.match(/Austin appears once/g)?.length, 1);
  assert.match(rows.at(-2) ?? "", /Austin appears once/);
  assert.ok(rows.slice(7, -1).every((row) => row.indexOf("│") === 49));
  assert.equal(rows.at(-1), "─".repeat(100));
});

test("DuoTranscript recomputes its height on terminal resize", () => {
  const terminal = { rows: 20 };
  const transcript = new DuoTranscript(
    { requestRender() {}, terminal } as any,
    process.cwd(),
    () => terminal.rows - 8,
  );
  transcript.update(
    {
      label: "Austin",
      cwd: process.cwd(),
      messages: [{ ...assistant, content: [{ type: "text", text: "Austin appears once after resize" }] }],
    },
    { label: "Tony", cwd: process.cwd(), messages: [] },
  );

  let rows = transcript.render(100).map(stripTerminalSequences);
  assert.equal(rows.length, 12);
  assert.equal(rows.join("\n").match(/Austin appears once after resize/g)?.length, 1);

  terminal.rows = 30;
  rows = transcript.render(100).map(stripTerminalSequences);
  assert.equal(rows.length, 22);
  assert.equal(rows.join("\n").match(/Austin appears once after resize/g)?.length, 1);

  terminal.rows = 18;
  rows = transcript.render(100).map(stripTerminalSequences);
  assert.equal(rows.length, 10);
  assert.equal(rows.join("\n").match(/Austin appears once after resize/g)?.length, 1);
  assert.ok(rows.slice(7, -1).every((row) => row.indexOf("│") === 49));
});

test("DuoTranscript keeps a completion notice in fixed chrome", () => {
  const transcript = new DuoTranscript(tui, process.cwd());
  transcript.setNotice("✓ pi-duo 协作任务彻底完成");
  transcript.update(
    { label: "Austin", cwd: process.cwd(), messages: [] },
    { label: "Tony", cwd: process.cwd(), messages: [] },
  );
  const rows = transcript.render(100).map(stripTerminalSequences);
  assert.match(rows[2], /协作任务彻底完成/);
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

test("DuoTranscript hides policy-blocked tools but keeps real tool failures", () => {
  const blocked = {
    ...assistant,
    content: [{ type: "toolCall", id: "blocked", name: "write", arguments: { path: "x" } }],
  };
  const failed = {
    ...assistant,
    content: [{ type: "toolCall", id: "failed", name: "write", arguments: { path: "y" } }],
  };
  const transcript = new DuoTranscript(tui, process.cwd());
  transcript.update(
    {
      label: "Austin", cwd: process.cwd(), messages: [blocked, failed,
        { role: "toolResult", toolCallId: "blocked", content: [{ type: "text", text: "Collaboration is still in EXPLORE. Austin must contribute." }], isError: true },
        { role: "toolResult", toolCallId: "failed", content: [{ type: "text", text: "disk full" }], isError: true },
      ],
    },
    { label: "Tony", cwd: process.cwd(), messages: [] },
  );
  const tools = (transcript as any).austinDocument.children
    .filter((child: unknown) => child instanceof ToolExecutionComponent) as any[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0].result.isError, true);
  assert.equal(tools[0].result.content[0].text, "disk full");
  assert.equal(isDuoPolicyBlock({ content: [{ type: "text", text: "disk full" }] }), false);
});
