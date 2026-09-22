import { InlineKeyboard } from "grammy";

type ToggleState = {
  chatId: string;
  messageId: number;
  collapsedText: string;
  expandedText: string;
};

type ToggleView = {
  text: string;
  keyboard: InlineKeyboard;
};

export class TelegramInlineToggleStore {
  private readonly toggles = new Map<string, ToggleState>();
  private nextId = 1;

  create(params: {
    chatId: string;
    messageId: number;
    collapsedText: string;
    expandedText: string;
  }): InlineKeyboard {
    const key = String(this.nextId++);
    this.toggles.set(key, {
      chatId: params.chatId,
      messageId: params.messageId,
      collapsedText: params.collapsedText,
      expandedText: params.expandedText,
    });
    this.prune();
    return buildKeyboard(key, false);
  }

  resolve(data: string, chatId: string, messageId: number): ToggleView | null {
    const match = data.match(/^meta:(\d+):(show|hide)$/);
    if (!match?.[1] || !match[2]) {
      return null;
    }

    const key = match[1];
    const action = match[2];
    const state = this.toggles.get(key);
    if (!state) {
      return null;
    }
    if (state.chatId !== chatId || state.messageId !== messageId) {
      return null;
    }

    const expanded = action === "show";
    return {
      text: expanded ? state.expandedText : state.collapsedText,
      keyboard: buildKeyboard(key, expanded),
    };
  }

  private prune(): void {
    const overflow = this.toggles.size - 500;
    if (overflow <= 0) {
      return;
    }

    const keys = [...this.toggles.keys()].slice(0, overflow);
    for (const key of keys) {
      this.toggles.delete(key);
    }
  }
}

function buildKeyboard(key: string, expanded: boolean): InlineKeyboard {
  return new InlineKeyboard().text(
    expanded ? "收起系统信息" : "查看系统信息",
    `meta:${key}:${expanded ? "hide" : "show"}`,
  );
}
