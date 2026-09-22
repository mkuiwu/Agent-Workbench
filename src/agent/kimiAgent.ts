import {
  createSession,
  type ApprovalRequestPayload,
  type QuestionRequest,
  type Session,
  type StreamEvent,
  type Turn,
} from "@moonshot-ai/kimi-agent-sdk";

import type { AppConfig } from "../config.js";
import type {
  AgentRuntime,
  AgentSession,
  AgentSessionCreateRequest,
  AgentTurnRequest,
} from "../runtime/agentRuntime.js";
import type {
  AgentContextUsage,
  AgentRunResult,
  AgentUsage,
} from "../types.js";
import { getRoleSystemPrompt } from "./rolePrompts.js";

export class KimiAgent implements AgentRuntime {
  constructor(private readonly config: AppConfig) {}

  async createSession(request: AgentSessionCreateRequest): Promise<AgentSession> {
    return new KimiLiveSession(this.config, request);
  }
}

type PendingTurn = {
  request: AgentTurnRequest;
  lastText: string;
  thinkBuffer: string;
  aborted: boolean;
  fatalError?: string;
  settle: (result: AgentRunResult) => void;
  turn?: Turn;
};

class KimiLiveSession implements AgentSession {
  private session: Session | null = null;
  private currentTurn: PendingTurn | null = null;
  private closed = false;
  private latestSessionId: string | null;
  private latestUsage: AgentUsage | undefined;
  private latestContextUsage: AgentContextUsage | null = null;
  private readonly roleSystemPromptPromise: Promise<string | null>;
  private rolePromptInjected = false;

  constructor(
    private readonly config: AppConfig,
    private readonly request: AgentSessionCreateRequest,
  ) {
    this.latestSessionId = request.sessionId;
    this.roleSystemPromptPromise = getRoleSystemPrompt(request.role);
    this.session = createSession({
      workDir: request.cwd,
      sessionId: request.sessionId ?? undefined,
      ...(this.config.kimiModel ? { model: this.config.kimiModel } : {}),
      ...(this.config.kimiThinking !== undefined ? { thinking: this.config.kimiThinking } : {}),
      skillsDir: this.config.skillsRoot,
      yoloMode: true,
      executable: this.config.kimiExecutable,
      env: process.env as Record<string, string>,
    });
    this.latestSessionId = this.session.sessionId;
  }

  get sessionId(): string | null {
    return this.latestSessionId;
  }

  async sendTask(request: AgentTurnRequest): Promise<AgentRunResult> {
    if (this.closed || !this.session) {
      throw new Error("Kimi 会话已关闭");
    }
    if (this.currentTurn) {
      throw new Error("Kimi 会话正在处理上一条消息");
    }

    // 每轮任务前清空上一轮统计
    this.latestUsage = undefined;
    this.latestContextUsage = null;

    return new Promise<AgentRunResult>((resolve) => {
      const turn: PendingTurn = {
        request,
        lastText: "",
        thinkBuffer: "",
        aborted: false,
        settle: resolve,
      };
      this.currentTurn = turn;

      const onAbort = () => {
        turn.aborted = true;
        // 立即中断 turn
        if (turn.turn) {
          void turn.turn.interrupt();
        }
      };
      request.signal.addEventListener("abort", onAbort, { once: true });

      const originalSettle = turn.settle;
      turn.settle = (result) => {
        request.signal.removeEventListener("abort", onAbort);
        this.currentTurn = null;
        originalSettle(result);
      };

      void this.runTurn(request, turn);
    });
  }

  private async runTurn(request: AgentTurnRequest, pending: PendingTurn): Promise<void> {
    if (!this.session) {
      pending.settle({
        success: false,
        output: "",
        error: "会话未初始化",
        sessionId: this.latestSessionId ?? undefined,
      });
      return;
    }

    const content = request.forcedSkill
      ? `/skill:${request.forcedSkill} ${request.task}`
      : request.task;
    const roleSystemPrompt = await this.roleSystemPromptPromise;
    const finalContent =
      !this.rolePromptInjected && roleSystemPrompt
        ? [
            "以下是当前 agent 的固定角色系统指令，请在本会话后续执行中持续遵守：",
            roleSystemPrompt,
            "",
            "以下是当前任务：",
            content,
          ].join("\n")
        : content;
    const turn = this.session.prompt(finalContent);
    pending.turn = turn;
    this.rolePromptInjected = true;

    try {
      for await (const event of turn) {
        if (pending.aborted) {
          break;
        }
        this.handleEvent(event, pending);
      }

      const result = await turn.result;
      this.flushThinkBuffer(pending);
      const wasAborted = pending.aborted;

      if (pending.fatalError) {
        pending.settle({
          success: false,
          output: pending.lastText,
          error: pending.fatalError,
          usage: this.latestUsage,
          contextUsage: this.latestContextUsage,
          sessionId: this.latestSessionId ?? undefined,
        });
        return;
      }

      if (wasAborted || result.status === "cancelled") {
        pending.settle({
          success: false,
          output: "",
          error: "任务已取消",
          usage: this.latestUsage,
          contextUsage: this.latestContextUsage,
          sessionId: this.latestSessionId ?? undefined,
        });
        return;
      }

      if (result.status === "max_steps_reached") {
        pending.settle({
          success: false,
          output: pending.lastText,
          error: "达到最大步数限制",
          usage: this.latestUsage,
          contextUsage: this.latestContextUsage,
          sessionId: this.latestSessionId ?? undefined,
        });
        return;
      }

      pending.settle({
        success: true,
        output: pending.lastText,
        usage: this.latestUsage,
        contextUsage: this.latestContextUsage,
        sessionId: this.latestSessionId ?? undefined,
      });
    } catch (error) {
      this.flushThinkBuffer(pending);
      const message = error instanceof Error ? error.message : String(error);
      pending.settle({
        success: false,
        output: pending.lastText,
        error: message,
        usage: this.latestUsage,
        contextUsage: this.latestContextUsage,
        sessionId: this.latestSessionId ?? undefined,
      });
    }
  }

  private handleEvent(event: StreamEvent, pending: PendingTurn): void {
    // 跳过解析错误
    if (event.type === "error") {
      const message = (event as { message?: string }).message ?? "unknown";
      // MCP 加载事件在 SDK 0.1.6 中尚未支持，属于无害警告，静默忽略
      if (message.includes("MCPLoadingBegin") || message.includes("MCPLoadingEnd")) {
        return;
      }
      console.warn("[kimi-agent] Parse error:", message);
      return;
    }

    // 处理请求类型（ApprovalRequest / QuestionRequest）
    if (event.type === "ApprovalRequest" || event.type === "QuestionRequest") {
      this.handleRequest(event, pending);
      return;
    }

    // 使用类型守卫处理事件
    switch (event.type) {
      case "TurnBegin":
        pending.request.onEvent({ kind: "log", text: "▶️ 开始执行" });
        break;

      case "StepBegin": {
        const payload = event.payload as { n: number };
        pending.request.onEvent({ kind: "log", text: `↳ 步骤 ${payload.n}` });
        break;
      }

      case "ContentPart": {
        const payload = event.payload as { type: string; text?: string; think?: string };
        if (payload.type === "text" && payload.text) {
          pending.lastText += payload.text;
        } else if (payload.type === "think" && payload.think) {
          pending.thinkBuffer += payload.think;
        }
        break;
      }

      case "ToolCall": {
        const payload = event.payload as { function: { name: string } };
        pending.request.onEvent({
          kind: "tool",
          text: `🛠️ ${payload.function.name}`,
        });
        break;
      }

      case "ToolResult": {
        const payload = event.payload as {
          return_value: { is_error: boolean; message: string };
        };
        if (payload.return_value.is_error) {
          pending.request.onEvent({
            kind: "log",
            text: `⚠️ 工具错误: ${payload.return_value.message}`,
          });
        }
        break;
      }

      case "StatusUpdate": {
        const payload = event.payload as {
          token_usage?: {
            input_other: number;
            output: number;
            input_cache_read: number;
            input_cache_creation: number;
          } | null;
          context_usage?: number | null;
        };
        if (payload.token_usage) {
          this.latestUsage = {
            input_tokens: payload.token_usage.input_other + payload.token_usage.input_cache_read,
            output_tokens: payload.token_usage.output,
            cache_read_input_tokens: payload.token_usage.input_cache_read,
            cache_creation_input_tokens: payload.token_usage.input_cache_creation,
          };
        }
        // Kimi SDK 返回的 context_usage 是 0-1 之间的比例值
        if (payload.context_usage !== null && payload.context_usage !== undefined) {
          const ratio = payload.context_usage;
          // 保守展示：只显示百分比，不猜测具体 token 数（因为不知道窗口大小）
          const displayText = `ctx ${(ratio * 100).toFixed(1)}%`;

          this.latestContextUsage = {
            totalTokens: 0,  // SDK 未提供具体值
            maxTokens: 0,
            percentage: ratio * 100,
            model: this.config.kimiModel ?? "kimi-latest",
            rawText: displayText,
            categories: [],
          };
        }
        break;
      }

      case "StepInterrupted":
        pending.request.onEvent({ kind: "log", text: "⚠️ 步骤被中断" });
        break;

      case "CompactionBegin":
        pending.request.onEvent({ kind: "log", text: "🗜️ 上下文压缩中..." });
        break;

      case "CompactionEnd":
        pending.request.onEvent({ kind: "log", text: "✅ 上下文压缩完成" });
        break;

      default:
        // 其他事件类型忽略
        break;
    }
  }

  async getContextUsage(): Promise<AgentContextUsage | null> {
    return this.latestContextUsage;
  }

  async interrupt(): Promise<void> {
    // Kimi 的 interrupt 在 Turn 级别，通过 turn.interrupt() 处理
    // 这里不需要额外操作，因为 sendTask 中已经处理了
  }

  private handleRequest(
    request:
      | { type: "ApprovalRequest"; payload: ApprovalRequestPayload }
      | { type: "QuestionRequest"; payload: QuestionRequest },
    pending: PendingTurn,
  ): void {
    switch (request.type) {
      case "ApprovalRequest": {
        // yoloMode 应该已自动处理，但双重保险：自动批准
        const { id } = request.payload;
        if (id && pending.turn) {
          console.log("[kimi-agent] Auto-approving:", id);
          pending.request.onEvent({ kind: "log", text: `✅ 自动批准操作: ${id}` });
          void pending.turn.approve(id, "approve_for_session");
        } else if (id) {
          pending.request.onEvent({ kind: "log", text: `⚠️ 收到审批请求但 turn 不可用: ${id}` });
        }
        break;
      }
      case "QuestionRequest": {
        const questionCount = request.payload.questions.length;
        const questionLabel = questionCount > 1 ? `${questionCount} 个问题` : "1 个问题";
        const message = `当前 Kimi 后端收到了交互式提问请求（${questionLabel}），本 Bot 暂不支持在执行中回答这类问题，已中止本轮任务。`;
        pending.fatalError = message;
        pending.request.onEvent({ kind: "log", text: `⚠️ ${message}` });
        pending.aborted = true;
        if (pending.turn) {
          void pending.turn.interrupt();
        }
        break;
      }
      default: {
        const unknownType = request satisfies never;
        void unknownType;
      }
    }
  }

  private flushThinkBuffer(pending: PendingTurn): void {
    if (pending.thinkBuffer) {
      console.log("\n[kimi-think]\n" + pending.thinkBuffer);
      pending.thinkBuffer = "";
    }
  }

  async close(): Promise<void> {
    if (this.closed || !this.session) {
      return;
    }
    this.closed = true;
    if (this.currentTurn) {
      this.currentTurn.aborted = true;
    }
    await this.session.close();
    this.session = null;
  }
}
