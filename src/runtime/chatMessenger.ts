export type SendMessageParams = {
  chatId: string;
  text: string;
  replyToMessageId?: number;
  inlineToggle?: InlineToggle;
};

export type SentMessage = {
  messageId: number;
};

export type InlineToggle = {
  collapsedText: string;
  expandedText: string;
};

export interface ChatMessenger {
  sendMessage(params: SendMessageParams): Promise<SentMessage>;
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    inlineToggle?: InlineToggle,
  ): Promise<void>;
}
