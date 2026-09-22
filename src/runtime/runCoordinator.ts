import type { AgentSession, AgentRuntime } from "./agentRuntime.js";
import type { ChatMessenger, InlineToggle } from "./chatMessenger.js";
import { SessionStore } from "../store/sessionStore.js";
import type {
  AgentProgressEvent,
  AgentRunResult,
  RecentRunSnapshot,
  RunSnapshot,
} from "../types.js";
import {
  renderErrorMessage,
  renderFinalMessage,
  renderFinalSystemInfo,
  renderRecentRunStatus,
  renderRunSnapshot,
  splitLongMessage,
} from "../ui/render.js";

type TaskMode = "single" | "team";
type WorkerRole = "primary" | "manager" | "implementer" | "reviewer";
type TeamRouteKind = "chat" | "analysis" | "review" | "implement" | "implement_and_review";

type TeamRouteDecision = {
  kind: TeamRouteKind;
  managerText: string;
  rationale?: string;
  implementerBrief?: string;
  reviewerBrief?: string;
  finalResponse?: string;
};

type QueuedTask = {
  chatId: string;
  scopeKey: string;
  cwd: string;
  displayPath: string;
  content: string;
  mode: TaskMode;
  forcedSkill?: string;
  messageId?: number;
  silentQueueNotice?: boolean;
  queuedAt: number;
};

type ActiveTask = {
  content: string;
  mode: TaskMode;
  controller: AbortController;
  startedAt: number;
  replyToMessageId?: number;
  statusMessageId: number;
  flushTimer: NodeJS.Timeout;
};

type LiveScopeSession = {
  scopeKey: string;
  chatId: string;
  cwd: string;
  displayPath: string;
  agentSessions: Map<WorkerRole, AgentSession>;
  latestRendered: string;
  snapshot: RunSnapshot;
  running: boolean;
  processing: boolean;
  queue: QueuedTask[];
  currentTask: ActiveTask | null;
};

export type StopResult = {
  stoppedCurrentTask: boolean;
  clearedQueuedCount: number;
};

export class RunCoordinator {
  private readonly liveSessions = new Map<string, LiveScopeSession>();
  private readonly recentRuns = new Map<string, RecentRunSnapshot>();

  constructor(
    private readonly messenger: ChatMessenger,
    private readonly store: SessionStore,
    private readonly agent: AgentRuntime,
    _enableScopeParallelRuns = false,
  ) {}

  initializeFromStore(): void {
    // Long-lived sessions are recreated lazily from persisted session IDs.
  }

  async resumePersistedQueues(): Promise<void> {
    // Queue state is now in-memory only.
  }

  async close(): Promise<void> {
    const sessions = [...this.liveSessions.values()];
    this.liveSessions.clear();
    await Promise.all(
      sessions.map(async (session) => {
        session.currentTask?.controller.abort();
        await Promise.all([...session.agentSessions.values()].map((agentSession) => agentSession.close()));
      }),
    );
  }

  isRunning(chatId: string): boolean {
    const scopeKey = this.store.getScopeKey(chatId);
    return this.liveSessions.get(scopeKey)?.running ?? false;
  }

  stop(chatId: string): StopResult {
    const scopeKey = this.store.getScopeKey(chatId);
    const session = this.liveSessions.get(scopeKey);
    if (!session) {
      return {
        stoppedCurrentTask: false,
        clearedQueuedCount: 0,
      };
    }

    const clearedQueuedCount = session.queue.length;
    session.queue.length = 0;
    session.snapshot.queuedCount = 0;

    const stoppedCurrentTask = Boolean(session.currentTask);
    session.currentTask?.controller.abort();

    return {
      stoppedCurrentTask,
      clearedQueuedCount,
    };
  }

  async resetAgentSession(chatId: string, role: WorkerRole): Promise<void> {
    const cwd = this.store.getCwd(chatId);
    const scopeKey = this.store.getScopeKey(chatId);
    const session = this.liveSessions.get(scopeKey);
    if (session?.running && session.currentTask && session.snapshot.activeRole === role) {
      session.currentTask.controller.abort();
    }

    this.store.clearSessionId(chatId, getSessionStoragePath(chatId, cwd), role);
    if (!session) {
      return;
    }

    await this.recycleAgentSession(session, role);
    if (session.snapshot.mode === "team" && session.snapshot.activeRole === role) {
      session.snapshot.activeRole = "manager";
      session.snapshot.phase = "idle";
    }
  }

  async resetScope(chatId: string): Promise<void> {
    const cwd = this.store.getCwd(chatId);
    const scopeKey = this.store.getScopeKey(chatId, cwd);
    const session = this.liveSessions.get(scopeKey);
    if (!session) {
      return;
    }

    session.queue.length = 0;
    session.currentTask?.controller.abort();
    await this.closeAllAgentSessions(session);
    this.liveSessions.delete(scopeKey);
  }

  getStatus(chatId: string): string {
    const scopeKey = this.store.getScopeKey(chatId);
    const session = this.liveSessions.get(scopeKey);
    if (session?.running) {
      session.snapshot.elapsedSeconds = this.computeElapsedSeconds(
        session.currentTask?.startedAt ?? Date.now(),
      );
      session.snapshot.queuedCount = session.queue.length;
      return renderRunSnapshot(session.snapshot);
    }

    const recentRun = this.recentRuns.get(scopeKey);
    if (!recentRun) {
      return "当前项目没有正在运行的任务。";
    }

    return renderRecentRunStatus(recentRun);
  }

  getRunSnapshot(chatId: string): RunSnapshot | null {
    const scopeKey = this.store.getScopeKey(chatId);
    const session = this.liveSessions.get(scopeKey);
    if (!session) {
      return null;
    }

    return {
      ...session.snapshot,
      logs: [...session.snapshot.logs],
      tools: [...session.snapshot.tools],
    };
  }

  async runTask(params: {
    chatId: string;
    content: string;
    mode?: TaskMode;
    forcedSkill?: string;
    messageId?: number;
    silentQueueNotice?: boolean;
  }): Promise<void> {
    const task = this.resolveTask(params);
    console.log(
      `\n📨 收到任务 [chatId=${task.chatId} scope=${task.scopeKey} mode=${task.mode}]: ${task.content.slice(0, 100)}${task.content.length > 100 ? "..." : ""}`,
    );

    const session = this.getOrCreateLiveScope(task);
    session.queue.push(task);

    if (session.running || session.processing) {
      if (!task.silentQueueNotice) {
        await this.messenger.sendMessage({
          chatId: task.chatId,
          text: `⏳ 当前项目已有任务在执行，已加入顺序队列。\n📂 ${task.displayPath}\n模式: ${task.mode === "team" ? "team" : "single"}\n排队位置: ${session.queue.length}`,
          replyToMessageId: task.messageId,
        });
      }
      return;
    }

    void this.processQueue(session.scopeKey);
  }

  private resolveTask(params: {
    chatId: string;
    content: string;
    mode?: TaskMode;
    forcedSkill?: string;
    messageId?: number;
    silentQueueNotice?: boolean;
  }): QueuedTask {
    const cwd = this.store.getCwd(params.chatId);
    return {
      chatId: params.chatId,
      content: params.content,
      mode: params.mode ?? "single",
      forcedSkill: params.forcedSkill,
      messageId: params.messageId,
      silentQueueNotice: params.silentQueueNotice,
      cwd,
      displayPath: cwd,
      scopeKey: this.store.getScopeKey(params.chatId, cwd),
      queuedAt: Date.now(),
    };
  }

  private getOrCreateLiveScope(task: QueuedTask): LiveScopeSession {
    const existing = this.liveSessions.get(task.scopeKey);
    if (existing) {
      existing.cwd = task.cwd;
      existing.displayPath = task.displayPath;
      return existing;
    }

    const session: LiveScopeSession = {
      scopeKey: task.scopeKey,
      chatId: task.chatId,
      cwd: task.cwd,
      displayPath: task.displayPath,
      agentSessions: new Map(),
      latestRendered: "",
      snapshot: {
        title: "⏳ Agent 执行中...",
        elapsedSeconds: 0,
        cwd: task.displayPath,
        logs: [],
        tools: [],
        queuedCount: 0,
        mode: task.mode,
      },
      running: false,
      processing: false,
      queue: [],
      currentTask: null,
    };
    this.liveSessions.set(task.scopeKey, session);
    return session;
  }

  private async processQueue(scopeKey: string): Promise<void> {
    const session = this.liveSessions.get(scopeKey);
    if (!session || session.processing) {
      return;
    }

    session.processing = true;
    try {
      while (session.queue.length > 0) {
        const nextTask = session.queue.shift();
        if (!nextTask) {
          break;
        }
        await this.executeTask(session, nextTask);
      }
    } finally {
      session.processing = false;
    }
  }

  private async executeTask(session: LiveScopeSession, task: QueuedTask): Promise<void> {
    const statusMessageId = await this.startStatusMessage(task);
    const startedAt = Date.now();
    session.running = true;
    session.currentTask = {
      content: task.content,
      mode: task.mode,
      controller: new AbortController(),
      startedAt,
      replyToMessageId: task.messageId,
      statusMessageId,
      flushTimer: setInterval(() => {
        void this.flushStatus(session);
      }, 2000),
    };
    session.snapshot = {
      title: task.mode === "team" ? "⏳ Team 执行中..." : "⏳ Agent 执行中...",
      elapsedSeconds: 0,
      cwd: task.displayPath,
      logs: [],
      tools: [],
      queuedCount: session.queue.length,
      mode: task.mode,
      phase: task.mode === "team" ? "planning" : "running",
      activeRole: task.mode === "team" ? "manager" : "primary",
    };
    session.latestRendered = "";

    console.log(`📂 工作目录: ${task.displayPath}`);
    console.log(`🧠 Scope: ${task.scopeKey}`);
    console.log(`⏳ 模式: ${task.mode}`);

    try {
      const result =
        task.mode === "team"
          ? await this.executeTeamTask(session, task)
          : await this.executeSingleTask(session, task);
      await this.finishTask(session, task, statusMessageId, startedAt, result);
    } catch (error) {
      if (session.currentTask) {
        clearInterval(session.currentTask.flushTimer);
      }
      session.running = false;
      session.currentTask = null;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`💥 异常 [scope=${task.scopeKey}]: ${message}`);
      this.recentRuns.set(task.scopeKey, {
        status: "error",
        taskContent: task.content,
        elapsedSeconds: this.computeElapsedSeconds(startedAt),
        finishedAt: Date.now(),
        error: message,
      });
      await this.safeEditOrSend(task.chatId, statusMessageId, renderErrorMessage(message));
      await this.closeAllAgentSessions(session);
    }
  }

  private async executeSingleTask(
    session: LiveScopeSession,
    task: QueuedTask,
  ): Promise<AgentRunResult> {
    const agentSession = await this.ensureAgentSession(session, "primary");
    const result = await agentSession.sendTask({
      task: task.content,
      forcedSkill: task.forcedSkill,
      signal: session.currentTask?.controller.signal as AbortSignal,
      onEvent: (event) => this.applyEvent(session, "primary", event),
    });
    this.persistSessionId(task, "primary", result.sessionId);
    return result;
  }

  private async executeTeamTask(
    session: LiveScopeSession,
    task: QueuedTask,
  ): Promise<AgentRunResult> {
    const signal = session.currentTask?.controller.signal as AbortSignal;
    const manager = await this.ensureAgentSession(session, "manager");
    this.setTeamPhase(session, "planning", "manager", "🧭 manager 分析与分派中...");
    const routeResult = await manager.sendTask({
      task: buildManagerRoutingPrompt(task.content),
      signal,
      onEvent: (event) => this.applyEvent(session, "manager", event),
    });
    this.persistSessionId(task, "manager", routeResult.sessionId);
    if (!routeResult.success || signal.aborted) {
      return routeResult;
    }

    const route = parseTeamRouteDecision(routeResult.output);
    if (!route) {
      return {
        success: false,
        error: "manager 未返回合法 route 决策",
        output: routeResult.output,
        usage: routeResult.usage,
        contextUsage: routeResult.contextUsage,
        sessionId: routeResult.sessionId,
      };
    }

    if (route.kind === "chat" || route.kind === "analysis") {
      return {
        success: true,
        output: joinTeamOutputs(route, "", "", route.finalResponse ?? route.managerText),
        usage: routeResult.usage,
        contextUsage: routeResult.contextUsage,
        sessionId: routeResult.sessionId,
      };
    }

    let implementationOutput = "";
    let reviewOutput = "";
    let implementationUsage: AgentRunResult["usage"] | undefined = undefined;
    let reviewUsage: AgentRunResult["usage"] | undefined = undefined;
    let implementationContextUsage: AgentRunResult["contextUsage"] | undefined = undefined;
    let reviewContextUsage: AgentRunResult["contextUsage"] | undefined = undefined;

    if (route.kind === "implement" || route.kind === "implement_and_review") {
      const implementer = await this.ensureAgentSession(session, "implementer");
      this.setTeamPhase(session, "implementing", "implementer", "🧑‍💻 implementer 执行中...");
      const implementation = await implementer.sendTask({
        task: buildImplementerPrompt(task.content, route),
        forcedSkill: task.forcedSkill,
        signal,
        onEvent: (event) => this.applyEvent(session, "implementer", event),
      });
      this.persistSessionId(task, "implementer", implementation.sessionId);
      implementationUsage = implementation.usage;
      implementationContextUsage = implementation.contextUsage;
      if (!implementation.success || signal.aborted) {
        return {
          ...implementation,
          output: joinTeamOutputs(route, implementation.output || "", ""),
        };
      }
      implementationOutput = implementation.output;
    }

    if (route.kind === "review" || route.kind === "implement_and_review") {
      const reviewer = await this.ensureAgentSession(session, "reviewer");
      this.setTeamPhase(session, "reviewing", "reviewer", "🧪 reviewer 审查中...");
      const review = await reviewer.sendTask({
        task: buildReviewerPrompt(task.content, route, implementationOutput),
        signal,
        onEvent: (event) => this.applyEvent(session, "reviewer", event),
      });
      this.persistSessionId(task, "reviewer", review.sessionId);
      reviewUsage = review.usage;
      reviewContextUsage = review.contextUsage;
      if (!review.success || signal.aborted) {
        return {
          ...review,
          output: joinTeamOutputs(route, implementationOutput, review.output || ""),
        };
      }
      reviewOutput = review.output;
    }

    const needsFinalization = route.kind === "review" || route.kind === "implement_and_review";
    if (!needsFinalization) {
      return {
        success: true,
        output: joinTeamOutputs(route, implementationOutput, reviewOutput, route.finalResponse ?? ""),
        usage: mergeUsage(routeResult.usage, implementationUsage, reviewUsage),
        contextUsage:
          reviewContextUsage ?? implementationContextUsage ?? routeResult.contextUsage,
        sessionId: routeResult.sessionId,
      };
    }

    this.setTeamPhase(session, "finalizing", "manager", "🧾 manager 汇总 team 结果...");
    const finalization = await manager.sendTask({
      task: buildManagerFinalizationPrompt(task.content, route, implementationOutput, reviewOutput),
      signal,
      onEvent: (event) => this.applyEvent(session, "manager", event),
    });
    this.persistSessionId(task, "manager", finalization.sessionId);
    if (!finalization.success || signal.aborted) {
      return {
        ...finalization,
        output: joinTeamOutputs(route, implementationOutput, reviewOutput, finalization.output || ""),
      };
    }

    return {
      success: true,
      output: joinTeamOutputs(route, implementationOutput, reviewOutput, finalization.output),
      usage: mergeUsage(routeResult.usage, implementationUsage, reviewUsage, finalization.usage),
      contextUsage:
        finalization.contextUsage ??
        reviewContextUsage ??
        implementationContextUsage ??
        routeResult.contextUsage,
      sessionId: finalization.sessionId ?? routeResult.sessionId,
    };
  }

  private async finishTask(
    session: LiveScopeSession,
    task: QueuedTask,
    statusMessageId: number,
    startedAt: number,
    result: AgentRunResult,
  ): Promise<void> {
    const currentTask = session.currentTask;
    const wasAborted = currentTask?.controller.signal.aborted ?? false;
    const elapsedSeconds = this.computeElapsedSeconds(startedAt);
    const finishedAt = Date.now();

    if (currentTask) {
      clearInterval(currentTask.flushTimer);
    }
    session.running = false;
    session.currentTask = null;
    if (result.success) {
      console.log(`✅ 任务完成 [scope=${task.scopeKey}]`);
      const renderedFinalMessage = renderFinalMessage(
        result.output,
        result.usage,
        elapsedSeconds,
        result.contextUsage,
      );
      console.log(indentConsoleBlock(renderedFinalMessage, "  "));
      this.recentRuns.set(task.scopeKey, {
        status: "success",
        taskContent: task.content,
        elapsedSeconds,
        finishedAt,
      });
      await this.sendFinal(task.chatId, statusMessageId, result, elapsedSeconds);
      return;
    }

    if (wasAborted || result.error === "任务已取消") {
      this.recentRuns.set(task.scopeKey, {
        status: "stopped",
        taskContent: task.content,
        elapsedSeconds,
        finishedAt,
      });
      await this.safeEditOrSend(task.chatId, statusMessageId, "🛑 任务已强行终止。");
      return;
    }

    console.log(`❌ 任务失败 [scope=${task.scopeKey}]: ${result.error}`);
    this.recentRuns.set(task.scopeKey, {
      status: "error",
      taskContent: task.content,
      elapsedSeconds,
      finishedAt,
      error: result.error ?? "未知错误",
    });
    await this.safeEditOrSend(
      task.chatId,
      statusMessageId,
      renderErrorMessage(result.error ?? "未知错误"),
    );

    if (task.mode === "team") {
      if (shouldResetSession(result.error)) {
        await this.invalidatePersistedSession(task.chatId, task.cwd, session, "manager");
        await this.invalidatePersistedSession(task.chatId, task.cwd, session, "implementer");
        await this.invalidatePersistedSession(task.chatId, task.cwd, session, "reviewer");
      } else if (shouldRecycleSession(result.error)) {
        await this.recycleAgentSession(session, "manager");
        await this.recycleAgentSession(session, "implementer");
        await this.recycleAgentSession(session, "reviewer");
      }
      return;
    }

    if (shouldResetSession(result.error)) {
      await this.invalidatePersistedSession(task.chatId, task.cwd, session, "primary");
    } else if (shouldRecycleSession(result.error)) {
      await this.recycleAgentSession(session, "primary");
    }
  }

  private async ensureAgentSession(
    session: LiveScopeSession,
    role: WorkerRole,
  ): Promise<AgentSession> {
    const existing = session.agentSessions.get(role);
    if (existing) {
      return existing;
    }
    const persistedSessionId = this.store.getSessionId(
      session.chatId,
      getSessionStoragePath(session.chatId, session.cwd),
      role,
    );
    const agentSession = await this.agent.createSession({
      chatId: session.chatId,
      cwd: session.cwd,
      sessionId: persistedSessionId,
      role,
    });
    session.agentSessions.set(role, agentSession);
    return agentSession;
  }

  private async recycleAgentSession(session: LiveScopeSession, role: WorkerRole): Promise<void> {
    const agentSession = session.agentSessions.get(role);
    if (!agentSession) {
      return;
    }
    await agentSession.close();
    session.agentSessions.delete(role);
  }

  private async closeAllAgentSessions(session: LiveScopeSession): Promise<void> {
    const agentSessions = [...session.agentSessions.entries()];
    session.agentSessions.clear();
    await Promise.all(agentSessions.map(([, agentSession]) => agentSession.close()));
  }

  private async invalidatePersistedSession(
    chatId: string,
    cwd: string,
    session: LiveScopeSession,
    role: WorkerRole,
  ): Promise<void> {
    this.store.clearSessionId(chatId, getSessionStoragePath(chatId, cwd), role);
    await this.recycleAgentSession(session, role);
  }

  private persistSessionId(task: QueuedTask, role: WorkerRole, sessionId?: string): void {
    if (!sessionId) {
      return;
    }
    this.store.saveSessionId(task.chatId, getSessionStoragePath(task.chatId, task.cwd), sessionId, role);
  }

  private applyEvent(
    session: LiveScopeSession,
    role: WorkerRole,
    event: AgentProgressEvent,
  ): void {
    if (event.kind === "session") {
      this.store.saveSessionId(
        session.chatId,
        getSessionStoragePath(session.chatId, session.cwd),
        event.sessionId,
        role,
      );
      return;
    }

    const prefix = role === "primary" ? "" : `[${role}] `;
    const text = `${prefix}${event.text}`;
    const target = event.kind === "tool" ? session.snapshot.tools : session.snapshot.logs;
    target.push(text);
    if (target.length > (event.kind === "tool" ? 6 : 8)) {
      target.shift();
    }

    if (session.snapshot.mode === "team") {
      session.snapshot.activeRole = role;
    }

    if (!session.running) {
      return;
    }
    void this.flushStatus(session);
  }

  private setTeamPhase(
    session: LiveScopeSession,
    phase: string,
    role: WorkerRole,
    title: string,
  ): void {
    session.snapshot.title = title;
    session.snapshot.phase = phase;
    session.snapshot.activeRole = role;
    void this.flushStatus(session);
  }

  private async startStatusMessage(task: QueuedTask): Promise<number> {
    const rendered = renderRunSnapshot({
      title: task.mode === "team" ? "⏳ Team 执行中..." : "⏳ Agent 执行中...",
      elapsedSeconds: 0,
      cwd: task.displayPath,
      logs: [],
      tools: [],
      queuedCount: 0,
      mode: task.mode,
      phase: task.mode === "team" ? "planning" : "running",
      activeRole: task.mode === "team" ? "manager" : "primary",
    });
    const statusMessage = await this.messenger.sendMessage({
      chatId: task.chatId,
      text: rendered,
      replyToMessageId: task.messageId,
    });
    return statusMessage.messageId;
  }

  private async sendFinal(
    chatId: string,
    statusMessageId: number,
    result: AgentRunResult,
    elapsedSeconds: number,
  ): Promise<void> {
    const parts = splitLongMessage(renderFinalMessage(result.output));
    const systemInfo = renderFinalSystemInfo(result.usage, elapsedSeconds, result.contextUsage);
    const finalPart = parts[parts.length - 1] ?? "✅ 任务完成";
    const inlineToggle = systemInfo
      ? buildSystemInfoToggle(finalPart, systemInfo)
      : undefined;

    await this.safeEditOrSend(
      chatId,
      statusMessageId,
      parts[0] ?? "✅ 任务完成",
      parts.length === 1 ? inlineToggle : undefined,
    );
    for (const [index, part] of parts.slice(1).entries()) {
      const isLast = index === parts.length - 2;
      await this.messenger.sendMessage({
        chatId,
        text: part,
        inlineToggle: isLast ? inlineToggle : undefined,
      });
    }
  }

  private computeElapsedSeconds(startedAt: number): number {
    return Math.floor((Date.now() - startedAt) / 1000);
  }

  private async flushStatus(session: LiveScopeSession): Promise<void> {
    if (!session.running || !session.currentTask) {
      return;
    }

    session.snapshot.elapsedSeconds = this.computeElapsedSeconds(session.currentTask.startedAt);
    session.snapshot.queuedCount = session.queue.length;
    const rendered = renderRunSnapshot(session.snapshot);
    if (rendered === session.latestRendered) {
      return;
    }
    session.latestRendered = rendered;
    await this.safeEditOrSend(
      session.chatId,
      session.currentTask.statusMessageId,
      rendered,
      undefined,
      (nextMessageId) => {
        if (session.currentTask) {
          session.currentTask.statusMessageId = nextMessageId;
        }
      },
    );
  }

  private async safeEditOrSend(
    chatId: string,
    messageId: number | null,
    text: string,
    inlineToggle?: InlineToggle,
    onFallbackSend?: (nextMessageId: number) => void,
  ): Promise<void> {
    if (!messageId) {
      const sent = await this.messenger.sendMessage({ chatId, text, inlineToggle });
      onFallbackSend?.(sent.messageId);
      return;
    }

    try {
      await this.messenger.editMessageText(chatId, messageId, text, inlineToggle);
    } catch (error) {
      console.error(
        `[coordinator] edit failed chat=${chatId} messageId=${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const sent = await this.messenger.sendMessage({ chatId, text, inlineToggle });
      onFallbackSend?.(sent.messageId);
    }
  }
}

function buildSystemInfoToggle(text: string, systemInfo: string): InlineToggle {
  return {
    collapsedText: text,
    expandedText: [text, systemInfo].join("\n\n"),
  };
}

function buildManagerRoutingPrompt(task: string): string {
  return [
    "你是 manager worker。",
    "你的职责是先对任务做最终路由决策，再决定是否交给 implementer、reviewer。",
    "不要修改代码，不要假装已经执行。",
    "你必须只输出一个 JSON 对象，不要输出 markdown 代码块，不要输出额外解释。",
    'JSON schema: {"kind":"chat|analysis|review|implement|implement_and_review","managerText":"string","rationale":"string?","implementerBrief":"string?","reviewerBrief":"string?","finalResponse":"string?"}',
    "规则：",
    "- chat: 普通问答或闲聊，manager 直接回复，finalResponse 必填。",
    "- analysis: 只分析、不改代码，manager 直接回复，finalResponse 必填。",
    "- review: 只需要 reviewer 审查，不要叫 implementer。",
    "- implement: 只需要 implementer 执行，不要叫 reviewer。",
    "- implement_and_review: 先 implementer，再 reviewer，最后 manager 汇总。",
    "- managerText 始终要包含你对任务的理解和分派理由。",
    "- implementerBrief 只在 implement / implement_and_review 时填写。",
    "- reviewerBrief 只在 review / implement_and_review 时填写。",
    "",
    "原始任务：",
    task,
  ].join("\n");
}

function buildImplementerPrompt(task: string, route: TeamRouteDecision): string {
  return [
    "你是 implementer worker。",
    "直接在当前工作目录执行任务，必要时修改代码、运行命令、验证结果。",
    "结束时用简洁中文总结：改了什么、验证了什么、还有什么风险。",
    "",
    "manager 的路由决策：",
    route.managerText,
    "",
    "implementer 的明确要求：",
    route.implementerBrief ?? "按原始任务完成实现。",
    "",
    "原始任务：",
    task,
  ].join("\n");
}

function buildReviewerPrompt(task: string, route: TeamRouteDecision, implementerOutput: string): string {
  return [
    "你是 reviewer worker。",
    "你的职责是审查当前工作目录里的最终结果，不要修改代码。",
    "请检查实现是否满足需求，并重点指出 bug、回归风险、遗漏测试和不确定项。",
    "输出格式：",
    "1. 结论: 通过 / 有问题",
    "2. 发现: 按严重程度列出",
    "3. 测试与风险: 简述",
    "",
    "manager 的路由决策：",
    route.managerText,
    "",
    "reviewer 的明确要求：",
    route.reviewerBrief ?? "审查当前结果是否满足原始任务。",
    "",
    "原始任务：",
    task,
    "",
    "implementer 的自述：",
    implementerOutput,
  ].join("\n");
}

function buildManagerFinalizationPrompt(
  task: string,
  route: TeamRouteDecision,
  implementerOutput: string,
  reviewerOutput: string,
): string {
  return [
    "你是 manager worker。",
    "你现在负责汇总 implementer 和 reviewer 的结果，给出最终 team 结论。",
    "不要假装修改代码，只做汇总、裁决和风险提醒。",
    "输出格式：",
    "1. 最终结论",
    "2. 完成情况",
    "3. review 结论与后续建议",
    "",
    "原始任务：",
    task,
    "",
    "之前的路由决策：",
    route.managerText,
    "",
    "implementer 输出：",
    implementerOutput,
    "",
    "reviewer 输出：",
    reviewerOutput,
  ].join("\n");
}

function joinTeamOutputs(
  route: TeamRouteDecision,
  implementerOutput: string,
  reviewerOutput: string,
  managerFinalOutput?: string,
): string {
  const parts = [
    "## Manager",
    route.managerText.trim() || "无输出",
    "",
    "## Implementer",
    implementerOutput.trim() || "无输出",
    "",
    "## Reviewer",
    reviewerOutput.trim() || "无输出",
  ];
  if (managerFinalOutput?.trim()) {
    parts.push("", "## Final", managerFinalOutput.trim());
  }
  return parts.join("\n");
}

function parseTeamRouteDecision(raw: string): TeamRouteDecision | null {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as Partial<TeamRouteDecision>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (!isTeamRouteKind(parsed.kind) || typeof parsed.managerText !== "string") {
      return null;
    }
    return {
      kind: parsed.kind,
      managerText: parsed.managerText.trim(),
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.trim() : undefined,
      implementerBrief:
        typeof parsed.implementerBrief === "string" ? parsed.implementerBrief.trim() : undefined,
      reviewerBrief: typeof parsed.reviewerBrief === "string" ? parsed.reviewerBrief.trim() : undefined,
      finalResponse: typeof parsed.finalResponse === "string" ? parsed.finalResponse.trim() : undefined,
    };
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  // 优先尝试从 markdown code block 中提取
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    const inner = codeBlockMatch[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) {
      return inner;
    }
    const innerMatch = inner.match(/\{[\s\S]*\}/);
    if (innerMatch) {
      return extractFirstBalancedJson(innerMatch[0]);
    }
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? extractFirstBalancedJson(match[0]) : trimmed;
}

function extractFirstBalancedJson(raw: string): string {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (raw[i] === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          return raw.slice(start, i + 1);
        }
      }
    }
  }
  return raw;
}

function isTeamRouteKind(value: unknown): value is TeamRouteKind {
  return (
    value === "chat" ||
    value === "analysis" ||
    value === "review" ||
    value === "implement" ||
    value === "implement_and_review"
  );
}

function mergeUsage(
  ...usages: Array<AgentRunResult["usage"] | undefined>
): AgentRunResult["usage"] | undefined {
  const nonEmpty = usages.filter(Boolean);
  if (nonEmpty.length === 0) {
    return undefined;
  }

  const keys = new Set<string>(nonEmpty.flatMap((usage) => Object.keys(usage ?? {})));
  const merged: Record<string, number> = {};
  for (const key of keys) {
    const value = nonEmpty.reduce((sum, usage) => sum + (usage?.[key] ?? 0), 0);
    if (value > 0) {
      merged[key] = value;
    }
  }
  return merged;
}

function shouldRecycleSession(error?: string): boolean {
  if (!error) {
    return false;
  }
  const normalized = error.toLowerCase();
  return (
    normalized.includes("closed") ||
    normalized.includes("write after end") ||
    normalized.includes("broken pipe") ||
    normalized.includes("session") ||
    normalized.includes("transport")
  );
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
    normalized.includes("invalid uuid") ||
    normalized.includes("no conversation found")
  );
}

function indentConsoleBlock(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function getSessionStoragePath(chatId: string, cwd: string): string {
  return chatId.startsWith("web:team:") ? "__team__" : cwd;
}
