import {
  query,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { AppConfig } from "../config.js";
import type {
  AgentRuntime,
  AgentSession,
  AgentSessionCreateRequest,
  AgentTurnRequest,
} from "../runtime/agentRuntime.js";
import type {
  AgentContextUsage,
  AgentProgressEvent,
  AgentRunResult,
  AgentUsage,
} from "../types.js";
import { getRoleSystemPrompt } from "./rolePrompts.js";

export class ClaudeAgent implements AgentRuntime {
  constructor(private readonly config: AppConfig) {}

  async createSession(request: AgentSessionCreateRequest): Promise<AgentSession> {
    return new LiveClaudeSession(this.config, request);
  }
}

type PendingTurn = {
  request: AgentTurnRequest;
  lastAssistantText: string | null;
  notifiedSessionId: string | null;
  aborted: boolean;
  settle: (result: AgentRunResult) => void;
};

class LiveClaudeSession implements AgentSession {
  private query: Query | null = null;
  private inputQueue = new AsyncPushQueue<SDKUserMessage>();
  private currentTurn: PendingTurn | null = null;
  private readerTask: Promise<void> | null = null;
  private closed = false;
  private recovering = false;
  private latestSessionId: string | null;
  private readonly systemPromptPromise: Promise<string | null>;
  private initTask: Promise<void>;

  constructor(
    private readonly config: AppConfig,
    private readonly request: AgentSessionCreateRequest,
  ) {
    this.latestSessionId = request.sessionId;
    this.systemPromptPromise = getRoleSystemPrompt(request.role);
    this.initTask = this.startQueryAsync(request.sessionId);
  }

  get sessionId(): string | null {
    return this.latestSessionId;
  }

  async sendTask(request: AgentTurnRequest): Promise<AgentRunResult> {
    if (this.closed) {
      throw new Error("Claude 会话已关闭");
    }
    if (this.currentTurn) {
      throw new Error("Claude 会话正在处理上一条消息");
    }

    let result = await this.sendTaskOnce(request);
    if (
      !result.success &&
      this.latestSessionId &&
      shouldResetSession(result.error) &&
      !request.signal.aborted
    ) {
      request.onEvent({
        kind: "log",
        text: "⚠️ 检测到旧会话不可恢复，正在自动重建当前项目会话...",
      });
      await this.recreate(null);
      result = await this.sendTaskOnce(request);
    }

    if (!request.signal.aborted) {
      result.contextUsage = await this.getContextUsage();
    }
    return result;
  }

  async getContextUsage(): Promise<AgentContextUsage | null> {
    if (this.closed || !this.query) {
      return null;
    }

    try {
      return normalizeContextUsage(await this.query.getContextUsage());
    } catch (error) {
      console.warn(
        "[claude-agent] getContextUsage failed:",
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  async interrupt(): Promise<void> {
    const currentQuery = this.query;
    if (!currentQuery || this.closed) {
      return;
    }
    try {
      await currentQuery.interrupt();
    } catch (error) {
      console.warn(
        "[claude-agent] interrupt failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.inputQueue.finish();
    const currentQuery = this.query;
    this.query = null;
    currentQuery?.close();
    try {
      await this.readerTask;
    } catch {
      // Ignore reader shutdown errors during close.
    }
    if (this.currentTurn) {
      this.currentTurn.settle({
        success: false,
        output: "",
        error: "Claude 会话已关闭",
        sessionId: this.latestSessionId ?? undefined,
      });
      this.currentTurn = null;
    }
  }

  private async sendTaskOnce(request: AgentTurnRequest): Promise<AgentRunResult> {
    await this.initTask;
    if (!this.query) {
      await this.recreate(this.latestSessionId);
    }

    const turnResult = await new Promise<AgentRunResult>((resolve) => {
      const turn: PendingTurn = {
        request,
        lastAssistantText: null,
        notifiedSessionId: null,
        aborted: false,
        settle: resolve,
      };
      this.currentTurn = turn;

      const onAbort = () => {
        turn.aborted = true;
        void this.interrupt();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      void this.inputQueue.push({
        type: "user",
        session_id: this.latestSessionId ?? "",
        message: {
          role: "user",
          content: [{ type: "text", text: buildTaskPrompt(request.forcedSkill, request.task) }],
        },
        parent_tool_use_id: null,
      }).catch((error) => {
        request.signal.removeEventListener("abort", onAbort);
        if (this.currentTurn === turn) {
          this.currentTurn = null;
        }
        resolve({
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          sessionId: this.latestSessionId ?? undefined,
        });
      });

      const originalSettle = turn.settle;
      turn.settle = (result) => {
        request.signal.removeEventListener("abort", onAbort);
        originalSettle(result);
      };
    });

    return turnResult;
  }

  private async startQueryAsync(resumeSessionId: string | null): Promise<void> {
    const roleSystemPrompt = await this.systemPromptPromise;
    const env = {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: this.config.apiKey,
      ANTHROPIC_API_KEY: this.config.apiKey,
      API_KEY: this.config.apiKey,
      ...this.config.extraEnv,
      ...(this.config.baseUrl ? { ANTHROPIC_BASE_URL: this.config.baseUrl } : {}),
      ...(this.config.claudeModel ? { ANTHROPIC_MODEL: this.config.claudeModel } : {}),
    };
    const currentQuery = query({
      prompt: this.inputQueue,
      options: {
        cwd: this.request.cwd,
        ...(this.config.claudeModel ? { model: this.config.claudeModel } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project", "user"],
        tools: { type: "preset", preset: "claude_code" },
        ...(roleSystemPrompt ? { appendSystemPrompt: roleSystemPrompt } : {}),
        stderr: (data) => {
          const line = data.trim();
          if (line && this.currentTurn) {
            this.currentTurn.request.onEvent({ kind: "log", text: line });
          }
        },
        env,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      },
    });

    this.query = currentQuery;
    this.readerTask = this.consumeMessages(currentQuery);
  }

  private async recreate(resumeSessionId: string | null): Promise<void> {
    if (this.recovering) {
      return;
    }
    this.recovering = true;
    try {
      this.inputQueue.finish();
      this.query?.close();
      try {
        await this.readerTask;
      } catch {
        // Ignore shutdown race while recreating the session.
      }
      this.inputQueue = new AsyncPushQueue<SDKUserMessage>();
      this.query = null;
      this.readerTask = null;
      this.latestSessionId = resumeSessionId;
      this.initTask = this.startQueryAsync(resumeSessionId);
      await this.initTask;
    } finally {
      this.recovering = false;
    }
  }

  private async consumeMessages(stream: Query): Promise<void> {
    try {
      for await (const message of stream) {
        this.latestSessionId = maybeSessionId(message) ?? this.latestSessionId;
        logMessage(message);
        this.handleActiveTurnMessage(message);
      }

      if (!this.closed && this.currentTurn) {
        const turn = this.currentTurn;
        this.currentTurn = null;
        turn.settle({
          success: false,
          output: "",
          error: "Claude 会话已意外结束",
          sessionId: this.latestSessionId ?? undefined,
        });
      }
      if (!this.closed) {
        this.query = null;
      }
    } catch (error) {
      if (!this.closed && this.currentTurn) {
        const turn = this.currentTurn;
        this.currentTurn = null;
        turn.settle({
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          sessionId: this.latestSessionId ?? undefined,
        });
      }
      if (!this.closed) {
        this.query = null;
      }
    }
  }

  private handleActiveTurnMessage(message: SDKMessage): void {
    const turn = this.currentTurn;
    if (!turn) {
      return;
    }

    if (this.latestSessionId && turn.notifiedSessionId !== this.latestSessionId) {
      turn.notifiedSessionId = this.latestSessionId;
      turn.request.onEvent({ kind: "session", sessionId: this.latestSessionId });
    }

    if (message.type === "assistant") {
      turn.lastAssistantText = extractAssistantReply(message) ?? turn.lastAssistantText;
    }

    handleMessage(message, turn.request.onEvent);

    if (message.type !== "result") {
      return;
    }

    this.currentTurn = null;
    if (turn.aborted) {
      turn.settle({
        success: false,
        output: "",
        error: "任务已取消",
        usage: normalizeUsage(message.usage),
        sessionId: this.latestSessionId ?? undefined,
      });
      return;
    }

    if (message.subtype === "success") {
      turn.settle({
        success: true,
        output: turn.lastAssistantText ?? message.result,
        usage: normalizeUsage(message.usage),
        sessionId: this.latestSessionId ?? undefined,
      });
      return;
    }

    turn.settle({
      success: false,
      output: "",
      error: message.errors.join("\n") || "Claude Agent 执行失败",
      usage: normalizeUsage(message.usage),
      sessionId: this.latestSessionId ?? undefined,
    });
  }
}

function buildTaskPrompt(forcedSkill: string | undefined, task: string): string {
  if (!forcedSkill) {
    return task;
  }
  return `/${forcedSkill} ${task}`;
}

function handleMessage(
  message: SDKMessage,
  onEvent: (event: AgentProgressEvent) => void,
): void {
  switch (message.type) {
    case "tool_progress":
      onEvent({
        kind: "tool",
        text: `🛠️ ${message.tool_name} (${message.elapsed_time_seconds}s)`,
      });
      return;
    case "tool_use_summary":
      onEvent({ kind: "tool", text: `🛠️ ${message.summary}` });
      return;
    case "system":
      if (message.subtype === "task_started") {
        onEvent({ kind: "log", text: `▶️ ${message.description}` });
      } else if (message.subtype === "task_progress") {
        onEvent({ kind: "log", text: `↳ ${message.summary ?? message.description}` });
      } else if (message.subtype === "task_notification") {
        onEvent({ kind: "log", text: `${message.status}: ${message.summary}` });
      }
      return;
    default:
      return;
  }
}

function extractAssistantText(message: Extract<SDKMessage, { type: "assistant" }>): string | null {
  const text = extractAssistantReply(message);
  if (!text) {
    return null;
  }
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function extractAssistantReply(
  message: Extract<SDKMessage, { type: "assistant" }>,
): string | null {
  const blocks = Array.isArray(message.message.content) ? message.message.content : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "object" && block !== null && "type" in block) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  const text = parts.join("\n").trim();
  if (!text) {
    return null;
  }
  return text;
}

function maybeSessionId(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string"
    ? message.session_id
    : undefined;
}

function normalizeUsage(usage: unknown): AgentUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const usageRecord = usage as Record<string, unknown>;
  const cacheCreation = usageRecord.cache_creation;
  const cacheRead = usageRecord.cache_read;
  return {
    input_tokens:
      typeof usageRecord.input_tokens === "number" ? usageRecord.input_tokens : undefined,
    output_tokens:
      typeof usageRecord.output_tokens === "number" ? usageRecord.output_tokens : undefined,
    cache_creation_input_tokens:
      typeof usageRecord.cache_creation_input_tokens === "number"
        ? usageRecord.cache_creation_input_tokens
        : typeof cacheCreation === "object" &&
            cacheCreation !== null &&
            "ephemeral_1h_input_tokens" in cacheCreation &&
            typeof cacheCreation.ephemeral_1h_input_tokens === "number"
          ? cacheCreation.ephemeral_1h_input_tokens
          : undefined,
    cache_read_input_tokens:
      typeof usageRecord.cache_read_input_tokens === "number"
        ? usageRecord.cache_read_input_tokens
        : typeof cacheRead === "object" &&
            cacheRead !== null &&
            "ephemeral_1h_input_tokens" in cacheRead &&
            typeof cacheRead.ephemeral_1h_input_tokens === "number"
          ? cacheRead.ephemeral_1h_input_tokens
          : undefined,
  };
}

function normalizeContextUsage(
  usage: SDKControlGetContextUsageResponse,
): AgentContextUsage {
  return {
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    percentage: usage.percentage,
    model: usage.model,
    categories: usage.categories.map((category) => ({
      name: category.name,
      tokens: category.tokens,
    })),
    messageBreakdown: usage.messageBreakdown
      ? {
          toolCallTokens: usage.messageBreakdown.toolCallTokens,
          toolResultTokens: usage.messageBreakdown.toolResultTokens,
          attachmentTokens: usage.messageBreakdown.attachmentTokens,
          assistantMessageTokens: usage.messageBreakdown.assistantMessageTokens,
          userMessageTokens: usage.messageBreakdown.userMessageTokens,
        }
      : undefined,
    memoryFiles: usage.memoryFiles,
    slashCommands: usage.slashCommands
      ? {
          totalCommands: usage.slashCommands.totalCommands,
          includedCommands: usage.slashCommands.includedCommands,
          tokens: usage.slashCommands.tokens,
        }
      : undefined,
    skills: usage.skills
      ? {
          totalSkills: usage.skills.totalSkills,
          includedSkills: usage.skills.includedSkills,
          tokens: usage.skills.tokens,
        }
      : undefined,
  };
}

function shouldResetSession(error?: string): boolean {
  if (!error) {
    return false;
  }
  const normalized = error.toLowerCase();
  return (
    normalized.includes("resume") ||
    normalized.includes("session") ||
    normalized.includes("not found") ||
    normalized.includes("invalid uuid")
  );
}

function logMessage(message: SDKMessage): void {
  switch (message.type) {
    case "tool_progress":
      console.log(`  🛠️ [tool] ${message.tool_name} (${message.elapsed_time_seconds}s)`);
      return;
    case "tool_use_summary":
      console.log(`  🛠️ [tool] ${message.summary}`);
      return;
    case "system":
      if (message.subtype === "task_started") {
        console.log(`  ▶️ [system] ${message.description}`);
      } else if (message.subtype === "task_progress") {
        console.log(`  ↳ [progress] ${message.summary ?? message.description}`);
      } else if (message.subtype === "task_notification") {
        console.log(`  📢 [notification] ${message.status}: ${message.summary}`);
      }
      return;
    case "assistant": {
      const text = extractAssistantText(message);
      if (text) {
        console.log(`  💬 [assistant] ${text}`);
      }
      return;
    }
    case "result":
      if (message.subtype !== "success") {
        console.log(`  ⚠️ [result] ${message.errors.join(", ")}`);
      }
      return;
    default:
      return;
  }
}

class AsyncPushQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private finished = false;

  async push(value: T): Promise<void> {
    if (this.finished) {
      throw new Error("输入流已关闭");
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.buffered.push(value);
  }

  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.buffered.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.finished) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}
