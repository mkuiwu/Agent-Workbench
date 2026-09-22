import type {
  ChatMessenger,
  InlineToggle,
  SendMessageParams,
  SentMessage,
} from "../runtime/chatMessenger.js";
import { SessionStore } from "../store/sessionStore.js";

export type WebChatMessage = {
  messageId: number;
  role: "user" | "assistant" | "system";
  text: string;
  replyToMessageId?: number;
  createdAt: number;
  updatedAt: number;
};

export class WebMessenger implements ChatMessenger {
  private readonly listeners = new Set<(chatId: string) => void>();

  constructor(private readonly store: SessionStore) {}

  appendUserMessage(chatId: string, text: string): number {
    return this.appendMessage(chatId, {
      role: "user",
      text,
    });
  }

  listMessages(chatId: string): WebChatMessage[] {
    return this.store.listWebMessages(chatId);
  }

  subscribe(listener: (chatId: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(chatId: string): void {
    for (const listener of this.listeners) {
      listener(chatId);
    }
  }

  async sendMessage(params: SendMessageParams): Promise<SentMessage> {
    const messageId = this.appendMessage(params.chatId, {
      role: "assistant",
      text: params.text,
      replyToMessageId: params.replyToMessageId,
    });
    return { messageId };
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    _inlineToggle?: InlineToggle,
  ): Promise<void> {
    this.store.updateWebMessage(chatId, messageId, text);
    this.notify(chatId);
  }

  private appendMessage(
    chatId: string,
    message: Omit<WebChatMessage, "messageId" | "createdAt" | "updatedAt">,
  ): number {
    const messageId = this.store.appendWebMessage({
      chatId,
      role: message.role,
      text: message.text,
      replyToMessageId: message.replyToMessageId,
    });
    this.notify(chatId);
    return messageId;
  }
}
