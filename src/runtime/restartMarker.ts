import { promises as fs } from "node:fs";

const RESTART_MARKER = "/tmp/claude_bot_ts_restart.json";

export type RestartMarker = {
  chatId: string;
  startTime: number;
};

export async function writeRestartMarker(chatId: string): Promise<void> {
  const marker: RestartMarker = {
    chatId,
    startTime: Date.now(),
  };
  await fs.writeFile(RESTART_MARKER, JSON.stringify(marker), "utf8");
}

export async function consumeRestartMarker(): Promise<RestartMarker | null> {
  try {
    const raw = await fs.readFile(RESTART_MARKER, "utf8");
    await fs.unlink(RESTART_MARKER);
    const marker = JSON.parse(raw) as Partial<RestartMarker>;
    if (!marker.chatId || !marker.startTime) {
      return null;
    }
    return {
      chatId: marker.chatId,
      startTime: marker.startTime,
    };
  } catch {
    return null;
  }
}
