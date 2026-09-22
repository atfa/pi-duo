import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  compositeTuiLine,
  ScrollView,
  Text,
  VStack,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

/** The small public surface needed from either live Pi session. */
export interface SessionTranscript {
  label: string;
  cwd: string;
  messages: readonly any[];
  streaming?: any;
  tools?: ReadonlyMap<string, LiveToolState>;
  footer?: readonly string[];
}

export interface LiveToolState {
  name: string;
  args: any;
  started?: boolean;
  partial?: any;
  final?: any;
}

const MAX_PREVIEW_PARTS = 16;
const MAX_TEXT_PREVIEW = 4_000;
const MAX_THINKING_PREVIEW = 1_500;
const MAX_TOOL_ARGS_PREVIEW = 2_000;
const TRUNCATION_MARKER = "\n… [pi-duo display truncated; full content remains in session] …\n";

function truncatePreview(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const remaining = Math.max(0, limit - TRUNCATION_MARKER.length);
  const head = Math.floor(remaining / 2);
  return value.slice(0, head) + TRUNCATION_MARKER + value.slice(-(remaining - head));
}

function previewToolArguments(args: any): any {
  const budget = { remaining: MAX_TOOL_ARGS_PREVIEW };
  const seen = new WeakSet<object>();
  const visit = (value: any, depth: number): any => {
    if (budget.remaining <= 0) return "[display budget exhausted]";
    budget.remaining -= 8;
    if (typeof value === "string") {
      const limit = Math.max(0, Math.min(value.length, budget.remaining));
      budget.remaining -= limit;
      return truncatePreview(value, limit);
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular value omitted]";
    if (depth >= 4) return "[nested value omitted]";
    seen.add(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, 12).map((item) => visit(item, depth + 1));
      if (value.length > 12) items.push(`[${value.length - 12} more items omitted]`);
      return items;
    }
    const preview: Record<string, any> = {};
    let fields = 0;
    let omitted = false;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (fields++ >= 12) {
        omitted = true;
        break;
      }
      budget.remaining -= Math.min(key.length, 64);
      preview[key] = visit(value[key], depth + 1);
      if (budget.remaining <= 0) break;
    }
    if (omitted) preview["…"] = "[more fields omitted]";
    return preview;
  };
  return visit(args ?? {}, 0);
}

/** A bounded display clone; the persisted message and model context stay intact. */
export function toWorkbenchPreview(message: any): any {
  if (!message || typeof message !== "object") return message;
  if (message.role === "user" && typeof message.content === "string") {
    return { ...message, content: truncatePreview(message.content, MAX_TEXT_PREVIEW) };
  }
  if (!Array.isArray(message.content)) return message;

  const content = message.content.slice(-MAX_PREVIEW_PARTS).map((part: any) => {
    if (!part || typeof part !== "object") return part;
    if (part.type === "image" || part.type === "audio") {
      return { type: "text", text: `[${part.type} omitted from pi-duo display]` };
    }
    if (part.type === "toolCall") {
      const args = previewToolArguments(part.arguments);
      return args === part.arguments ? part : { ...part, arguments: args };
    }
    if (typeof part.thinking === "string") {
      return {
        ...part,
        thinking: truncatePreview(part.thinking, MAX_THINKING_PREVIEW),
      };
    }
    if (typeof part.text === "string") {
      return { ...part, text: truncatePreview(part.text, MAX_TEXT_PREVIEW) };
    }
    return part;
  });
  const preview = { ...message, content };
  delete preview.details;
  if (message.role === "assistant") delete preview.diagnostics;
  return preview;
}

/**
 * Two real Pi transcript columns. This mirrors InteractiveMode's
 * assistant/tool rendering instead of inventing a second message format.
 */
class HorizontalRule implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return ["─".repeat(Math.max(1, width))];
  }
}

/** Keep each transcript's heading and newest rows independently. */
class LatestRows implements Component {
  constructor(private readonly child: Component, private maxRows: number) {}

  setMaxRows(rows: number): void {
    this.maxRows = Math.max(1, Math.floor(rows));
  }

  invalidate(): void {
    this.child.invalidate();
  }

  render(width: number): string[] {
    const rows = this.child.render(width);
    if (rows.length <= this.maxRows) return rows;
    return rows.slice(-this.maxRows);
  }
}

class EqualColumns implements Component {
  constructor(
    private readonly left: Component,
    private readonly right: Component,
  ) {}

  invalidate(): void {
    this.left.invalidate();
    this.right.invalidate();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(2, width - 1);
    const leftWidth = Math.floor(contentWidth / 2);
    const rightWidth = contentWidth - leftWidth;
    const leftRows = this.left.render(leftWidth);
    const rightRows = this.right.render(rightWidth);
    const height = Math.max(leftRows.length, rightRows.length);
    return Array.from({ length: height }, (_, index) => {
      let row = " ".repeat(width);
      row = compositeTuiLine(row, leftRows[index] ?? "", 0, leftWidth, width);
      row = compositeTuiLine(row, "│", leftWidth, 1, width);
      return compositeTuiLine(
        row,
        rightRows[index] ?? "",
        leftWidth + 1,
        rightWidth,
        width,
      );
    });
  }
}

export class DuoTranscript implements Component {
  private readonly austinDocument: VStack;
  private readonly tonyDocument: VStack;
  private readonly austinColumn: ScrollView;
  private readonly tonyColumn: ScrollView;
  private readonly austinViewport: LatestRows;
  private readonly tonyViewport: LatestRows;
  private readonly columns: EqualColumns;
  private austinFooter: readonly string[] = [];
  private tonyFooter: readonly string[] = [];
  private notice = "";
  private maxRows = 12;
  private static readonly FOOTER_ROWS = 3;
  private static readonly FIXED_ROWS = 1 + 1 + 1 + DuoTranscript.FOOTER_ROWS + 1 + 1;

  constructor(
    private readonly tui: TUI,
    private readonly cwd: string,
    private readonly maxRowsProvider?: () => number,
  ) {
    const austinDocument = new VStack();
    const tonyDocument = new VStack();
    const austinColumn = new ScrollView(austinDocument, {
      follow: "end", overscroll: "contain", scrollbar: "auto",
    });
    const tonyColumn = new ScrollView(tonyDocument, {
      follow: "end", overscroll: "contain", scrollbar: "auto",
    });
    this.austinViewport = new LatestRows(
      austinColumn,
      this.maxRows - DuoTranscript.FIXED_ROWS,
    );
    this.tonyViewport = new LatestRows(
      tonyColumn,
      this.maxRows - DuoTranscript.FIXED_ROWS,
    );
    this.columns = new EqualColumns(this.austinViewport, this.tonyViewport);
    this.austinDocument = austinDocument;
    this.tonyDocument = tonyDocument;
    this.austinColumn = austinColumn;
    this.tonyColumn = tonyColumn;
  }

  setMaxRows(rows: number): void {
    this.maxRows = Math.max(DuoTranscript.FIXED_ROWS, Math.floor(rows));
    const bodyRows = this.maxRows - DuoTranscript.FIXED_ROWS;
    this.austinViewport.setMaxRows(bodyRows);
    this.tonyViewport.setMaxRows(bodyRows);
  }

  render(width: number): string[] {
    // Pi re-renders an overlay after a terminal resize but exposes no resize
    // event to extensions. Reading the live budget here keeps this panel in
    // step with that render without reconstructing the overlay.
    if (this.maxRowsProvider) this.setMaxRows(this.maxRowsProvider());
    const header = new EqualColumns(
      new Text("Austin", 1, 0),
      new Text("Tony", 1, 0),
    ).render(width)[0] ?? "";
    const rule = new HorizontalRule().render(width)[0];
    const bodyLimit = Math.max(0, this.maxRows - DuoTranscript.FIXED_ROWS);
    const bodyRows = this.columns.render(width);
    const body = bodyLimit ? bodyRows.slice(-bodyLimit) : [];
    // The overlay is non-capturing, so it must still occupy its whole viewport
    // when a transcript is short; otherwise Pi's native transcript shows below it.
    while (body.length < bodyLimit) {
      const divider = Math.floor(Math.max(2, width - 1) / 2);
      // Keep the newest transcript adjacent to Pi's input dock. Padding after
      // short transcripts created a large, misleading dead zone between the
      // visible work and the editor/footer.
      body.unshift(
        compositeTuiLine(" ".repeat(width), "│", divider, 1, width),
      );
    }
    const footer: string[] = [];
    for (let index = 0; index < DuoTranscript.FOOTER_ROWS; index++) {
      footer.push(new EqualColumns(
        new Text(this.austinFooter[index] ?? "·", 1, 0),
        new Text(this.tonyFooter[index] ?? "·", 1, 0),
      ).render(width)[0] ?? "");
    }
    // Keep metadata next to the top-anchored header. Pi's bottom dock can grow
    // while tools/widgets update; footer rows placed at the overlay's lower
    // edge were intermittently painted over by that dock.
    const notice = new Text(this.notice || " ", 1, 0).render(width)[0] ?? "";
    return [header, rule, notice, ...footer, rule, ...body, rule];
  }

  invalidate(): void {
    this.columns.invalidate();
  }

  /** Rebuild from persisted/live message objects; safe for stream updates. */
  update(austin: SessionTranscript, tony: SessionTranscript): void {
    this.updateSide("austin", austin);
    this.updateSide("tony", tony);
    this.updateFooters(austin.footer, tony.footer);
    this.invalidate();
  }

  /** Rebuild only the agent whose live transcript changed. */
  updateSide(side: "austin" | "tony", transcript: SessionTranscript): void {
    const document = side === "austin" ? this.austinDocument : this.tonyDocument;
    const column = side === "austin" ? this.austinColumn : this.tonyColumn;
    this.renderSession(document, transcript);
    column.scrollToEnd();
  }

  /** Update animated metadata without rebuilding either transcript tree. */
  updateFooters(
    austin: readonly string[] | undefined,
    tony: readonly string[] | undefined,
  ): void {
    this.austinFooter = austin ?? [];
    this.tonyFooter = tony ?? [];
  }

  setNotice(notice?: string): void {
    this.notice = notice ?? "";
  }

  /** Full-width Austin rows sampled only at stable layout boundaries. */
  austinDocumentRows(width: number): number {
    return this.austinDocument.render(Math.max(1, width)).length;
  }

  private renderSession(document: VStack, transcript: SessionTranscript): void {
    document.clear();
    const pending = new Map<string, ToolExecutionComponent>();
    const rendered = new Set<string>();
    for (const message of transcript.messages) {
      if (message?.role === "assistant") {
        if (!Array.isArray(message.content)) continue;
        const preview = toWorkbenchPreview(message);
        const assistant = new AssistantMessageComponent(preview);
        if (message === transcript.streaming) assistant.updateContent(preview, true);
        document.addChild(assistant);
        for (const content of preview.content ?? []) {
          if (content?.type !== "toolCall") continue;
          // Tool registries are session-private. Undefined selects Pi's native
          // fallback renderer, which is the correct cross-session renderer.
          const tool = new ToolExecutionComponent(
            content.name, content.id, content.arguments, undefined, undefined,
            this.tui, this.cwd,
          );
          tool.setArgsComplete();
          document.addChild(tool);
          pending.set(content.id, tool);
          rendered.add(content.id);
          this.applyLiveTool(tool, transcript.tools?.get(content.id));
        }
      } else if (message?.role === "toolResult") {
        pending.get(message.toolCallId)?.updateResult(toWorkbenchPreview(message));
        pending.delete(message.toolCallId);
      } else if (message?.role === "user") {
        const preview = toWorkbenchPreview(message);
        const text = typeof preview.content === "string"
          ? preview.content
          : (preview.content ?? [])
              .filter((content: any) => content.type === "text")
              .map((content: any) => content.text)
              .join("\n");
        if (text) document.addChild(new UserMessageComponent(text));
      }
    }
    for (const [id, state] of transcript.tools ?? []) {
      if (rendered.has(id)) continue;
      const tool = new ToolExecutionComponent(
        state.name, id, previewToolArguments(state.args), undefined, undefined,
        this.tui, this.cwd,
      );
      tool.setArgsComplete();
      this.applyLiveTool(tool, state);
      document.addChild(tool);
    }
  }

  private applyLiveTool(tool: ToolExecutionComponent, state?: LiveToolState): void {
    if (!state) return;
    if (state.started) tool.markExecutionStarted();
    if (state.partial) tool.updateResult(toWorkbenchPreview(state.partial), true);
    if (state.final) tool.updateResult(toWorkbenchPreview(state.final));
  }
}
