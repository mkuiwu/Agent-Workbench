import { createReadStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { makeWebChatId, makeWebTeamChatId } from "../channels/chatId.js";
import { BotController } from "../app/botController.js";
import type { AppConfig } from "../config.js";
import { scanProjects } from "../projects/scanProjects.js";
import { RunCoordinator } from "../runtime/runCoordinator.js";
import { SessionStore } from "../store/sessionStore.js";
import { WebMessenger } from "./webMessenger.js";

type WebState = {
  chatId: string;
  cwd: string;
  memoryMode: string;
  running: boolean;
  provider: "claude" | "kimi";
  model: string;
  sessionId: string | null;
  pendingSkill: string | null;
  projects: Array<{ name: string; path: string }>;
  skills: Array<{ name: string; description: string; displayPath: string }>;
  messages: ReturnType<WebMessenger["listMessages"]>;
};

type TeamSummaryState = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  workdirCount: number;
  primaryPath: string | null;
};

type TeamWorkdirState = {
  path: string;
  label: string;
  sortOrder: number;
  isPrimary: boolean;
  exists: boolean;
  status: "ready" | "missing";
  branch: string | null;
};

type TeamAgentState = {
  id: string;
  label: string;
  role: string;
  sessionActive: boolean;
  runtime: string;
  model: string;
  status: "idle" | "running";
  description: string;
  latestLogs: string[];
  latestTools: string[];
};

type TeamWorkspaceState = {
  teamId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  running: boolean;
  provider: "claude" | "kimi";
  model: string;
  primaryPath: string | null;
  workdirs: TeamWorkdirState[];
  messages: ReturnType<WebMessenger["listMessages"]>;
  statusText: string;
  runSnapshot: ReturnType<RunCoordinator["getRunSnapshot"]>;
  sessions: {
    manager: string | null;
    implementer: string | null;
    reviewer: string | null;
  };
  agents: TeamAgentState[];
  teams: TeamSummaryState[];
};

const execFileAsync = promisify(execFile);

const WEB_DIST_DIR = resolve(process.cwd(), "dist/web");
const WEB_INDEX_FILE = join(WEB_DIST_DIR, "index.html");

export class WebApp {
  private server: Server | null = null;
  private readonly eventClients = new Map<string, Set<ServerResponse>>();
  private readonly unsubscribeMessenger: () => void;

  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly controller: BotController,
    private readonly coordinator: RunCoordinator,
    private readonly messenger: WebMessenger,
  ) {
    this.unsubscribeMessenger = this.messenger.subscribe((chatId) => {
      this.broadcastState(chatId);
    });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolveStart, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("Web server was not created"));
        return;
      }
      server.once("error", reject);
      server.listen(this.config.webPort, this.config.webHost, () => {
        server.off("error", reject);
        resolveStart();
      });
    });

    console.log(`🌐 Web channel listening on http://${this.config.webHost}:${this.config.webPort}`);
  }

  stop(): void {
    this.unsubscribeMessenger();
    for (const clients of this.eventClients.values()) {
      for (const client of clients) {
        client.end();
      }
    }
    this.eventClients.clear();
    this.server?.close();
    this.server = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/api/state") {
      const chatId = this.getChatId(url.searchParams.get("chatId") ?? "");
      this.store.touchChat(chatId);
      this.sendJson(res, await this.buildState(chatId));
      return;
    }

    if (method === "GET" && url.pathname === "/api/events") {
      const chatId = this.getChatId(url.searchParams.get("chatId") ?? "");
      this.store.touchChat(chatId);
      this.attachEventStream(chatId, res);
      await this.pushConsoleState(chatId, res);
      return;
    }

    if (method === "GET" && url.pathname === "/api/teams") {
      this.sendJson(res, this.store.listTeams());
      return;
    }

    if (method === "GET" && url.pathname === "/api/team/state") {
      const teamId = url.searchParams.get("teamId") ?? "";
      const state = await this.buildTeamState(teamId);
      if (!state) {
        this.sendJson(res, { error: "Team not found" }, 404);
        return;
      }
      this.sendJson(res, state);
      return;
    }

    if (method === "GET" && url.pathname === "/api/team/events") {
      const teamId = url.searchParams.get("teamId") ?? "";
      const chatId = makeWebTeamChatId(teamId);
      if (!this.store.getTeam(teamId)) {
        this.sendJson(res, { error: "Team not found" }, 404);
        return;
      }
      this.attachEventStream(chatId, res);
      await this.pushTeamState(teamId, res);
      return;
    }

    if (method === "POST" && url.pathname === "/api/message") {
      const body = await readJson(req);
      const chatId = this.getChatId(asString(body.chatId));
      const text = asString(body.text).trim();
      if (!text) {
        this.sendJson(res, { error: "text is required" }, 400);
        return;
      }

      this.store.touchChat(chatId);
      const messageId = this.messenger.appendUserMessage(chatId, text);
      await this.controller.handleIncomingText({
        userId: this.config.webUserId,
        chatId,
        messageId,
        text,
        reply: async (message) => {
          await this.messenger.sendMessage({
            chatId,
            text: message,
            replyToMessageId: messageId,
          });
        },
      });
      this.sendJson(res, await this.buildState(chatId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/create") {
      const body = await readJson(req);
      const name = asString(body.name).trim() || "New Team Workspace";
      const team = this.store.createTeam(name);
      this.sendJson(res, await this.buildTeamState(team.id));
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/update") {
      const body = await readJson(req);
      const teamId = asString(body.teamId);
      const name = asString(body.name).trim();
      if (!teamId || !name) {
        this.sendJson(res, { error: "teamId and name are required" }, 400);
        return;
      }
      this.store.renameTeam(teamId, name);
      this.broadcastState(makeWebTeamChatId(teamId));
      this.sendJson(res, await this.buildTeamState(teamId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/delete") {
      const body = await readJson(req);
      const teamId = asString(body.teamId);
      if (!teamId) {
        this.sendJson(res, { error: "teamId is required" }, 400);
        return;
      }
      const chatId = makeWebTeamChatId(teamId);
      this.store.deleteTeam(teamId);
      this.store.clearSessionId(chatId);
      this.store.clearWebMessages(chatId);
      this.sendJson(res, { ok: true, teams: this.store.listTeams() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/workdir/add") {
      const body = await readJson(req);
      const teamId = asString(body.teamId);
      const path = asString(body.path).trim();
      if (!teamId || !path) {
        this.sendJson(res, { error: "teamId and path are required" }, 400);
        return;
      }
      this.store.addTeamWorkdir(teamId, path);
      const chatId = makeWebTeamChatId(teamId);
      if (this.store.getPrimaryTeamWorkdir(teamId)) {
        this.store.saveCwd(chatId, this.store.getPrimaryTeamWorkdir(teamId) as string);
      }
      this.broadcastState(chatId);
      this.sendJson(res, await this.buildTeamState(teamId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/workdir/remove") {
      const body = await readJson(req);
      const teamId = asString(body.teamId);
      const path = asString(body.path).trim();
      if (!teamId || !path) {
        this.sendJson(res, { error: "teamId and path are required" }, 400);
        return;
      }
      this.store.removeTeamWorkdir(teamId, path);
      const chatId = makeWebTeamChatId(teamId);
      const primaryPath = this.store.getPrimaryTeamWorkdir(teamId);
      if (primaryPath) {
        this.store.saveCwd(chatId, primaryPath);
      }
      this.broadcastState(chatId);
      this.sendJson(res, await this.buildTeamState(teamId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/workdir/primary") {
      const body = await readJson(req);
      const teamId = asString(body.teamId);
      const path = asString(body.path).trim();
      if (!teamId || !path) {
        this.sendJson(res, { error: "teamId and path are required" }, 400);
        return;
      }
      this.store.setPrimaryTeamWorkdir(teamId, path);
      this.store.saveCwd(makeWebTeamChatId(teamId), path);
      this.broadcastState(makeWebTeamChatId(teamId));
      this.sendJson(res, await this.buildTeamState(teamId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/workdir/move") {
      const body = await readJson(req);
      const teamId = asString(body.teamId);
      const path = asString(body.path).trim();
      const direction = asString(body.direction) === "up" ? "up" : "down";
      if (!teamId || !path) {
        this.sendJson(res, { error: "teamId and path are required" }, 400);
        return;
      }
      this.store.moveTeamWorkdir(teamId, path, direction);
      this.broadcastState(makeWebTeamChatId(teamId));
      this.sendJson(res, await this.buildTeamState(teamId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/message") {
      const body = await readJson(req);
      const teamId = asString(body.teamId);
      const text = asString(body.text).trim();
      if (!teamId || !text) {
        this.sendJson(res, { error: "teamId and text are required" }, 400);
        return;
      }
      const team = this.store.getTeam(teamId);
      const primaryPath = team?.workdirs.find((entry) => entry.isPrimary)?.path ?? null;
      if (!team || !primaryPath) {
        this.sendJson(res, { error: "Team requires a primary workdir before sending tasks" }, 400);
        return;
      }

      const chatId = makeWebTeamChatId(teamId);
      this.store.touchTeam(teamId);
      this.store.saveCwd(chatId, primaryPath);
      const messageId = this.messenger.appendUserMessage(chatId, text);
      await this.coordinator.runTask({
        chatId,
        content: buildTeamTaskPrompt(team.name, team.workdirs.map((entry) => entry.path), primaryPath, text),
        mode: "team",
        messageId,
      });
      this.sendJson(res, await this.buildTeamState(teamId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/team/action") {
      const body = await readJson(req);
      const teamId = asString(body.teamId);
      const action = asString(body.action);
      if (!teamId) {
        this.sendJson(res, { error: "teamId is required" }, 400);
        return;
      }
      const state = await this.handleTeamAction(teamId, action);
      this.sendJson(res, state);
      return;
    }

    if (method === "POST" && url.pathname === "/api/project") {
      const body = await readJson(req);
      const chatId = this.getChatId(asString(body.chatId));
      const projectPath = asString(body.projectPath).trim();
      if (!projectPath) {
        this.sendJson(res, { error: "projectPath is required" }, 400);
        return;
      }

      this.store.touchChat(chatId);
      const text = await this.controller.handleProjectSelection(
        this.config.webUserId,
        chatId,
        projectPath,
      );
      if (text) {
        await this.messenger.sendMessage({ chatId, text });
      }
      this.messenger.notify(chatId);
      this.sendJson(res, await this.buildState(chatId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/skill") {
      const body = await readJson(req);
      const chatId = this.getChatId(asString(body.chatId));
      const skillName = asNullableString(body.skillName);
      this.store.touchChat(chatId);
      await this.controller.handleUseSkill(
        this.config.webUserId,
        chatId,
        skillName ?? "cancel",
        async (text) => {
          await this.messenger.sendMessage({ chatId, text });
        },
      );
      this.messenger.notify(chatId);
      this.sendJson(res, await this.buildState(chatId));
      return;
    }

    if (method === "POST" && url.pathname === "/api/action") {
      const body = await readJson(req);
      const chatId = this.getChatId(asString(body.chatId));
      const action = asString(body.action);
      this.store.touchChat(chatId);
      const state = await this.handleAction(chatId, action);
      this.sendJson(res, state);
      return;
    }

    if (method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      await this.serveFrontend(url.pathname, res);
      return;
    }

    this.sendJson(res, { error: "Not Found" }, 404);
  }

  private async handleAction(chatId: string, action: string): Promise<WebState> {
    const reply = async (text: string) => {
      await this.messenger.sendMessage({ chatId, text });
    };

    switch (action) {
      case "start":
        await this.controller.handleStart(this.config.webUserId, reply);
        break;
      case "info":
        await this.controller.handleInfo(this.config.webUserId, chatId, reply);
        break;
      case "reset":
        await this.controller.handleReset(this.config.webUserId, chatId, reply);
        break;
      case "stop":
        await this.controller.handleStop(this.config.webUserId, chatId, reply);
        break;
      case "compress":
        await this.controller.handleCompress(this.config.webUserId, chatId, 0);
        break;
      case "heartbeat":
        await this.controller.handleHeartbeat(this.config.webUserId, chatId, "", reply);
        break;
      case "heartbeat-run":
        await this.controller.handleHeartbeat(this.config.webUserId, chatId, "run", reply);
        break;
      default:
        this.sendMessage(chatId, `不支持的动作: ${action}`);
        break;
    }

    this.messenger.notify(chatId);
    return this.buildState(chatId);
  }

  private async handleTeamAction(teamId: string, action: string): Promise<TeamWorkspaceState | null> {
    const chatId = makeWebTeamChatId(teamId);
    const team = this.store.getTeam(teamId);
    const reply = async (text: string) => {
      await this.messenger.sendMessage({ chatId, text });
    };

    switch (action) {
      case "stop":
        await this.controller.handleStop(this.config.webUserId, chatId, reply);
        break;
      case "reset":
        await this.controller.handleReset(this.config.webUserId, chatId, reply);
        break;
      case "info":
        await this.controller.handleInfo(this.config.webUserId, chatId, reply);
        break;
      case "reset-manager":
        await this.coordinator.resetAgentSession(chatId, "manager");
        await this.messenger.sendMessage({ chatId, text: "♻️ 已重置 manager 会话。" });
        break;
      case "reset-implementer":
        await this.coordinator.resetAgentSession(chatId, "implementer");
        await this.messenger.sendMessage({ chatId, text: "♻️ 已重置 implementer 会话。" });
        break;
      case "reset-reviewer":
        await this.coordinator.resetAgentSession(chatId, "reviewer");
        await this.messenger.sendMessage({ chatId, text: "♻️ 已重置 reviewer 会话。" });
        break;
      case "rerun-last": {
        const primaryPath = team?.workdirs.find((entry) => entry.isPrimary)?.path ?? null;
        const lastUserMessage = this.messenger
          .listMessages(chatId)
          .filter((message) => message.role === "user")
          .at(-1);
        if (!team || !primaryPath || !lastUserMessage) {
          await this.messenger.sendMessage({ chatId, text: "⚠️ 没有可重跑的上一轮 team 任务。" });
          break;
        }
        this.store.saveCwd(chatId, primaryPath);
        await this.coordinator.runTask({
          chatId,
          content: buildTeamTaskPrompt(
            team.name,
            team.workdirs.map((entry) => entry.path),
            primaryPath,
            lastUserMessage.text,
          ),
          mode: "team",
          silentQueueNotice: true,
        });
        break;
      }
      default:
        await this.messenger.sendMessage({ chatId, text: `不支持的 team 动作: ${action}` });
        break;
    }

    this.messenger.notify(chatId);
    return this.buildTeamState(teamId);
  }

  private async buildState(chatId: string): Promise<WebState> {
    const cwd = this.store.getCwd(chatId);
    const sessionId = this.store.getSessionId(chatId, cwd);
    const skills = await this.controller.getAvailableSkills(this.config.webUserId);
    return {
      chatId,
      cwd,
      memoryMode: "channel + chat + cwd",
      running: this.coordinator.isRunning(chatId),
      provider: this.config.agentProvider,
      model:
        this.config.agentProvider === "kimi"
          ? (this.config.kimiModel ?? "kimi-latest")
          : (this.config.claudeModel ?? "跟随 Claude CLI 默认"),
      sessionId,
      pendingSkill: this.controller.getPendingSkill(this.config.webUserId, chatId),
      projects: scanProjects(this.config.projectRoots),
      skills,
      messages: this.messenger.listMessages(chatId),
    };
  }

  private async buildTeamState(teamId: string): Promise<TeamWorkspaceState | null> {
    const team = this.store.getTeam(teamId);
    if (!team) {
      return null;
    }

    this.store.touchTeam(teamId);
    const chatId = makeWebTeamChatId(teamId);
    const primaryPath = team.workdirs.find((entry) => entry.isPrimary)?.path ?? null;
    if (primaryPath) {
      this.store.saveCwd(chatId, primaryPath);
    }

    const workdirs: TeamWorkdirState[] = await Promise.all(
      team.workdirs.map(async (workdir) => {
        const exists = await pathExists(workdir.path);
        return {
          ...workdir,
          exists,
          status: exists ? "ready" : "missing",
          branch: exists ? await getGitBranch(workdir.path) : null,
        };
      }),
    );

    const primarySession = this.store.getSessionId(chatId, "__team__", "primary");
    const managerSession = this.store.getSessionId(chatId, "__team__", "manager");
    const implementerSession = this.store.getSessionId(chatId, "__team__", "implementer");
    const reviewerSession = this.store.getSessionId(chatId, "__team__", "reviewer");
    const rawRunSnapshot = this.coordinator.getRunSnapshot(chatId);
    const runSnapshot = rawRunSnapshot
      ? {
          ...rawRunSnapshot,
          activeRole:
            rawRunSnapshot.mode === "single" && rawRunSnapshot.activeRole === "primary"
              ? "manager"
              : rawRunSnapshot.activeRole,
        }
      : null;
    const runtimeLabel = this.config.agentProvider === "kimi"
      ? "Kimi Code CLI"
      : "Claude Agent SDK";
    const modelLabel = this.config.agentProvider === "kimi"
      ? (this.config.kimiModel ?? "kimi-latest")
      : (this.config.claudeModel ?? "跟随 Claude CLI 默认");

    return {
      teamId: team.id,
      name: team.name,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
      lastOpenedAt: team.lastOpenedAt,
      running: this.coordinator.isRunning(chatId),
      provider: this.config.agentProvider,
      model:
        this.config.agentProvider === "kimi"
          ? (this.config.kimiModel ?? "kimi-latest")
          : (this.config.claudeModel ?? "跟随 Claude CLI 默认"),
      primaryPath,
      workdirs,
      messages: this.messenger.listMessages(chatId),
      statusText: this.coordinator.getStatus(chatId),
      runSnapshot,
      sessions: {
        manager: managerSession ?? primarySession,
        implementer: implementerSession,
        reviewer: reviewerSession,
      },
      agents: [
        {
          id: "manager",
          label: "Manager",
          role: "分派",
          sessionActive: Boolean(managerSession ?? primarySession),
          runtime: runtimeLabel,
          model: modelLabel,
          status: runSnapshot?.activeRole === "manager" && this.coordinator.isRunning(chatId)
            ? "running"
            : "idle",
          description: "负责分析任务、分派 worker，并汇总最终结论。",
          latestLogs: extractRoleEvents(runSnapshot?.logs ?? [], "manager", runSnapshot?.mode),
          latestTools: extractRoleEvents(runSnapshot?.tools ?? [], "manager", runSnapshot?.mode),
        },
        {
          id: "implementer",
          label: "Implementer",
          role: "执行",
          sessionActive: Boolean(implementerSession),
          runtime: runtimeLabel,
          model: modelLabel,
          status: runSnapshot?.activeRole === "implementer" && this.coordinator.isRunning(chatId)
            ? "running"
            : "idle",
          description: "负责修改代码、运行命令、完成实现。",
          latestLogs: extractRoleEvents(runSnapshot?.logs ?? [], "implementer", runSnapshot?.mode),
          latestTools: extractRoleEvents(runSnapshot?.tools ?? [], "implementer", runSnapshot?.mode),
        },
        {
          id: "reviewer",
          label: "Reviewer",
          role: "审查",
          sessionActive: Boolean(reviewerSession),
          runtime: runtimeLabel,
          model: modelLabel,
          status: runSnapshot?.activeRole === "reviewer" && this.coordinator.isRunning(chatId)
            ? "running"
            : "idle",
          description: "负责检查结果、识别风险和测试缺口。",
          latestLogs: extractRoleEvents(runSnapshot?.logs ?? [], "reviewer", runSnapshot?.mode),
          latestTools: extractRoleEvents(runSnapshot?.tools ?? [], "reviewer", runSnapshot?.mode),
        },
      ],
      teams: this.store.listTeams(),
    };
  }

  private attachEventStream(key: string, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });

    const bucket = this.eventClients.get(key) ?? new Set<ServerResponse>();
    bucket.add(res);
    this.eventClients.set(key, bucket);

    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 15_000);

    res.on("close", () => {
      clearInterval(keepAlive);
      bucket.delete(res);
      if (bucket.size === 0) {
        this.eventClients.delete(key);
      }
    });
  }

  private async pushConsoleState(chatId: string, res: ServerResponse): Promise<void> {
    const state = await this.buildState(chatId);
    res.write(`event: state\n`);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  }

  private async pushTeamState(teamId: string, res: ServerResponse): Promise<void> {
    const state = await this.buildTeamState(teamId);
    if (!state) {
      return;
    }
    res.write(`event: team-state\n`);
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  }

  private broadcastState(chatId: string): void {
    const clients = this.eventClients.get(chatId);
    if (!clients || clients.size === 0) {
      return;
    }

    if (chatId.startsWith("web:team:")) {
      const teamId = chatId.slice("web:team:".length);
      void Promise.allSettled([...clients].map((client) => this.pushTeamState(teamId, client)));
      return;
    }

    void Promise.allSettled([...clients].map((client) => this.pushConsoleState(chatId, client)));
  }

  private async serveFrontend(pathname: string, res: ServerResponse): Promise<void> {
    if (!existsSync(WEB_INDEX_FILE)) {
      this.sendHtml(
        res,
        `<!doctype html><html lang="zh-CN"><meta charset="utf-8" /><title>Web UI Not Built</title><body style="font-family: sans-serif; padding: 32px;"><h1>Web UI 尚未构建</h1><p>请先执行 <code>pnpm build:web</code>，或在开发时运行 <code>pnpm web:dev</code>。</p></body></html>`,
      );
      return;
    }

    const target =
      pathname === "/"
        ? WEB_INDEX_FILE
        : join(WEB_DIST_DIR, pathname.replace(/^\/+/, ""));

    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) {
        this.sendJson(res, { error: "Not Found" }, 404);
        return;
      }
      res.writeHead(200, {
        "Content-Type": contentTypeFor(target),
        "Cache-Control": pathname === "/" ? "no-store" : "public, max-age=31536000, immutable",
      });
      createReadStream(target).pipe(res);
    } catch {
      this.sendJson(res, { error: "Not Found" }, 404);
    }
  }

  private getChatId(rawChatId: string): string {
    const chatId = rawChatId.trim() || "default";
    return makeWebChatId(chatId);
  }

  private sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  }

  private sendMessage(chatId: string, text: string): void {
    void this.messenger.sendMessage({ chatId, text });
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], {
      windowsHide: true,
    });
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

function buildTeamTaskPrompt(
  teamName: string,
  workdirs: string[],
  primaryPath: string,
  task: string,
): string {
  return [
    `Team Workspace: ${teamName}`,
    `主工作目录: ${primaryPath}`,
    "关联工作目录:",
    ...workdirs.map((workdir, index) => `${index + 1}. ${workdir}`),
    "",
    "执行要求:",
    "- 这是一个多工作目录 team 工作台任务。",
    "- 默认以主工作目录作为实际执行根目录。",
    "- 如果需要跨服务联动，请显式考虑上面列出的其他目录。",
    "- 所有任务先由 manager 做路由决策，再决定是否调用 implementer 或 reviewer。",
    "",
    "用户任务:",
    task,
  ].join("\n");
}

function extractRoleEvents(
  lines: string[],
  role: "manager" | "implementer" | "reviewer",
  mode?: "single" | "team",
): string[] {
  if (mode === "single" && role === "manager") {
    return lines.slice(-4);
  }
  const prefix = `[${role}] `;
  return lines
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
    .slice(-4);
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
