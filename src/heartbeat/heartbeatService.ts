import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

import type { AppConfig } from "../config.js";
import { RunCoordinator } from "../runtime/runCoordinator.js";
import { SessionStore } from "../store/sessionStore.js";

type HeartbeatStatus = {
  filePath: string;
  exists: boolean;
  tasks: string[];
  intervalSeconds: number;
  lastTriggeredAt: number | null;
};

type HeartbeatRunResult =
  | { status: "missing"; filePath: string }
  | { status: "empty"; filePath: string }
  | { status: "throttled"; filePath: string; lastTriggeredAt: number }
  | { status: "started"; filePath: string; tasks: string[] };

export class HeartbeatService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly coordinator: RunCoordinator,
  ) {}

  start(): void {
    // ⚠️ HEARTBEAT 定时检查已禁用
    // 原因: 设计笨粗，缺少 cron 表达式调度，频繁触发消耗 token
    // 建议: 使用专业定时任务系统（如 cron-air）替代
    // 即使存在 HEARTBEAT.md 文件也不会被自动执行
    console.log(`⚠️ HEARTBEAT 已禁用: ${this.config.heartbeatFileName} 不会被自动检查`);
    return;
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async describe(chatId: string): Promise<HeartbeatStatus> {
    const cwd = this.store.getCwd(chatId);
    const filePath = resolve(cwd, this.config.heartbeatFileName);
    const exists = await fileExists(filePath);
    const tasks = exists ? await readHeartbeatTasks(filePath) : [];
    return {
      filePath,
      exists,
      tasks,
      intervalSeconds: this.config.heartbeatIntervalSeconds,
      lastTriggeredAt: this.store.getHeartbeatLastTriggeredAt(chatId, filePath),
    };
  }

  async trigger(
    chatId: string,
    options: { source?: "manual" | "auto" } = {},
  ): Promise<HeartbeatRunResult> {
    const cwd = this.store.getCwd(chatId);
    const filePath = resolve(cwd, this.config.heartbeatFileName);
    const exists = await fileExists(filePath);
    if (!exists) {
      return {
        status: "missing",
        filePath,
      };
    }

    const tasks = await readHeartbeatTasks(filePath);
    if (tasks.length === 0) {
      return {
        status: "empty",
        filePath,
      };
    }

    const source = options.source ?? "manual";
    const lastTriggeredAt = this.store.getHeartbeatLastTriggeredAt(chatId, filePath);
    if (
      source === "auto" &&
      lastTriggeredAt &&
      Date.now() - lastTriggeredAt < this.config.heartbeatIntervalSeconds * 1000
    ) {
      return {
        status: "throttled",
        filePath,
        lastTriggeredAt,
      };
    }

    this.store.saveHeartbeatTrigger(chatId, filePath, Date.now());
    void this.coordinator.runTask({
      chatId,
      content: buildHeartbeatPrompt(filePath, tasks),
      silentQueueNotice: source === "auto",
    });

    return {
      status: "started",
      filePath,
      tasks,
    };
  }

  private async tick(): Promise<void> {
    const chats = this.store.listTrackedChats();
    for (const chat of chats) {
      const result = await this.trigger(chat.convoId, { source: "auto" });
      if (result.status === "started") {
        console.log(
          `💓 已为 chat ${chat.convoId} 触发 HEARTBEAT: ${result.tasks.length} 项任务`,
        );
      }
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readHeartbeatTasks(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, "utf8");
  const tasks: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+\[\s\]\s+(.+?)\s*$/);
    if (match?.[1]) {
      tasks.push(match[1]);
    }
  }
  return tasks;
}

function buildHeartbeatPrompt(filePath: string, tasks: string[]): string {
  const now = new Date().toLocaleString("zh-CN", {
    hour12: false,
  });
  return [
    `现在是一次定时 HEARTBEAT 检查，当前时间：${now}。`,
    `请执行 ${filePath} 中的周期任务，并直接给出本轮执行结果。`,
    "",
    "任务列表：",
    ...tasks.map((task) => `- ${task}`),
    "",
    "要求：",
    "- 先检查再行动，不要假设外部状态。",
    "- 如果某项本轮无需处理，可以简短说明原因。",
    "- 输出适合直接发回 Telegram 的简洁周期报告。",
  ].join("\n");
}
