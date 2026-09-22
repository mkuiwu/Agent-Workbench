export type WebMessage = {
  messageId: number;
  role: "user" | "assistant" | "system";
  text: string;
  replyToMessageId?: number;
  createdAt: number;
  updatedAt: number;
};

export type SkillEntry = {
  name: string;
  description: string;
  displayPath: string;
};

export type ProjectEntry = {
  name: string;
  path: string;
};

export type WebState = {
  chatId: string;
  cwd: string;
  memoryMode: string;
  running: boolean;
  provider: "claude" | "kimi";
  model: string;
  sessionId: string | null;
  pendingSkill: string | null;
  projects: ProjectEntry[];
  skills: SkillEntry[];
  messages: WebMessage[];
};

export type TeamSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  workdirCount: number;
  primaryPath: string | null;
};

export type TeamWorkdir = {
  path: string;
  label: string;
  sortOrder: number;
  isPrimary: boolean;
  exists: boolean;
  status: "ready" | "missing";
  branch: string | null;
};

export type TeamAgent = {
  id: string;
  label: string;
  role: string;
  sessionActive: boolean;
  runtime: string;
  model: string;
  status: "idle" | "running";
  description: string;
  latestLogs: string[];
  latestTools: string[];
};

export type TeamRunSnapshot = {
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

export type TeamWorkspaceState = {
  teamId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  running: boolean;
  provider: "claude" | "kimi";
  model: string;
  primaryPath: string | null;
  workdirs: TeamWorkdir[];
  messages: WebMessage[];
  statusText: string;
  runSnapshot: TeamRunSnapshot | null;
  sessions: {
    manager: string | null;
    implementer: string | null;
    reviewer: string | null;
  };
  agents: TeamAgent[];
  teams: TeamSummary[];
};
