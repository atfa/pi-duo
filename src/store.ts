import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentId,
  DuoConfig,
  DuoState,
  ModelRef,
  PeerMessage,
} from "./types.js";

export const DEFAULT_CONFIG: DuoConfig = {
  maxPeerMessagesPerTurn: 6,
  maxDeferredMessagesPerTurn: 2,
  maxConsecutivePeerTurns: 3,
  similarityThreshold: 0.9,
  autoDispatch: true,
  writePolicy: "austin-only",
};

export const MIN_PEER_MESSAGES_PER_TURN = 4;

export function normalizeConfig(config: DuoConfig): DuoConfig {
  const normalized = { ...config };
  if (
    !Number.isSafeInteger(normalized.maxPeerMessagesPerTurn) ||
    normalized.maxPeerMessagesPerTurn < MIN_PEER_MESSAGES_PER_TURN
  )
    normalized.maxPeerMessagesPerTurn = MIN_PEER_MESSAGES_PER_TURN;
  if (
    !Number.isSafeInteger(normalized.maxDeferredMessagesPerTurn) ||
    normalized.maxDeferredMessagesPerTurn < 0
  )
    normalized.maxDeferredMessagesPerTurn =
      DEFAULT_CONFIG.maxDeferredMessagesPerTurn;
  if (
    !Number.isSafeInteger(normalized.maxConsecutivePeerTurns) ||
    normalized.maxConsecutivePeerTurns < 1
  )
    normalized.maxConsecutivePeerTurns =
      DEFAULT_CONFIG.maxConsecutivePeerTurns;
  if (
    !Number.isFinite(normalized.similarityThreshold) ||
    normalized.similarityThreshold < 0 ||
    normalized.similarityThreshold > 1
  )
    normalized.similarityThreshold = DEFAULT_CONFIG.similarityThreshold;
  if (
    normalized.writePolicy !== "austin-only" &&
    normalized.writePolicy !== "transferable"
  )
    normalized.writePolicy = DEFAULT_CONFIG.writePolicy;
  return normalized;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

export function parseModelRef(value: string): ModelRef {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) {
    throw new Error(`Expected provider/model, received: ${value}`);
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export class DuoStore {
  readonly dir: string;
  readonly statePath: string;
  readonly configPath: string;
  readonly messagesPath: string;
  readonly decisionsPath: string;
  readonly tonyScratchDir: string;
  private readonly lockPath: string;

  constructor(cwd: string) {
    this.dir = path.join(cwd, ".pi-duo");
    this.statePath = path.join(this.dir, "state.json");
    this.configPath = path.join(this.dir, "config.json");
    this.messagesPath = path.join(this.dir, "messages.jsonl");
    this.decisionsPath = path.join(this.dir, "decisions.md");
    this.tonyScratchDir = path.join(this.dir, "tmp", "tony");
    this.lockPath = path.join(this.dir, ".lock");
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async ensureTonyScratch(): Promise<void> {
    await mkdir(this.tonyScratchDir, { recursive: true });
  }

  isTonyScratchPath(candidate: string): boolean {
    if (!candidate.trim()) return false;
    const projectDir = path.dirname(this.dir);
    const resolved = path.resolve(projectDir, candidate);
    const relative = path.relative(this.tonyScratchDir, resolved);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  }

  async readConfig(): Promise<DuoConfig> {
    await this.ensure();
    try {
      const parsed = JSON.parse(
        await readFile(this.configPath, "utf8"),
      ) as Partial<DuoConfig>;
      return normalizeConfig({ ...DEFAULT_CONFIG, ...parsed });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...DEFAULT_CONFIG };
    }
  }

  async writeConfig(config: DuoConfig): Promise<void> {
    await this.atomicWrite(
      this.configPath,
      JSON.stringify(normalizeConfig(config), null, 2) + "\n",
    );
  }

  async readState(): Promise<DuoState | undefined> {
    try {
      const state = JSON.parse(await readFile(this.statePath, "utf8")) as DuoState;
      // Backfill directional counters for states created before this metric
      // existed. Counts are derived only from this Duo run's audit messages.
      if (
        state.austinPeerMessageCount === undefined ||
        state.tonyPeerMessageCount === undefined
      ) {
        try {
          const lines = (await readFile(this.messagesPath, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean);
          let austin = 0;
          let tony = 0;
          for (const line of lines) {
            const message = JSON.parse(line) as PeerMessage;
            if (message.timestamp < state.createdAt) continue;
            if (message.from === "austin") austin++;
            if (message.from === "tony") tony++;
          }
          state.austinPeerMessageCount ??= austin;
          state.tonyPeerMessageCount ??= tony;
        } catch {
          state.austinPeerMessageCount ??= 0;
          state.tonyPeerMessageCount ??= 0;
        }
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async enforceWritePolicy(config: DuoConfig): Promise<DuoState | undefined> {
    const state = await this.readState();
    if (
      !state ||
      config.writePolicy !== "austin-only" ||
      state.workspaceOwner === "austin"
    )
      return state;
    return this.update((draft) => {
      draft.workspaceOwner = "austin";
    });
  }

  async create(austin: ModelRef, tony: ModelRef): Promise<DuoState> {
    const timestamp = now();
    const state: DuoState = {
      version: 1,
      revision: 0,
      userTurn: 0,
      sessionId: randomUUID(),
      goal: "",
      todo: [],
      decisions: [],
      agents: {
        austin: {
          name: "Austin",
          provider: austin.provider,
          modelId: austin.modelId,
        },
        tony: { name: "Tony", provider: tony.provider, modelId: tony.modelId },
      },
      status: "active",
      workspaceOwner: "austin",
      peerMessageCount: 0,
      austinPeerMessageCount: 0,
      tonyPeerMessageCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActivityAt: timestamp,
    };
    await this.withLock(async () => {
      await this.atomicWrite(
        this.statePath,
        JSON.stringify(state, null, 2) + "\n",
      );
      await this.writeDecisions(state);
    });
    return state;
  }

  async update(
    mutator: (state: DuoState) => void,
    expectedRevision?: number,
  ): Promise<DuoState> {
    return this.withLock(async () => {
      const state = await this.readState();
      if (!state) throw new Error("Duo has not been started");
      if (
        expectedRevision !== undefined &&
        state.revision !== expectedRevision
      ) {
        throw new Error(
          `State changed: expected revision ${expectedRevision}, current ${state.revision}`,
        );
      }
      mutator(state);
      state.revision += 1;
      state.updatedAt = now();
      state.lastActivityAt = state.updatedAt;
      await this.atomicWrite(
        this.statePath,
        JSON.stringify(state, null, 2) + "\n",
      );
      await this.writeDecisions(state);
      return state;
    });
  }

  /**
   * Atomically advances the audit sequence. For legacy states, recover the
   * high-water mark from both review state and the complete message log.
   */
  async advanceUserTurn(): Promise<number> {
    return this.withLock(async () => {
      const state = await this.readState();
      if (!state) throw new Error("Duo has not been started");
      let highWaterMark = Math.max(
        Number.isSafeInteger(state.userTurn) ? state.userTurn ?? 0 : 0,
        state.review?.userTurn ?? 0,
      );
      for (const message of await this.recentMessages(Number.MAX_SAFE_INTEGER)) {
        if (Number.isSafeInteger(message.userTurn))
          highWaterMark = Math.max(highWaterMark, message.userTurn);
      }
      state.userTurn = highWaterMark + 1;
      state.revision += 1;
      state.updatedAt = now();
      state.lastActivityAt = state.updatedAt;
      await this.atomicWrite(
        this.statePath,
        JSON.stringify(state, null, 2) + "\n",
      );
      return state.userTurn;
    });
  }

  async appendMessage(
    message: Omit<PeerMessage, "id" | "timestamp">,
  ): Promise<PeerMessage> {
    return this.withLock(async () => {
      const full: PeerMessage = {
        ...message,
        id: randomUUID(),
        timestamp: now(),
      };
      const file = await open(this.messagesPath, "a");
      try {
        await file.writeFile(JSON.stringify(full) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      const state = await this.readState();
      if (state) {
        state.peerMessageCount += 1;
        if (full.from === "austin")
          state.austinPeerMessageCount =
            (state.austinPeerMessageCount ?? 0) + 1;
        else
          state.tonyPeerMessageCount =
            (state.tonyPeerMessageCount ?? 0) + 1;
        state.revision += 1;
        state.updatedAt = full.timestamp;
        state.lastActivityAt = full.timestamp;
        await this.atomicWrite(
          this.statePath,
          JSON.stringify(state, null, 2) + "\n",
        );
      }
      return full;
    });
  }

  async recentMessages(limit = 20): Promise<PeerMessage[]> {
    try {
      const state = await this.readState();
      const createdAt = state?.createdAt;
      const lines = (await readFile(this.messagesPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      return lines
        .map((line) => JSON.parse(line) as PeerMessage)
        .filter(
          (message) => !createdAt || message.timestamp >= createdAt,
        )
        .slice(-limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeDecisions(state: DuoState): Promise<void> {
    const body = [
      "# Duo Decisions",
      "",
      ...state.decisions.map(
        (d) =>
          `## ${d.id}. ${d.text}\n\n- Author: ${d.author === "austin" ? "Austin" : "Tony"}\n- Time: ${d.createdAt}${d.evidence ? `\n- Evidence: ${d.evidence}` : ""}\n`,
      ),
    ].join("\n");
    await this.atomicWrite(this.decisionsPath, body + "\n");
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    await this.ensure();
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, content, "utf8");
    await rename(temp, target);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensure();
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        await mkdir(this.lockPath);
        try {
          return await operation();
        } finally {
          await rm(this.lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockAge = Date.now() - (await stat(this.lockPath)).mtimeMs;
          if (lockAge > 30_000) {
            await rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT")
            throw statError;
        }
        if (attempt === 149)
          throw new Error("Timed out waiting for the pi-duo state lock");
        await sleep(20);
      }
    }
    throw new Error("Unable to acquire pi-duo state lock");
  }
}

export function formatSharedContext(state: DuoState): string {
  const todos = state.todo.length
    ? state.todo
        .map(
          (item) =>
            `- [${item.status}] #${item.id} ${item.text}${item.owner ? ` (${item.owner})` : ""}`,
        )
        .join("\n")
    : "- (none)";
  const decisions =
    state.decisions
      .slice(-8)
      .map((d) => `- #${d.id} ${d.text}`)
      .join("\n") || "- (none)";
  const review = state.review
    ? `${state.review.status} (user turn ${state.review.userTurn})${state.review.error ? ` — ${state.review.error}` : ""}`
    : "not started";
  return `## Duo shared state (revision ${state.revision})\nGOAL\n${state.goal || "(not set)"}\n\nTODO\n${todos}\n\nDURABLE DECISIONS\n${decisions}\n\nTony review: ${review}\nWorkspace write owner: ${state.workspaceOwner ?? "none"}`;
}

export function textSimilarity(a: string, b: string): number {
  const tokenize = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(/\s+/)
        .filter(Boolean),
    );
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

export function isWaitingShell(command: string): boolean {
  return /(^|[;&|]\s*|\b)(sleep|watch)\b|\btail\s+(-[^\s]*f[^\s]*|--follow)\b/iu.test(
    command,
  );
}

function maskQuotedShellText(command: string): string {
  const characters = command.split("");
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index];
    if (quote) {
      characters[index] = character === "\n" ? "\n" : " ";
      if (character === "\\" && quote === '"' && index + 1 < characters.length) {
        index++;
        if (characters[index] !== "\n") characters[index] = " ";
      } else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\\" && index + 1 < characters.length) {
      characters[index] = " ";
      index++;
      if (characters[index] !== "\n") characters[index] = " ";
    } else if (character === "'" || character === '"') {
      quote = character;
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function maskHereDocumentBodies(command: string): string {
  const lines = command.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let delimiter: string | undefined;
  let stripTabs = false;
  return lines
    .map((line) => {
      const content = line.endsWith("\n") ? line.slice(0, -1) : line;
      if (delimiter) {
        const candidate = stripTabs ? content.replace(/^\t+/u, "") : content;
        if (candidate.trimEnd() === delimiter) delimiter = undefined;
        return `${" ".repeat(content.length)}${line.endsWith("\n") ? "\n" : ""}`;
      }
      const visible = maskQuotedShellText(line);
      const heredoc = /<<(-)?\s*(?!<)(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w]*))/gu;
      for (const match of line.matchAll(heredoc)) {
        if (visible.slice(match.index, match.index + 2) !== "<<") continue;
        stripTabs = match[1] === "-";
        delimiter = match[2] ?? match[3] ?? match[4];
        break;
      }
      return line;
    })
    .join("");
}

function quotedShellScripts(command: string): string[] {
  const visible = maskQuotedShellText(command);
  const scripts: string[] = [];
  for (const match of command.matchAll(
    /\b(?:bash|zsh|ksh|sh)\s+-c\s+(['"])([\s\S]*?)\1/giu,
  )) {
    if (visible[match.index] !== " ") scripts.push(match[2] ?? "");
  }
  return scripts;
}

export function isMutatingShell(command: string): boolean {
  if (quotedShellScripts(command).some((script) => isMutatingShell(script)))
    return true;
  const inlineInterpreterWrite =
    /\b(?:node|python(?:3)?|ruby|perl)\b[\s\S]*?(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|\.write_text\s*\(|\.write_bytes\s*\(|\bopen\s*\([^)]*,\s*["'][wax+]|File\.(?:write|open)|syswrite|\bunlink\s*\(|\brename\s*\(|\bmkdir\s*\()/iu;
  if (inlineInterpreterWrite.test(command)) return true;
  const visible = maskQuotedShellText(maskHereDocumentBodies(command));
  const withoutNonFileRedirects = visible
    .replace(/\d*>>?\s*\/dev\/null\b/gu, "")
    .replace(/\d*>\s*&\d+\b/gu, "");
  return /(^|[;&|]\s*|\b)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|install|ln|git\s+(add|commit|checkout|switch|reset|clean|merge|rebase|apply)|npm\s+(install|uninstall)|pnpm\s+(add|remove|install)|yarn\s+(add|remove|install)|tee|truncate)\b|(^|[^<=>])>>?(?!=)|\bsed\s+-i\b|\bperl\s+-[^\s]*i|\bdd\b[^\n;&|]*\bof\s*=/iu.test(
    withoutNonFileRedirects,
  );
}

export function otherAgent(actor: AgentId): AgentId {
  return actor === "austin" ? "tony" : "austin";
}
