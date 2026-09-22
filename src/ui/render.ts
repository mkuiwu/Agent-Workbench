import type {
  AgentContextUsage,
  AgentUsage,
  RecentRunSnapshot,
  RunSnapshot,
} from "../types.js";

export const TELEGRAM_MESSAGE_LIMIT = 4000;

export function renderRunSnapshot(snapshot: RunSnapshot): string {
  const lines: string[] = [
    snapshot.title ?? "⏳ Agent 执行中...",
    `已耗时: ${formatElapsedSeconds(snapshot.elapsedSeconds)} | 📂 ${snapshot.cwd}`,
  ];

  if (snapshot.mode === "team") {
    const teamMeta: string[] = [];
    if (snapshot.phase) {
      teamMeta.push(`阶段: ${snapshot.phase}`);
    }
    if (snapshot.activeRole) {
      teamMeta.push(`角色: ${snapshot.activeRole}`);
    }
    if (teamMeta.length > 0) {
      lines.push(teamMeta.join(" | "));
    }
  }

  if (snapshot.queuedCount && snapshot.queuedCount > 0) {
    lines.push(`等待队列: ${snapshot.queuedCount}`);
  }

  if (snapshot.logs.length > 0) {
    lines.push("", ...snapshot.logs.slice(-8));
  }
  if (snapshot.tools.length > 0) {
    lines.push("", "最近工具活动:", ...snapshot.tools.slice(-6));
  }

  return lines.join("\n");
}

export function renderInfoMessage(opts: {
  provider: "claude" | "kimi";
  model: string;
  cwd: string;
  sessionId: string | null;
  running: boolean;
}): string {
  const providerText = opts.provider === "kimi"
    ? "Kimi Agent SDK (Live Session)"
    : "Claude Agent SDK (Live Session)";
  return [
    "🔍 当前系统状态",
    "",
    `Provider: ${opts.provider}`,
    `Model: ${opts.model}`,
    `Working Directory: ${opts.cwd}`,
    `Session Memory: ${opts.sessionId ? "✅ 已激活" : "🆕 当前项目暂无活会话"}`,
    `Task Running: ${opts.running ? "⏳ 执行中" : "空闲"}`,
    `Agent Mode: ${providerText}`,
  ].join("\n");
}

export function renderFinalMessage(
  output: string,
  _usage?: AgentUsage,
  _elapsedSeconds?: number,
  _contextUsage?: AgentContextUsage | null,
): string {
  return output.trim();
}

export function renderFinalSystemInfo(
  usage?: AgentUsage,
  elapsedSeconds?: number,
  contextUsage?: AgentContextUsage | null,
): string | null {
  const lines: string[] = [];
  if (typeof elapsedSeconds === "number") {
    lines.push(`⏱ ${formatElapsedSeconds(elapsedSeconds)}`);
  }

  if (contextUsage?.rawText) {
    lines.push(contextUsage.rawText);
  } else if (contextUsage && contextUsage.maxTokens > 0) {
    lines.push(
      `ctx ${contextUsage.totalTokens.toLocaleString()}/${contextUsage.maxTokens.toLocaleString()} (${contextUsage.percentage.toFixed(1)}%)`,
    );
  } else {
    const usageSummary = renderUsageSummary(usage);
    if (usageSummary) {
      lines.push(usageSummary);
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

export function renderErrorMessage(error: string): string {
  return `❌ 任务失败\n原因: ${error}`;
}

export function renderRecentRunStatus(snapshot: RecentRunSnapshot): string {
  const statusText =
    snapshot.status === "success"
      ? "✅ 最近一次任务已完成"
      : snapshot.status === "interrupted"
        ? "⚠️ 最近一次任务因进程重启或崩溃而中断"
      : snapshot.status === "stopped"
        ? "🛑 最近一次任务已终止"
        : "❌ 最近一次任务失败";
  const lines = [
    "当前没有正在运行的任务。",
    "",
    statusText,
    `耗时: ${formatElapsedSeconds(snapshot.elapsedSeconds)}`,
    `结束时间: ${new Date(snapshot.finishedAt).toLocaleTimeString("zh-CN", { hour12: false })}`,
  ];

  if (snapshot.taskContent) {
    lines.push(`任务: ${truncateText(snapshot.taskContent, 120)}`);
  }
  if (snapshot.error) {
    lines.push(`原因: ${snapshot.error}`);
  }

  return lines.join("\n");
}

export function splitLongMessage(text: string, max = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= max) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const slice = remaining.slice(0, max);
    const lastBreak = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const cut = lastBreak > max * 0.6 ? lastBreak : max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function renderContextUsage(usage?: AgentContextUsage | null): string | null {
  if (!usage) {
    return null;
  }

  if (usage.rawText) {
    return ["🧠 上下文占用:", usage.rawText].join("\n");
  }

  if (usage.maxTokens <= 0) {
    return null;
  }

  const lines = [
    "🧠 上下文占用:",
    `${usage.totalTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} (${usage.percentage.toFixed(1)}%)`,
  ];

  const topCategories = usage.categories
    .filter((category) => category.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4);
  if (topCategories.length > 0) {
    lines.push(
      `分类: ${topCategories
        .map((category) => `${category.name} ${category.tokens.toLocaleString()}`)
        .join(" | ")}`,
    );
  }

  const breakdown: string[] = [];
  if (usage.messageBreakdown) {
    const messageTokens =
      usage.messageBreakdown.userMessageTokens + usage.messageBreakdown.assistantMessageTokens;
    if (messageTokens > 0) {
      breakdown.push(`messages ${messageTokens.toLocaleString()}`);
    }
    const toolTokens =
      usage.messageBreakdown.toolCallTokens + usage.messageBreakdown.toolResultTokens;
    if (toolTokens > 0) {
      breakdown.push(`tools ${toolTokens.toLocaleString()}`);
    }
  }
  const memoryTokens = (usage.memoryFiles ?? []).reduce((sum, file) => sum + file.tokens, 0);
  if (memoryTokens > 0) {
    breakdown.push(`memory ${memoryTokens.toLocaleString()}`);
  }
  if (usage.skills?.tokens && usage.skills.tokens > 0) {
    breakdown.push(`skills ${usage.skills.tokens.toLocaleString()}`);
  }
  if (usage.slashCommands?.tokens && usage.slashCommands.tokens > 0) {
    breakdown.push(`slash ${usage.slashCommands.tokens.toLocaleString()}`);
  }
  if (breakdown.length > 0) {
    lines.push(`明细: ${breakdown.join(" | ")}`);
  }

  return lines.join("\n");
}

function renderUsage(usage?: AgentUsage): string | null {
  if (!usage) {
    return null;
  }
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const total = input + output + cacheRead + cacheCreate;
  if (total <= 0) {
    return null;
  }

  const lines = [
    "💰 Token 统计:",
    `Input: ${input.toLocaleString()}`,
  ];
  if (cacheRead > 0) {
    lines.push(`Cache Read: ${cacheRead.toLocaleString()}`);
  }
  if (cacheCreate > 0) {
    lines.push(`Cache Create: ${cacheCreate.toLocaleString()}`);
  }
  lines.push(`Output: ${output.toLocaleString()}`);
  lines.push(`Total: ${total.toLocaleString()}`);
  return lines.join("\n");
}

function renderUsageSummary(usage?: AgentUsage): string | null {
  if (!usage) {
    return null;
  }
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const total = input + output + cacheRead + cacheCreate;
  if (total <= 0) {
    return null;
  }
  return `tokens ${total.toLocaleString()}`;
}

function formatElapsedSeconds(elapsedSeconds: number): string {
  const seconds = Math.max(0, Math.floor(elapsedSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${remainingSeconds}s`);
  return parts.join(" ");
}

function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}
