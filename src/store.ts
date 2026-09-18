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
  maxConsecutivePeerTurns: 3,
  similarityThreshold: 0.9,
  autoDispatch: true,
  writePolicy: "austin-only",
};

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
  private readonly lockPath: string;

  constructor(cwd: string) {
    this.dir = path.join(cwd, ".pi-duo");
    this.statePath = path.join(this.dir, "state.json");
    this.configPath = path.join(this.dir, "config.json");
    this.messagesPath = path.join(this.dir, "messages.jsonl");
    this.decisionsPath = path.join(this.dir, "decisions.md");
    this.lockPath = path.join(this.dir, ".lock");
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async readConfig(): Promise<DuoConfig> {
    await this.ensure();
    try {
      const parsed = JSON.parse(
        await readFile(this.configPath, "utf8"),
      ) as Partial<DuoConfig>;
      const config = { ...DEFAULT_CONFIG, ...parsed };
      if (
        config.writePolicy !== "austin-only" &&
        config.writePolicy !== "transferable"
      )
        config.writePolicy = DEFAULT_CONFIG.writePolicy;
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...DEFAULT_CONFIG };
    }
  }

  async writeConfig(config: DuoConfig): Promise<void> {
    await this.atomicWrite(
      this.configPath,
      JSON.stringify(config, null, 2) + "\n",
    );
  }

  async readState(): Promise<DuoState | undefined> {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8")) as DuoState;
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
      const lines = (await readFile(this.messagesPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line) as PeerMessage);
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
  return `## Duo shared state (revision ${state.revision})\nGOAL\n${state.goal || "(not set)"}\n\nTODO\n${todos}\n\nDURABLE DECISIONS\n${decisions}\n\nWorkspace write owner: ${state.workspaceOwner ?? "none"}`;
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

export function isMutatingShell(command: string): boolean {
  const withoutNonFileRedirects = command
    .replace(/\d*>>?\s*\/dev\/null\b/gu, "")
    .replace(/\d*>\s*&\d+\b/gu, "");
  return /(^|[;&|]\s*|\b)(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|git\s+(add|commit|checkout|switch|reset|clean|merge|rebase|apply)|npm\s+(install|uninstall)|pnpm\s+(add|remove|install)|yarn\s+(add|remove|install)|tee|truncate)\b|(^|[^<])>>?|\bsed\s+-i\b/iu.test(
    withoutNonFileRedirects,
  );
}

export function otherAgent(actor: AgentId): AgentId {
  return actor === "austin" ? "tony" : "austin";
}
