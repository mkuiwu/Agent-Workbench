import type { TeamSummary, TeamWorkspaceState, WebState } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchState(chatId: string): Promise<WebState> {
  return request(`/api/state?chatId=${encodeURIComponent(chatId)}`);
}

export function postMessage(chatId: string, text: string): Promise<WebState> {
  return request("/api/message", {
    method: "POST",
    body: JSON.stringify({ chatId, text }),
  });
}

export function selectProject(chatId: string, projectPath: string): Promise<WebState> {
  return request("/api/project", {
    method: "POST",
    body: JSON.stringify({ chatId, projectPath }),
  });
}

export function selectSkill(chatId: string, skillName: string | null): Promise<WebState> {
  return request("/api/skill", {
    method: "POST",
    body: JSON.stringify({ chatId, skillName }),
  });
}

export function runAction(chatId: string, action: string): Promise<WebState> {
  return request("/api/action", {
    method: "POST",
    body: JSON.stringify({ chatId, action }),
  });
}

export function fetchTeams(): Promise<TeamSummary[]> {
  return request("/api/teams");
}

export function fetchTeamState(teamId: string): Promise<TeamWorkspaceState> {
  return request(`/api/team/state?teamId=${encodeURIComponent(teamId)}`);
}

export function createTeam(name: string): Promise<TeamWorkspaceState> {
  return request("/api/team/create", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function renameTeam(teamId: string, name: string): Promise<TeamWorkspaceState> {
  return request("/api/team/update", {
    method: "POST",
    body: JSON.stringify({ teamId, name }),
  });
}

export function deleteTeam(teamId: string): Promise<{ ok: true; teams: TeamSummary[] }> {
  return request("/api/team/delete", {
    method: "POST",
    body: JSON.stringify({ teamId }),
  });
}

export function addTeamWorkdir(teamId: string, path: string): Promise<TeamWorkspaceState> {
  return request("/api/team/workdir/add", {
    method: "POST",
    body: JSON.stringify({ teamId, path }),
  });
}

export function removeTeamWorkdir(teamId: string, path: string): Promise<TeamWorkspaceState> {
  return request("/api/team/workdir/remove", {
    method: "POST",
    body: JSON.stringify({ teamId, path }),
  });
}

export function setPrimaryTeamWorkdir(teamId: string, path: string): Promise<TeamWorkspaceState> {
  return request("/api/team/workdir/primary", {
    method: "POST",
    body: JSON.stringify({ teamId, path }),
  });
}

export function moveTeamWorkdir(
  teamId: string,
  path: string,
  direction: "up" | "down",
): Promise<TeamWorkspaceState> {
  return request("/api/team/workdir/move", {
    method: "POST",
    body: JSON.stringify({ teamId, path, direction }),
  });
}

export function postTeamMessage(teamId: string, text: string): Promise<TeamWorkspaceState> {
  return request("/api/team/message", {
    method: "POST",
    body: JSON.stringify({ teamId, text }),
  });
}

export function runTeamAction(teamId: string, action: string): Promise<TeamWorkspaceState> {
  return request("/api/team/action", {
    method: "POST",
    body: JSON.stringify({ teamId, action }),
  });
}
