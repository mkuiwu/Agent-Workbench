import { computed, ref } from "vue";
import { defineStore } from "pinia";

import { fetchState, postMessage, runAction, selectProject, selectSkill } from "../api";
import type { WebState } from "../types";

const DEFAULT_CHAT_ID = "default";

export const useChatStore = defineStore("chat", () => {
  const chatId = ref(DEFAULT_CHAT_ID);
  const state = ref<WebState | null>(null);
  const loading = ref(false);
  const sending = ref(false);
  const connected = ref(false);
  let eventSource: EventSource | null = null;

  const ready = computed(() => state.value !== null);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      state.value = await fetchState(chatId.value);
    } finally {
      loading.value = false;
    }
  }

  async function send(text: string): Promise<void> {
    sending.value = true;
    try {
      state.value = await postMessage(chatId.value, text);
    } finally {
      sending.value = false;
    }
  }

  async function action(name: string): Promise<void> {
    state.value = await runAction(chatId.value, name);
  }

  async function changeProject(projectPath: string): Promise<void> {
    state.value = await selectProject(chatId.value, projectPath);
  }

  async function changeSkill(skillName: string | null): Promise<void> {
    state.value = await selectSkill(chatId.value, skillName);
  }

  function connect(): void {
    disconnect();
    const source = new EventSource(`/api/events?chatId=${encodeURIComponent(chatId.value)}`);
    source.addEventListener("state", (event) => {
      const message = event as MessageEvent<string>;
      state.value = JSON.parse(message.data) as WebState;
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

  async function switchChat(nextChatId: string): Promise<void> {
    const normalized = nextChatId.trim() || DEFAULT_CHAT_ID;
    if (normalized === chatId.value && state.value) {
      connect();
      return;
    }
    chatId.value = normalized;
    await refresh();
    connect();
  }

  return {
    chatId,
    state,
    loading,
    sending,
    connected,
    ready,
    refresh,
    send,
    action,
    changeProject,
    changeSkill,
    connect,
    disconnect,
    switchChat,
  };
});
