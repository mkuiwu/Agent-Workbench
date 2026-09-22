const TELEGRAM_PREFIX = "telegram:";
const WEB_PREFIX = "web:";
const WEB_TEAM_PREFIX = "web:team:";
const TERMINAL_PREFIX = "terminal:";

export function makeTelegramChatId(chatId: string | number): string {
  return `${TELEGRAM_PREFIX}${chatId}`;
}

export function parseTelegramChatId(chatId: string): number {
  if (!chatId.startsWith(TELEGRAM_PREFIX)) {
    return Number(chatId);
  }
  return Number(chatId.slice(TELEGRAM_PREFIX.length));
}

export function makeWebChatId(chatId: string): string {
  return `${WEB_PREFIX}${chatId}`;
}

export function makeWebTeamChatId(teamId: string): string {
  return `${WEB_TEAM_PREFIX}${teamId}`;
}

export function makeTerminalChatId(chatId: string): string {
  return `${TERMINAL_PREFIX}${chatId}`;
}
