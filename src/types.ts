export type AgentUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: number | undefined;
};

export type AgentContextUsage = {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model: string;
  rawText?: string;
  categories: Array<{
    name: string;
    tokens: number;
  }>;
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
  };
  memoryFiles?: Array<{
    path: string;
    type: string;
    tokens: number;
  }>;
  slashCommands?: {
    totalCommands: number;
    includedCommands: number;
    tokens: number;
  };
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
  };
};

export type AgentProgressEvent =
  | { kind: "log"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "session"; sessionId: string };

export type AgentRunResult = {
  success: boolean;
  output: string;
  error?: string;
  usage?: AgentUsage;
  contextUsage?: AgentContextUsage | null;
  sessionId?: string;
};

export type RunSnapshot = {
  title?: string;
  elapsedSeconds: number;
  cwd: string;
  logs: string[];
  tools: string[];
  queuedCount?: number;
  mode?: "single" | "team";
  phase?: string;
  activeRole?: string;
};

export type RecentRunSnapshot = {
  status: "success" | "error" | "stopped" | "interrupted";
  taskContent: string;
  elapsedSeconds: number;
  finishedAt: number;
  error?: string;
};
