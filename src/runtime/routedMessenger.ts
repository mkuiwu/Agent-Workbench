import type {
  ChatMessenger,
  SendMessageParams,
  SentMessage,
} from "./chatMessenger.js";

export class RoutedMessenger implements ChatMessenger {
  private readonly messengers = new Map<string, ChatMessenger>();

  register(channel: string, messenger: ChatMessenger): void {
    this.messengers.set(channel, messenger);
  }

  async sendMessage(params: SendMessageParams): Promise<SentMessage> {
    return this.getMessenger(params.chatId).sendMessage(params);
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    inlineToggle?: SendMessageParams["inlineToggle"],
  ): Promise<void> {
    await this.getMessenger(chatId).editMessageText(chatId, messageId, text, inlineToggle);
  }

  private getMessenger(chatId: string): ChatMessenger {
    const separatorIndex = chatId.indexOf(":");
    const channel = separatorIndex >= 0 ? chatId.slice(0, separatorIndex) : "telegram";
    const messenger = this.messengers.get(channel);
    if (!messenger) {
      throw new Error(`No messenger registered for channel: ${channel}`);
    }
    return messenger;
  }
}
