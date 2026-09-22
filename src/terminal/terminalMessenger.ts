import type {
  ChatMessenger,
  InlineToggle,
  SendMessageParams,
  SentMessage,
} from "../runtime/chatMessenger.js";

export class TerminalMessenger implements ChatMessenger {
  private readonly messageIds = new Map<number, string>();
  private nextMessageId = 1;

  async sendMessage(params: SendMessageParams): Promise<SentMessage> {
    const messageId = this.nextMessageId++;
    const text = params.inlineToggle?.collapsedText ?? params.text;
    this.messageIds.set(messageId, text);
    this.printMessage(text);
    return { messageId };
  }

  async editMessageText(
    _chatId: string,
    messageId: number,
    text: string,
    inlineToggle?: InlineToggle,
  ): Promise<void> {
    const nextText = inlineToggle?.collapsedText ?? text;
    const previous = this.messageIds.get(messageId);
    if (previous === nextText) {
      return;
    }
    this.messageIds.set(messageId, nextText);
    this.printMessage(nextText);
  }

  private printMessage(text: string): void {
    process.stdout.write(`\n[bot]\n${text.trim()}\n`);
  }
}
