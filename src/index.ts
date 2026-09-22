import { config as loadEnvFile } from "dotenv";

import { loadConfig } from "./config.js";
import { ClaudeAgent } from "./agent/claudeAgent.js";
import { KimiAgent } from "./agent/kimiAgent.js";
import { BotController } from "./app/botController.js";
import { HeartbeatService } from "./heartbeat/heartbeatService.js";
import { RoutedMessenger } from "./runtime/routedMessenger.js";
import { TelegramMessenger } from "./bot/telegramMessenger.js";
import { SessionStore } from "./store/sessionStore.js";
import { TelegramApp } from "./bot/telegram.js";
import { RunCoordinator } from "./runtime/runCoordinator.js";
import { WebMessenger } from "./web/webMessenger.js";
import { WebApp } from "./web/web.js";
import { TelegramInlineToggleStore } from "./bot/telegramInlineToggleStore.js";
import { TerminalApp } from "./terminal/terminal.js";
import { TerminalMessenger } from "./terminal/terminalMessenger.js";

loadEnvFile({
  path: process.env.ENV_FILE || ".env",
  override: false,
});

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new SessionStore(config.dbPath);
  const agent = config.agentProvider === "kimi"
    ? new KimiAgent(config)
    : new ClaudeAgent(config);
  const routedMessenger = new RoutedMessenger();
  const coordinator = new RunCoordinator(
    routedMessenger,
    store,
    agent,
  );
  coordinator.initializeFromStore();
  const heartbeat = new HeartbeatService(config, store, coordinator);
  const controller = new BotController(config, store, coordinator, heartbeat);
  const apps: Array<{ start(): Promise<void>; stop(): void }> = [];

  if (config.appChannels.includes("telegram")) {
    const telegramInlineToggleStore = new TelegramInlineToggleStore();
    const telegramApp = new TelegramApp(config, store, controller, telegramInlineToggleStore);
    routedMessenger.register(
      "telegram",
      new TelegramMessenger(telegramApp.api, telegramInlineToggleStore),
    );
    apps.push(telegramApp);
  }

  if (config.appChannels.includes("web")) {
    const webMessenger = new WebMessenger(store);
    routedMessenger.register("web", webMessenger);
    apps.push(new WebApp(config, store, controller, coordinator, webMessenger));
  }

  if (config.appChannels.includes("terminal")) {
    routedMessenger.register("terminal", new TerminalMessenger());
    apps.push(new TerminalApp(config, store, controller));
  }

  process.on("SIGINT", () => {
    heartbeat.stop();
    apps.forEach((app) => app.stop());
    void coordinator.close();
    store.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    heartbeat.stop();
    apps.forEach((app) => app.stop());
    void coordinator.close();
    store.close();
    process.exit(0);
  });

  console.log(`🚀 Agent Workbench 正在启动... [Provider: ${config.agentProvider}]`);
  heartbeat.start();
  await coordinator.resumePersistedQueues();
  await Promise.all(apps.map((app) => app.start()));
}

void main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
