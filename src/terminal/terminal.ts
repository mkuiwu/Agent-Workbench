import readline from "node:readline";

import { makeTerminalChatId } from "../channels/chatId.js";
import { BotController } from "../app/botController.js";
import type { AppConfig } from "../config.js";
import { SessionStore } from "../store/sessionStore.js";

const TERMINAL_COMMANDS = [
  "/start",
  "/info",
  "/cd",
  "/skills",
  "/use",
  "/team",
  "/heartbeat",
  "/reset",
  "/stop",
  "/compress",
  "/restart",
  "/help",
  "/exit",
  "/quit",
] as const;

export class TerminalApp {
  private rl: readline.Interface | null = null;
  private readonly chatId: string;

  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly controller: BotController,
  ) {
    this.chatId = makeTerminalChatId(this.config.terminalChatId);
  }

  async start(): Promise<void> {
    this.store.touchChat(this.chatId);
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      completer: (line: string) => this.completeInput(line),
    });

    await this.controller.handleStart(this.config.terminalUserId, this.reply);
    this.printHelp();

    this.rl.on("line", (line) => {
      void this.handleLine(line);
    });

    this.rl.on("close", () => {
      process.stdout.write("\n终端渠道已关闭。\n");
    });
  }

  stop(): void {
    this.rl?.close();
    this.rl = null;
  }

  private readonly reply = async (text: string): Promise<void> => {
    process.stdout.write(`\n[bot]\n${text}\n`);
  };

  private async handleLine(rawLine: string): Promise<void> {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    this.store.touchChat(this.chatId);

    if (line === "/exit" || line === "/quit") {
      this.stop();
      return;
    }

    if (line === "/help") {
      this.printHelp();
      return;
    }

    if (line === "/") {
      this.printHelp();
      return;
    }

    if (line.startsWith("/start")) {
      await this.controller.handleStart(this.config.terminalUserId, this.reply);
      return;
    }

    if (line.startsWith("/info")) {
      await this.controller.handleInfo(this.config.terminalUserId, this.chatId, this.reply);
      return;
    }

    if (line.startsWith("/cd")) {
      const args = line.replace(/^\/cd/, "").trim();
      const result = await this.controller.handleCdCommand(
        this.config.terminalUserId,
        this.chatId,
        args,
      );
      if (!result) {
        return;
      }
      if (result.kind === "message") {
        await this.reply(result.text);
        return;
      }
      const lines = [
        "📂 可用项目：",
        ...result.projects.map((project) => `- ${project.name}: ${project.path}`),
        "",
        "使用 /cd <路径> 切换到目标项目。",
      ];
      await this.reply(lines.join("\n"));
      return;
    }

    if (line.startsWith("/reset")) {
      await this.controller.handleReset(this.config.terminalUserId, this.chatId, this.reply);
      return;
    }

    if (line.startsWith("/heartbeat")) {
      const args = line.replace(/^\/heartbeat/, "").trim();
      await this.controller.handleHeartbeat(
        this.config.terminalUserId,
        this.chatId,
        args,
        this.reply,
      );
      return;
    }

    if (line.startsWith("/skills")) {
      await this.controller.handleSkills(this.config.terminalUserId, this.reply);
      return;
    }

    if (line.startsWith("/use")) {
      const args = line.replace(/^\/use/, "").trim();
      await this.controller.handleUseSkill(
        this.config.terminalUserId,
        this.chatId,
        args,
        this.reply,
      );
      return;
    }

    if (line.startsWith("/stop")) {
      await this.controller.handleStop(this.config.terminalUserId, this.chatId, this.reply);
      return;
    }

    if (line.startsWith("/compress")) {
      await this.controller.handleCompress(this.config.terminalUserId, this.chatId, 0);
      return;
    }

    if (line.startsWith("/restart")) {
      const shouldRestart = await this.controller.handleRestart(
        this.config.terminalUserId,
        this.chatId,
        this.reply,
      );
      if (shouldRestart) {
        setTimeout(() => {
          process.exit(0);
        }, 1000);
      }
      return;
    }

    if (line.startsWith("/")) {
      await this.reply(
        `未识别命令: ${line}\n可用命令: ${TERMINAL_COMMANDS.join(" ")}\n可按 Tab 尝试补全，或输入 /help 查看说明。`,
      );
      return;
    }

    await this.controller.handleIncomingText({
      userId: this.config.terminalUserId,
      chatId: this.chatId,
      messageId: 0,
      text: line,
      reply: this.reply,
    });
  }

  private printHelp(): void {
    process.stdout.write(
      [
        "\n[terminal]",
        "输入普通消息走单 Agent。",
        "使用 /team <任务> 进入 team 模式。",
        "支持 Tab 补全斜杠命令。",
        `常用命令: ${TERMINAL_COMMANDS.join(" ")}`,
        "",
      ].join("\n"),
    );
  }

  private completeInput(line: string): [string[], string] {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("/")) {
      return [[], line];
    }

    const hits = TERMINAL_COMMANDS.filter((command) => command.startsWith(trimmed));
    return [hits.length > 0 ? hits : [...TERMINAL_COMMANDS], trimmed];
  }
}
