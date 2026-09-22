import { computed, ref } from "vue";
import { defineStore } from "pinia";

import {
  addTeamWorkdir,
  createTeam,
  deleteTeam,
  fetchTeamState,
  fetchTeams,
  moveTeamWorkdir,
  postTeamMessage,
  removeTeamWorkdir,
  renameTeam,
  runTeamAction,
  setPrimaryTeamWorkdir,
} from "../api";
import type { TeamSummary, TeamWorkspaceState } from "../types";

export const useTeamStore = defineStore("team", () => {
  const teamId = ref("");
  const teams = ref<TeamSummary[]>([]);
  const state = ref<TeamWorkspaceState | null>(null);
  const loading = ref(false);
  const sending = ref(false);
  const connected = ref(false);
  let eventSource: EventSource | null = null;

  const ready = computed(() => state.value !== null);

  async function refreshTeams(): Promise<void> {
    teams.value = await fetchTeams();
  }

  async function refresh(): Promise<void> {
    if (!teamId.value) {
      await refreshTeams();
      return;
    }
    loading.value = true;
    try {
      state.value = await fetchTeamState(teamId.value);
      teams.value = state.value.teams;
    } finally {
      loading.value = false;
    }
  }

  function connect(): void {
    disconnect();
    if (!teamId.value) {
      return;
    }
    const source = new EventSource(`/api/team/events?teamId=${encodeURIComponent(teamId.value)}`);
    source.addEventListener("team-state", (event) => {
      const message = event as MessageEvent<string>;
      state.value = JSON.parse(message.data) as TeamWorkspaceState;
      teams.value = state.value.teams;
      connected.value = true;
    });
    source.onerror = () => {
      connected.value = false;
    };
    eventSource = source;
  }

  function disconnect(): void {
    eventSource?.close();
    eventSource = null;
    connected.value = false;
  }

  async function selectTeam(nextTeamId: string): Promise<void> {
    if (!nextTeamId) {
      teamId.value = "";
      state.value = null;
      disconnect();
      await refreshTeams();
      return;
    }
    teamId.value = nextTeamId;
    await refresh();
    connect();
  }

  async function create(name: string): Promise<void> {
    state.value = await createTeam(name);
    teamId.value = state.value.teamId;
    teams.value = state.value.teams;
    connect();
  }

  async function rename(name: string): Promise<void> {
    if (!teamId.value) {
      return;
    }
    state.value = await renameTeam(teamId.value, name);
    teams.value = state.value.teams;
  }

  async function remove(): Promise<void> {
    if (!teamId.value) {
      return;
    }
    const removedId = teamId.value;
    const result = await deleteTeam(teamId.value);
    teams.value = result.teams;
    disconnect();
    if (teams.value.length > 0) {
      await selectTeam(teams.value[0].id);
    } else {
      teamId.value = "";
      state.value = null;
    }
    if (removedId === teamId.value) {
      teamId.value = "";
    }
  }

  async function addWorkdir(path: string): Promise<void> {
    if (!teamId.value) {
      return;
    }
    state.value = await addTeamWorkdir(teamId.value, path);
    teams.value = state.value.teams;
  }

  async function removeWorkdir(path: string): Promise<void> {
    if (!teamId.value) {
      return;
    }
    state.value = await removeTeamWorkdir(teamId.value, path);
    teams.value = state.value.teams;
  }

  async function setPrimary(path: string): Promise<void> {
    if (!teamId.value) {
      return;
    }
    state.value = await setPrimaryTeamWorkdir(teamId.value, path);
    teams.value = state.value.teams;
  }

  async function moveWorkdir(path: string, direction: "up" | "down"): Promise<void> {
    if (!teamId.value) {
      return;
    }
    state.value = await moveTeamWorkdir(teamId.value, path, direction);
    teams.value = state.value.teams;
  }

  async function send(text: string): Promise<void> {
    if (!teamId.value) {
      return;
    }
    sending.value = true;
    try {
      state.value = await postTeamMessage(teamId.value, text);
      teams.value = state.value.teams;
    } finally {
      sending.value = false;
    }
  }

  async function action(name: string): Promise<void> {
    if (!teamId.value) {
      return;
    }
    state.value = await runTeamAction(teamId.value, name);
    if (state.value) {
      teams.value = state.value.teams;
    }
  }

  async function bootstrap(): Promise<void> {
    await refreshTeams();
    if (teams.value.length > 0) {
      await selectTeam(teams.value[0].id);
    }
  }

  return {
    teamId,
    teams,
    state,
    loading,
    sending,
    connected,
    ready,
    refreshTeams,
    refresh,
    connect,
    disconnect,
    selectTeam,
    create,
    rename,
    remove,
    addWorkdir,
    removeWorkdir,
    setPrimary,
    moveWorkdir,
    send,
    action,
    bootstrap,
  };
});
