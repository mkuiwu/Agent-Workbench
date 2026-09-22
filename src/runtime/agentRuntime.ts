import type { AgentContextUsage, AgentProgressEvent, AgentRunResult } from "../types.js";

export type AgentSessionCreateRequest = {
  chatId: string;
  cwd: string;
  sessionId: string | null;
  role?: string;
};

export type AgentTurnRequest = {
  task: string;
  forcedSkill?: string;
  signal: AbortSignal;
  onEvent: (event: AgentProgressEvent) => void;
};

export interface AgentSession {
  readonly sessionId: string | null;
  sendTask(request: AgentTurnRequest): Promise<AgentRunResult>;
  getContextUsage(): Promise<AgentContextUsage | null>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentRuntime {
  createSession(request: AgentSessionCreateRequest): Promise<AgentSession>;
}
