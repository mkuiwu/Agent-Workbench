import type { Api } from "grammy";

import { parseTelegramChatId } from "../channels/chatId.js";
import { TelegramInlineToggleStore } from "./telegramInlineToggleStore.js";
import type {
  ChatMessenger,
  InlineToggle,
  SendMessageParams,
  SentMessage,
} from "../runtime/chatMessenger.js";

export class TelegramMessenger implements ChatMessenger {
  private readonly chatQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly api: Api,
    private readonly inlineToggleStore: TelegramInlineToggleStore,
  ) {}

  async sendMessage(params: SendMessageParams): Promise<SentMessage> {
    return this.enqueue(params.chatId, async () => {
      const message = await this.callWithRetry(
        `sendMessage chat=${params.chatId} replyTo=${params.replyToMessageId ?? "-"}`,
        () =>
          this.api.sendMessage(
            parseTelegramChatId(params.chatId),
            params.text,
            replyParams(params.replyToMessageId),
          ),
      );
      if (params.inlineToggle) {
        const keyboard = this.inlineToggleStore.create({
          chatId: params.chatId,
          messageId: message.message_id,
          collapsedText: params.inlineToggle.collapsedText,
          expandedText: params.inlineToggle.expandedText,
        });
        await this.callWithRetry(
          `editMessageReplyMarkup chat=${params.chatId} messageId=${message.message_id}`,
          () =>
            this.api.editMessageReplyMarkup(parseTelegramChatId(params.chatId), message.message_id, {
              reply_markup: keyboard,
            }),
        );
      }
      return {
        messageId: message.message_id,
      };
    });
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    inlineToggle?: InlineToggle,
  ): Promise<void> {
    await this.enqueue(chatId, async () => {
      const keyboard = inlineToggle
        ? this.inlineToggleStore.create({
            chatId,
            messageId,
            collapsedText: inlineToggle.collapsedText,
            expandedText: inlineToggle.expandedText,
          })
        : undefined;
      await this.callWithRetry(
        `editMessageText chat=${chatId} messageId=${messageId}`,
        () =>
          this.api.editMessageText(parseTelegramChatId(chatId), messageId, text, keyboard
            ? { reply_markup: keyboard }
            : undefined),
      );
    });
  }

  private enqueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task);
    this.chatQueues.set(
      chatId,
      next.finally(() => {
        if (this.chatQueues.get(chatId) === next) {
          this.chatQueues.delete(chatId);
        }
      }),
    );
    return next;
  }

  private async callWithRetry<T>(
    label: string,
    action: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await action();
      } catch (error) {
        attempt += 1;
        const retryDelayMs = getRetryDelayMs(error, attempt);
        const retryable = retryDelayMs !== null && attempt < 4;
        console.error(
          `[telegram] ${label} failed (attempt ${attempt}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (!retryable) {
          throw error;
        }
        await sleep(retryDelayMs);
      }
    }
  }
}

function replyParams(messageId?: number) {
  return messageId ? { reply_parameters: { message_id: messageId } } : undefined;
}

function getRetryDelayMs(error: unknown, attempt: number): number | null {
  const retryAfterSeconds = extractRetryAfterSeconds(error);
  if (retryAfterSeconds !== null) {
    return retryAfterSeconds * 1000;
  }

  if (!isRetryableNetworkError(error)) {
    return null;
  }

  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function extractRetryAfterSeconds(error: unknown): number | null {
  const candidate = error as {
    parameters?: { retry_after?: number };
    payload?: { parameters?: { retry_after?: number } };
    description?: string;
  } | null;

  const retryAfter =
    candidate?.parameters?.retry_after ??
    candidate?.payload?.parameters?.retry_after;
  if (typeof retryAfter === "number" && retryAfter > 0) {
    return retryAfter;
  }

  const description = candidate?.description;
  if (typeof description === "string") {
    const match = description.match(/retry after (\d+)/i);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }

  return null;
}

function isRetryableNetworkError(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    error?: { code?: string };
    message?: string;
    description?: string;
  } | null;

  const code = candidate?.code ?? candidate?.error?.code;
  if (typeof code === "string" && ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(code)) {
    return true;
  }

  const text = `${candidate?.message ?? ""} ${candidate?.description ?? ""}`.toLowerCase();
  return text.includes("timeout") || text.includes("timed out") || text.includes("network");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
