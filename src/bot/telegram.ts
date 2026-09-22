import { Bot, InlineKeyboard } from "grammy";
import { HttpsProxyAgent } from "https-proxy-agent";

import { makeTelegramChatId, parseTelegramChatId } from "../channels/chatId.js";
import { BotController } from "../app/botController.js";
import type { AppConfig } from "../config.js";
import { consumeRestartMarker } from "../runtime/restartMarker.js";
import { SessionStore } from "../store/sessionStore.js";
import { TelegramInlineToggleStore } from "./telegramInlineToggleStore.js";

export class TelegramApp {
  private readonly bot: Bot;
  private readonly projectCallbackCache = new Map<string, string>();
  private readonly startedAt = Date.now();
  private readonly staleMessageWarnedChats = new Set<string>();
  private static readonly SKILLS_PAGE_SIZE = 6;

  constructor(
    private readonly config: AppConfig,
    private readonly store: SessionStore,
    private readonly controller: BotController,
    private readonly inlineToggleStore: TelegramInlineToggleStore,
  ) {
    if (config.proxy) {
      process.env.HTTPS_PROXY = config.proxy;
      process.env.HTTP_PROXY = config.proxy;
    }
    const telegramProxy = config.proxy ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    this.bot = new Bot(config.botToken, {
      client: telegramProxy
        ? {
            baseFetchConfig: {
              agent: new HttpsProxyAgent(telegramProxy),
            },
          }
        : undefined,
    });
  }

  async start(): Promise<void> {
    this.registerHandlers();
    console.log("📋 注册 Telegram 命令列表...");
    try {
      await this.bot.api.setMyCommands([
        { command: "start", description: "开始使用" },
        { command: "cd", description: "项目/目录切换菜单" },
        { command: "heartbeat", description: "查看或手动执行心跳任务" },
        { command: "team", description: "按角色路由任务" },
        { command: "skills", description: "列出并选择可用技能" },
        { command: "info", description: "查看当前状态" },
        { command: "reset", description: "清理当前项目记忆" },
        { command: "compress", description: "压缩对话上下文 (保持 Session)" },
        { command: "stop", description: "强行停止当前任务" },
        { command: "restart", description: "重启机器人 (由 PM2 拉起)" },
      ]);
      console.log("✅ Telegram 命令列表注册完成");
    } catch (error) {
      console.warn("⚠️ Telegram 命令列表注册失败 (网络问题)，将跳过继续启动:", error instanceof Error ? error.message : String(error));
    }
    await this.checkRestartMarker();
    console.log("🤖 Telegram Bot 正在监听消息...");
    void this.bot.start({
      onStart: (info) => {
        console.log(`✨ Telegram Bot 已成功启动: @${info.username}`);
      },
    });
  }

  stop(): void {
    this.bot.stop();
  }

  get api() {
    return this.bot.api;
  }

  private registerHandlers(): void {
    this.bot.command("start", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      await this.controller.handleStart(ctx.from?.id, async (text) => {
        await ctx.reply(text);
      });
    });

    this.bot.command("team", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      const messageText = ctx.message?.text ?? "";
      const content = messageText.replace(/^\/team(@\w+)?/, "").trim();
      if (!content) {
        await ctx.reply("用法: /team <任务>");
        return;
      }
      await this.controller.handleIncomingText({
        userId: ctx.from?.id,
        chatId,
        messageId: ctx.msg.message_id,
        text: `/team ${content}`,
        reply: async (text) => {
          await ctx.reply(text);
        },
      });
    });

    this.bot.command("info", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      await this.controller.handleInfo(ctx.from?.id, chatId, async (text) => {
        await ctx.reply(text);
      });
    });

    this.bot.command("cd", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      const messageText = ctx.message?.text ?? "";
      const args = messageText.replace(/^\/cd(@\w+)?/, "").trim();
      const result = await this.controller.handleCdCommand(ctx.from?.id, chatId, args);
      if (!result) {
        return;
      }

      if (result.kind === "message") {
        await ctx.reply(result.text);
        return;
      }

      this.projectCallbackCache.clear();
      const keyboard = new InlineKeyboard();
      result.projects.forEach((project, index) => {
        const callbackData = `cdidx:${index}`;
        this.projectCallbackCache.set(callbackData, project.path);
        keyboard.text(`📦 ${project.name}`, callbackData);
        if (index % 2 === 1) {
          keyboard.row();
        }
      });

      await ctx.reply("📂 请选择要切换到的项目工作区:", {
        reply_markup: keyboard,
      });
    });

    this.bot.command("reset", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      await this.controller.handleReset(ctx.from?.id, chatId, async (text) => {
        await ctx.reply(text);
      });
    });

    this.bot.command("heartbeat", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      const messageText = ctx.message?.text ?? "";
      const args = messageText.replace(/^\/heartbeat(@\w+)?/, "").trim();
      await this.controller.handleHeartbeat(ctx.from?.id, chatId, args, async (text) => {
        await ctx.reply(text);
      });
    });

    this.bot.command("skills", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      await this.replySkillsMenu(chatId, ctx.from?.id, async (text, keyboard) => {
        await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
      });
    });

    this.bot.command("use", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      const messageText = ctx.message?.text ?? "";
      const args = messageText.replace(/^\/use(@\w+)?/, "").trim();
      await this.controller.handleUseSkill(ctx.from?.id, chatId, args, async (text) => {
        await ctx.reply(text);
      });
    });

    this.bot.command("stop", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      await this.controller.handleStop(ctx.from?.id, chatId, async (text) => {
        await ctx.reply(text);
      });
    });

    this.bot.command("compress", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      await this.controller.handleCompress(ctx.from?.id, chatId, ctx.msg.message_id);
    });

    this.bot.command("restart", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      const shouldRestart = await this.controller.handleRestart(
        ctx.from?.id,
        chatId,
        async (text) => {
          await ctx.reply(text);
        },
      );
      if (!shouldRestart) {
        return;
      }
      setTimeout(() => {
        process.exit(0);
      }, 1000);
    });

    this.bot.callbackQuery(/^cdidx:\d+$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const targetPath = this.projectCallbackCache.get(ctx.callbackQuery.data);
      if (!targetPath) {
        await ctx.editMessageText("❌ 项目列表已过期，请重新执行 /cd。");
        return;
      }
      if (!ctx.chat) {
        return;
      }

      const chatId = this.touchChat(ctx.chat.id);
      const text = await this.controller.handleProjectSelection(
        ctx.from?.id,
        chatId,
        targetPath,
      );
      if (!text) {
        return;
      }
      await ctx.editMessageText(text);
    });

    this.bot.callbackQuery(/^skill:(use:[^:]+|cancel|refresh|page:\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      if (!ctx.chat) {
        return;
      }

      const chatId = this.touchChat(ctx.chat.id);
      const data = ctx.callbackQuery.data;
      const page = data.startsWith("skill:page:") ? Number(data.slice("skill:page:".length)) : 0;
      if (data === "skill:cancel") {
        const pending = this.controller.getPendingSkill(ctx.from?.id, chatId);
        if (pending) {
          await this.controller.handleUseSkill(ctx.from?.id, chatId, "cancel", async () => {});
          await ctx.editMessageText("✅ 已取消待命技能。");
        } else {
          await ctx.editMessageText("已取消技能选择。");
        }
        return;
      }

      if (data.startsWith("skill:use:")) {
        const skillName = data.slice("skill:use:".length);
        await this.controller.handleUseSkill(ctx.from?.id, chatId, skillName, async () => {});
      }

      await this.replySkillsMenu(chatId, ctx.from?.id, async (text, keyboard) => {
        await ctx.editMessageText(text, keyboard ? { reply_markup: keyboard } : undefined);
      }, page);
    });

    this.bot.callbackQuery(/^meta:\d+:(show|hide)$/, async (ctx) => {
      if (!ctx.chat || !ctx.callbackQuery.message) {
        await ctx.answerCallbackQuery({ text: "系统信息已失效", show_alert: false });
        return;
      }

      const chatId = this.touchChat(ctx.chat.id);
      const view = this.inlineToggleStore.resolve(
        ctx.callbackQuery.data,
        chatId,
        ctx.callbackQuery.message.message_id,
      );
      if (!view) {
        await ctx.answerCallbackQuery({ text: "系统信息已失效", show_alert: false });
        return;
      }

      await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
      await ctx.answerCallbackQuery();
    });

    this.bot.on("message:text", async (ctx) => {
      const chatId = this.touchChat(ctx.chat.id);
      if (isStaleTelegramMessage(ctx.msg.date, this.startedAt)) {
        if (!this.staleMessageWarnedChats.has(chatId)) {
          this.staleMessageWarnedChats.add(chatId);
          await ctx.reply("⚠️ 检测到这是机器人本次启动前的历史消息，已忽略。请重新发送一次。");
        }
        return;
      }
      await this.controller.handleIncomingText({
        userId: ctx.from?.id,
        chatId,
        messageId: ctx.msg.message_id,
        text: ctx.message.text,
        reply: async (text) => {
          await ctx.reply(text);
        },
      });
    });

    this.bot.catch((error) => {
      console.error("Telegram bot error", error.error);
    });
  }

  private touchChat(rawChatId: string | number): string {
    const chatId = makeTelegramChatId(rawChatId);
    this.store.touchChat(chatId);
    return chatId;
  }

  private async checkRestartMarker(): Promise<void> {
    const marker = await consumeRestartMarker();
    if (!marker) {
      return;
    }
    if (!marker.chatId.startsWith("telegram:")) {
      return;
    }
    const elapsed = Math.max(1, Math.floor((Date.now() - marker.startTime) / 1000));
    await this.bot.api.sendMessage(
      parseTelegramChatId(marker.chatId),
      `✅ 机器人已启动完成！\n\n耗时: ${elapsed}s`,
    );
  }

  private async replySkillsMenu(
    chatId: string,
    userId: number | undefined,
    reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
    page = 0,
  ): Promise<void> {
    const skills = await this.controller.getAvailableSkills(userId);
    if (skills.length === 0) {
      await reply("🧰 当前没有发现可用技能\n目录: ~/.claude/skills");
      return;
    }

    const pending = this.controller.getPendingSkill(userId, chatId);
    const totalPages = Math.max(1, Math.ceil(skills.length / TelegramApp.SKILLS_PAGE_SIZE));
    const currentPage = Math.min(Math.max(0, page), totalPages - 1);
    const start = currentPage * TelegramApp.SKILLS_PAGE_SIZE;
    const visibleSkills = skills.slice(start, start + TelegramApp.SKILLS_PAGE_SIZE);
    const keyboard = new InlineKeyboard();
    visibleSkills.forEach((skill, index) => {
      const selected = pending === skill.name;
      keyboard.text(`${selected ? "✅ " : ""}${skill.name}`, `skill:use:${skill.name}`);
      if (index % 2 === 1) {
        keyboard.row();
      }
    });
    if (visibleSkills.length % 2 === 1) {
      keyboard.row();
    }
    if (totalPages > 1) {
      if (currentPage > 0) {
        keyboard.text("上一页", `skill:page:${currentPage - 1}`);
      }
      if (currentPage < totalPages - 1) {
        keyboard.text("下一页", `skill:page:${currentPage + 1}`);
      }
      keyboard.row();
    }
    keyboard.text("刷新", `skill:page:${currentPage}`);
    keyboard.text(pending ? "取消技能" : "取消", "skill:cancel");

    const lines = [
      `🧰 可用技能 (${skills.length})`,
      "点击按钮即可选择，下一条普通消息将自动使用该技能。",
      `页码: ${currentPage + 1}/${totalPages}`,
    ];
    if (pending) {
      lines.push("", `当前待命技能: ${pending}`);
    }
    lines.push("");
    lines.push(...visibleSkills.map((skill) => {
      const selected = pending === skill.name ? "✅ " : "";
      return `- ${selected}${skill.name}: ${skill.description}`;
    }));
    await reply(lines.join("\n"), keyboard);
  }
}

function isStaleTelegramMessage(messageDateSeconds: number, startedAtMs: number): boolean {
  return messageDateSeconds * 1000 < startedAtMs - 10_000;
}
