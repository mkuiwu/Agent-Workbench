import { promises as fs } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import type { AppConfig } from "../config.js";
import { isAdmin } from "../config.js";
import { HeartbeatService } from "../heartbeat/heartbeatService.js";
import { scanProjects, type ProjectEntry } from "../projects/scanProjects.js";
import { classifyTask } from "../router.js";
import { RunCoordinator } from "../runtime/runCoordinator.js";
import { writeRestartMarker } from "../runtime/restartMarker.js";
import { SessionStore } from "../store/sessionStore.js";
import { renderInfoMessage } from "../ui/render.js";

type ReplyFn = (text: string) => Promise<void>;
type UserId = string | number | undefined;
export type SkillEntry = {
  name: string;
  displayPath: string;
  description: string;
};

export type CdCommandResult =
  | { kind: "message"; text: string }
  | { kind: "project-picker"; projects: ProjectEntry[] };

export class BotController {
  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly coordinator: RunCoordinator,
    private readonly heartbeat: HeartbeatService,
  ) {}

  async handleStart(userId: UserId, reply: ReplyFn): Promise<void> {
    if (!this.isAuthorized(userId)) {
      return;
    }

    await reply(
      "👋 你好！我是 Agent Workbench。\n\n我会根据你的输入自动触发 Agent 执行任务（如编写代码、运行指令等）。\n普通消息默认走单 Agent；使用 /team <任务> 会先由 manager 路由，再按任务需要调用 implementer 和/或 reviewer。\n你可以通过 /cd 快速切换工作目录及代码仓；终端渠道可用 /help 查看命令。",
    );
  }

  async handleInfo(
    userId: UserId,
    chatId: string,
    reply: ReplyFn,
  ): Promise<void> {
    if (!this.isAuthorized(userId)) {
      return;
    }

    const cwd = this.store.getCwd(chatId);
    const sessionId = this.store.getSessionId(chatId, cwd);
    const model = this.config.agentProvider === "kimi"
      ? (this.config.kimiModel ?? "kimi-latest")
      : (this.config.claudeModel ?? "跟随 Claude CLI 默认");
    await reply(
      renderInfoMessage({
        provider: this.config.agentProvider,
        model,
        cwd,
        sessionId,
        running: this.coordinator.isRunning(chatId),
      }),
    );
  }

  async handleSkills(
    userId: UserId,
    reply: ReplyFn,
  ): Promise<void> {
    if (!this.isAuthorized(userId)) {
      return;
    }

    const displayRoot = toTildePath(this.config.skillsRoot);
    const skills = await this.listSkills();
    if (skills.length === 0) {
      await reply(`🧰 当前没有发现可用技能\n目录: ${displayRoot}`);
      return;
    }

    const lines = [
      `🧰 可用技能 (${skills.length})`,
      `目录: ${displayRoot}`,
      "",
      ...skills.map((skill) => `- ${skill.name} · ${skill.displayPath}`),
    ];
    await reply(lines.join("\n"));
  }

  async getAvailableSkills(userId: UserId): Promise<SkillEntry[]> {
    if (!this.isAuthorized(userId)) {
      return [];
    }
    return this.listSkills();
  }

  getPendingSkill(userId: UserId, chatId: string): string | null {
    if (!this.isAuthorized(userId)) {
      return null;
    }
    return this.store.getPendingSkill(chatId, this.store.getCwd(chatId));
  }

  async handleUseSkill(
    userId: UserId,
    chatId: string,
    args: string,
    reply: ReplyFn,
  ): Promise<void> {
    if (!this.isAuthorized(userId)) {
      return;
    }

    const trimmed = args.trim();
    const cwd = this.store.getCwd(chatId);
    if (!trimmed) {
      const pending = this.store.getPendingSkill(chatId, cwd);
      await reply(
        pending
          ? `🧰 当前待使用技能: ${pending}\n发送下一条普通消息时将自动使用它。\n使用 /use cancel 可取消。`
          : "用法: /use <skill>\n示例: /use traceid-troubleshoot\n发送 /use cancel 可取消当前待命技能。",
      );
      return;
    }

    if (trimmed === "cancel") {
      this.store.clearPendingSkill(chatId, cwd);
      await reply("✅ 已取消待命技能。");
      return;
    }

    const skill = await this.findSkillByName(trimmed);
    if (!skill) {
      await reply(`❌ 未找到技能: ${trimmed}\n使用 /skills 查看可用技能列表。`);
      return;
    }

    this.store.setPendingSkill(chatId, cwd, skill.name);
    await reply(
      `🧰 已选择技能: ${skill.name}\n路径: ${skill.displayPath}\n\n下一条普通消息将自动使用该技能。\n使用 /use cancel 可取消。`,
    );
  }

  async handleHeartbeat(
    userId: UserId,
    chatId: string,
    args: string,
    reply: ReplyFn,
  ): Promise<void> {
    if (!this.isAuthorized(userId)) {
      return;
    }

    if (args === "run") {
      const result = await this.heartbeat.trigger(chatId);
      if (result.status === "missing") {
        await reply(
          `❌ 未找到心跳任务文件\n路径: ${result.filePath}\n\n新建这个文件，并用 Markdown 待办格式写任务，例如:\n- [ ] 检查 CI 状态`,
        );
        return;
      }
      if (result.status === "empty") {
        await reply(
          `ℹ️ 心跳文件存在，但没有可执行任务\n路径: ${result.filePath}\n\n请使用 \`- [ ] 任务描述\` 的格式添加周期任务。`,
        );
        return;
      }
      if (result.status === "throttled") {
        await reply(
          `⏳ 自动心跳刚刚触发过，已跳过重复执行\n路径: ${result.filePath}\n最近触发: ${new Date(result.lastTriggeredAt).toLocaleString("zh-CN", { hour12: false })}`,
        );
        return;
      }

      await reply(
        `💓 已手动触发 HEARTBEAT\n路径: ${result.filePath}\n任务数: ${result.tasks.length}`,
      );
      return;
    }

    const status = await this.heartbeat.describe(chatId);
    const lines = [
      "💓 HEARTBEAT 状态（仅手动触发）",
      "",
      `文件: ${status.filePath}`,
      "自动调度: 已禁用",
      `文件状态: ${status.exists ? "✅ 已存在" : "❌ 未创建"}`,
      `最近触发: ${status.lastTriggeredAt ? new Date(status.lastTriggeredAt).toLocaleString("zh-CN", { hour12: false }) : "从未触发"}`,
    ];

    if (!status.exists) {
      lines.push("", "创建这个项目内文件后，使用 /heartbeat run 手动执行其中未完成的任务。");
      lines.push("示例:", "- [ ] 检查依赖更新", "- [ ] 查看线上错误趋势");
      await reply(lines.join("\n"));
      return;
    }

    if (status.tasks.length === 0) {
      lines.push("", "当前没有可执行任务。请使用 `- [ ] 任务描述` 的格式添加周期任务。");
      await reply(lines.join("\n"));
      return;
    }

    lines.push("", "当前任务:");
    lines.push(...status.tasks.map((task) => `- [ ] ${task}`));
    lines.push("", "使用 /heartbeat run 可以立即手动触发一次。");
    await reply(lines.join("\n"));
  }

  async handleCdCommand(
    userId: UserId,
    chatId: string,
    args: string,
  ): Promise<CdCommandResult | null> {
    if (!this.isAuthorized(userId)) {
      return null;
    }

    if (args) {
      return {
        kind: "message",
        text: await this.changeDirManual(chatId, args),
      };
    }

    const projects = scanProjects(this.config.projectRoots);
    if (projects.length === 0) {
      const roots = this.config.projectRoots.length
        ? this.config.projectRoots.map((root) => `• ${root}`).join("\n")
        : "• 未配置 PROJECT_ROOTS";
      return {
        kind: "message",
        text: `❌ 未在以下目录中找到任何代码仓：\n${roots}`,
      };
    }

    return {
      kind: "project-picker",
      projects,
    };
  }

  async handleProjectSelection(
    userId: UserId,
    chatId: string,
    projectPath: string,
  ): Promise<string | null> {
    if (!this.isAuthorized(userId)) {
      return null;
    }

    this.store.saveCwd(chatId, projectPath);
    const sessionId = this.store.getSessionId(chatId, projectPath);
    const status = sessionId ? "已恢复上次对话状态" : "开启新对话";
    return `✅ 已切换至项目: ${projectPath.split("/").pop()}\n路径: ${projectPath}\n\n状态: ${status}`;
  }

  async handleReset(
    userId: UserId,
    chatId: string,
    reply: ReplyFn,
  ): Promise<void> {
    if (!this.isAuthorized(userId)) {
      return;
    }

    const cwd = this.store.getCwd(chatId);
    await this.coordinator.resetScope(chatId);
    this.store.clearSessionId(chatId, cwd);
    this.store.clearPendingSkill(chatId, cwd);
    const target = cwd.split("/").pop() ?? cwd;
    await reply(`✅ 已重置 ${target} 的会话记忆。`);
  }

  async handleStop(
    userId: UserId,
    chatId: string,
    reply: ReplyFn,
  ): Promise<void> {
    if (!this.isAuthorized(userId)) {
      return;
    }

    const result = this.coordinator.stop(chatId);
    if (!result.stoppedCurrentTask && result.clearedQueuedCount === 0) {
      await reply("当前没有正在运行的任务。");
      return;
    }

    if (result.stoppedCurrentTask && result.clearedQueuedCount > 0) {
      await reply(`🛑 已停止当前任务，并清空 ${result.clearedQueuedCount} 条排队消息。`);
      return;
    }

    if (result.stoppedCurrentTask) {
      await reply("🛑 已停止当前任务。");
      return;
    }

    await reply(`🛑 已清空 ${result.clearedQueuedCount} 条排队消息。`);
  }

  async handleCompress(
    userId: UserId,
    chatId: string,
    messageId: number,
  ): Promise<void> {
    if (!this.isAuthorized(userId)) {
      return;
    }

    const prompt = "请帮我总结并压缩当前的对话上下文，保留关键信息，以便我们能更高效地继续。";
    void this.coordinator.runTask({
      chatId,
      content: prompt,
      messageId,
    });
  }

  async handleRestart(
    userId: UserId,
    chatId: string,
    reply: ReplyFn,
  ): Promise<boolean> {
    if (!this.isAuthorized(userId)) {
      return false;
    }

    await writeRestartMarker(chatId);
    await reply("🔄 正在重新启动机器人，预计 5-10 秒完成...");
    return true;
  }

  async handleIncomingText(params: {
    userId: UserId;
    chatId: string;
    text: string;
    messageId: number;
    reply: ReplyFn;
  }): Promise<void> {
    if (!this.isAuthorized(params.userId)) {
      return;
    }

    this.store.touchChat(params.chatId);

    const { taskType, content } = classifyTask(params.text);
    if (!content) {
      return;
    }

    if (taskType === "status") {
      await params.reply(this.coordinator.getStatus(params.chatId));
      return;
    }

    if (taskType !== "code" && taskType !== "team") {
      return;
    }

    const cwd = this.store.getCwd(params.chatId);
    const forcedSkill = this.store.getPendingSkill(params.chatId, cwd);
    if (forcedSkill) {
      this.store.clearPendingSkill(params.chatId, cwd);
      await params.reply(`🧰 本次任务将使用技能: ${forcedSkill}`);
    }

    void this.coordinator.runTask({
      chatId: params.chatId,
      content,
      mode: taskType === "team" ? "team" : "single",
      forcedSkill: forcedSkill ?? undefined,
      messageId: params.messageId,
    });
  }

  private isAuthorized(userId: UserId): boolean {
    return userId !== undefined && isAdmin(this.config, userId);
  }

  private async changeDirManual(chatId: string, inputPath: string): Promise<string> {
    const currentCwd = this.store.getCwd(chatId);
    const absolutePath = resolve(currentCwd, inputPath);
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isDirectory()) {
        return `❌ 路径无效: ${absolutePath}`;
      }

      this.store.saveCwd(chatId, absolutePath);
      return `✅ 目录已手动切换至:\n${absolutePath}`;
    } catch {
      return `❌ 路径无效: ${absolutePath}`;
    }
  }

  private async listSkills(): Promise<SkillEntry[]> {
    try {
      const entries = await fs.readdir(this.config.skillsRoot, { withFileTypes: true });
      const skills: SkillEntry[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }

        const skillDir = resolve(this.config.skillsRoot, entry.name);
        try {
          const dirStat = await fs.stat(skillDir);
          if (!dirStat.isDirectory()) {
            continue;
          }
          const stat = await fs.stat(resolve(skillDir, "SKILL.md"));
          if (!stat.isFile()) {
            continue;
          }
          const skillFilePath = resolve(skillDir, "SKILL.md");
          const description = await readSkillDescription(skillFilePath);
          skills.push({
            name: entry.name,
            displayPath: toTildePath(skillDir),
            description,
          });
        } catch {
          continue;
        }
      }

      return skills.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    } catch {
      return [];
    }
  }

  private async findSkillByName(name: string): Promise<SkillEntry | null> {
    const normalized = name.trim();
    if (!normalized) {
      return null;
    }
    const skills = await this.listSkills();
    return skills.find((skill) => skill.name === normalized) ?? null;
  }
}

function toTildePath(absolutePath: string): string {
  const home = homedir();
  if (absolutePath === home) {
    return "~";
  }
  const rel = relative(home, absolutePath);
  if (!rel || rel.startsWith("..")) {
    return absolutePath;
  }
  return `~${sep}${rel}`;
}

async function readSkillDescription(skillFilePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(skillFilePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("#")) {
        continue;
      }
      return truncateDescription(line);
    }
  } catch {
    return "无简介";
  }
  return "无简介";
}

function truncateDescription(text: string, maxLength = 56): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}
