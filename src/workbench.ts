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
  private maxRows = 12;
  private static readonly FOOTER_ROWS = 3;
  private static readonly FIXED_ROWS = 1 + 1 + 1 + DuoTranscript.FOOTER_ROWS + 1;

  constructor(private readonly tui: TUI, private readonly cwd: string) {
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
    const header = new EqualColumns(
      new Text("Austin", 1, 0),
      new Text("Tony", 1, 0),
    ).render(width)[0] ?? "";
    const rule = new HorizontalRule().render(width)[0];
    const bodyLimit = Math.max(0, this.maxRows - DuoTranscript.FIXED_ROWS);
    const bodyRows = this.columns.render(width);
    const body = bodyLimit ? bodyRows.slice(-bodyLimit) : [];
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
    return [header, rule, ...footer, rule, ...body, rule];
  }

  invalidate(): void {
    this.columns.invalidate();
  }

  /** Rebuild from persisted/live message objects; safe for stream updates. */
  update(austin: SessionTranscript, tony: SessionTranscript): void {
    this.renderSession(this.austinDocument, austin);
    this.renderSession(this.tonyDocument, tony);
    this.updateFooters(austin.footer, tony.footer);
    this.austinColumn.scrollToEnd();
    this.tonyColumn.scrollToEnd();
    this.invalidate();
  }

  /** Update animated metadata without rebuilding either transcript tree. */
  updateFooters(
    austin: readonly string[] | undefined,
    tony: readonly string[] | undefined,
  ): void {
    this.austinFooter = austin ?? [];
    this.tonyFooter = tony ?? [];
  }

  private renderSession(document: VStack, transcript: SessionTranscript): void {
    document.clear();
    const pending = new Map<string, ToolExecutionComponent>();
    const rendered = new Set<string>();
    for (const message of transcript.messages) {
      if (message?.role === "assistant") {
        if (!Array.isArray(message.content)) continue;
        const assistant = new AssistantMessageComponent(message);
        if (message === transcript.streaming) assistant.updateContent(message, true);
        document.addChild(assistant);
        for (const content of message.content ?? []) {
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
        pending.get(message.toolCallId)?.updateResult(message);
        pending.delete(message.toolCallId);
      } else if (message?.role === "user") {
        const text = typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .filter((content: any) => content.type === "text")
              .map((content: any) => content.text)
              .join("\n");
        if (text) document.addChild(new UserMessageComponent(text));
      }
    }
    for (const [id, state] of transcript.tools ?? []) {
      if (rendered.has(id)) continue;
      const tool = new ToolExecutionComponent(
        state.name, id, state.args, undefined, undefined, this.tui, this.cwd,
      );
      tool.setArgsComplete();
      this.applyLiveTool(tool, state);
      document.addChild(tool);
    }
  }

  private applyLiveTool(tool: ToolExecutionComponent, state?: LiveToolState): void {
    if (!state) return;
    if (state.started) tool.markExecutionStarted();
    if (state.partial) tool.updateResult(state.partial, true);
    if (state.final) tool.updateResult(state.final);
  }
}
