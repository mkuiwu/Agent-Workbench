import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { cwd as processCwd } from "node:process";
import { homedir } from "node:os";

import { z } from "zod";

const envSchema = z.object({
  BOT_TOKEN: z.string().optional(),
  NICK: z.string().optional(),
  ADMIN_LIST: z.string().optional(),
  AGENT_PROVIDER: z.enum(["claude", "kimi"]).default("claude"),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODEL: z.string().optional(),
  KIMI_MODEL: z.string().optional(),
  KIMI_THINKING: z.string().optional(),
  KIMI_EXECUTABLE: z.string().optional(),
  MODEL_PRICE_PER_MILLION: z.coerce.number().default(0.3),
  API_TIMEOUT_MS: z.string().default("600000"),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: z.string().default("1"),
  ANTHROPIC_DEFAULT_HAIKU_MODEL: z.string().optional(),
  ANTHROPIC_DEFAULT_OPUS_MODEL: z.string().optional(),
  ANTHROPIC_DEFAULT_SONNET_MODEL: z.string().optional(),
  RESET_TIME: z.coerce.number().default(3600),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().default(1800),
  HEARTBEAT_FILE: z.string().default("HEARTBEAT.md"),
  LANGUAGE: z.string().default("Simplified Chinese"),
  PROJECT_ROOTS: z.string().optional(),
  DB_PATH: z.string().default("runtime_tasks.db"),
  HTTP_PROXY: z.string().optional(),
  APP_CHANNELS: z.string().default("telegram"),
  WEB_HOST: z.string().default("127.0.0.1"),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_USER_ID: z.string().optional(),
  TERMINAL_USER_ID: z.string().optional(),
  TERMINAL_CHAT_ID: z.string().optional(),
  SKILLS_ROOT: z.string().optional(),
});

const channelSchema = z.enum(["telegram", "web", "terminal"]);
type AppChannel = z.infer<typeof channelSchema>;

function splitCsv(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function discoverProjectRoots(configured?: string): string[] {
  const candidates = splitCsv(configured).map((item) => resolve(item));
  if (candidates.length === 0) {
    const current = resolve(processCwd());
    candidates.push(resolve(current, ".."));
    candidates.push(resolve(homedir(), "code"));
    candidates.push(resolve(homedir(), "mycode"));
  }

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate) || !existsSync(candidate)) {
      continue;
    }
    seen.add(candidate);
    roots.push(candidate);
  }
  return roots;
}

export type AgentProvider = "claude" | "kimi";

export type AppConfig = {
  botToken: string;
  nick?: string;
  adminList: string[];
  agentProvider: AgentProvider;
  apiKey?: string;
  baseUrl?: string;
  claudeModel?: string;
  kimiModel?: string;
  kimiThinking?: boolean;
  kimiExecutable?: string;
  modelPricePerMillion: number;
  extraEnv: Record<string, string>;
  resetTime: number;
  heartbeatIntervalSeconds: number;
  heartbeatFileName: string;
  language: string;
  projectRoots: string[];
  dbPath: string;
  proxy?: string;
  appChannels: AppChannel[];
  webHost: string;
  webPort: number;
  webUserId: string;
  terminalUserId: string;
  terminalChatId: string;
  skillsRoot: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const data = parsed.data;
  const adminList = splitCsv(data.ADMIN_LIST);
  const appChannels = parseChannels(data.APP_CHANNELS);
  if (appChannels.includes("telegram") && !data.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is required when telegram channel is enabled");
  }

  // API Key 仅在 Claude 模式下强制要求
  const apiKey =
    data.ANTHROPIC_AUTH_TOKEN ?? data.ANTHROPIC_API_KEY ?? data.API_KEY;
  if (data.AGENT_PROVIDER === "claude" && !apiKey) {
    throw new Error("ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY or API_KEY is required when using claude provider");
  }

  return {
    botToken: data.BOT_TOKEN ?? "",
    nick: data.NICK,
    adminList,
    agentProvider: data.AGENT_PROVIDER,
    apiKey: apiKey ?? "",
    baseUrl: data.ANTHROPIC_BASE_URL,
    claudeModel: data.ANTHROPIC_MODEL,
    kimiModel: data.KIMI_MODEL,
    kimiThinking: data.KIMI_THINKING === "true" ? true : data.KIMI_THINKING === "false" ? false : undefined,
    kimiExecutable: data.KIMI_EXECUTABLE,
    modelPricePerMillion: data.MODEL_PRICE_PER_MILLION,
    extraEnv: compactEnv({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: data.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      ANTHROPIC_DEFAULT_OPUS_MODEL: data.ANTHROPIC_DEFAULT_OPUS_MODEL,
      ANTHROPIC_DEFAULT_SONNET_MODEL: data.ANTHROPIC_DEFAULT_SONNET_MODEL,
      API_TIMEOUT_MS: data.API_TIMEOUT_MS,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
        data.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    }),
    resetTime: data.RESET_TIME,
    heartbeatIntervalSeconds: data.HEARTBEAT_INTERVAL_SECONDS,
    heartbeatFileName: data.HEARTBEAT_FILE,
    language: data.LANGUAGE,
    projectRoots: discoverProjectRoots(data.PROJECT_ROOTS),
    dbPath: resolve(data.DB_PATH),
    proxy: data.HTTP_PROXY,
    appChannels,
    webHost: data.WEB_HOST,
    webPort: data.WEB_PORT,
    webUserId: data.WEB_USER_ID ?? adminList[0] ?? "web",
    terminalUserId: data.TERMINAL_USER_ID ?? adminList[0] ?? "terminal",
    terminalChatId: data.TERMINAL_CHAT_ID ?? "main",
    skillsRoot: resolveHomePath(data.SKILLS_ROOT ?? "~/.claude/skills"),
  };
}

function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function isAdmin(config: AppConfig, userId: string | number): boolean {
  if (config.adminList.length === 0) {
    return true;
  }
  return config.adminList.includes(String(userId));
}

function parseChannels(value: string): AppChannel[] {
  const entries = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const parsed = z.array(channelSchema).safeParse(entries.length ? entries : ["telegram"]);
  if (!parsed.success) {
    throw new Error("APP_CHANNELS must contain only telegram, web and/or terminal");
  }
  return [...new Set(parsed.data)];
}

function resolveHomePath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}
