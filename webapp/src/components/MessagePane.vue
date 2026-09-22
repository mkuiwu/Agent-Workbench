<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Promotion } from "@element-plus/icons-vue";

import type { WebMessage } from "../types";

const props = defineProps<{
  messages: WebMessage[];
  pendingSkill: string | null;
  running: boolean;
  sending: boolean;
}>();

const emit = defineEmits<{
  send: [text: string];
}>();

const draft = ref("");
const scroller = ref<HTMLElement | null>(null);

const title = computed(() => {
  if (props.pendingSkill) {
    return `待命技能: ${props.pendingSkill}`;
  }
  return props.running ? "Agent 正在执行" : "准备接收任务";
});

watch(
  () => props.messages.length,
  async () => {
    await nextTick();
    scroller.value?.scrollTo({
      top: scroller.value.scrollHeight,
      behavior: "smooth",
    });
  },
  { immediate: true },
);

function submit(): void {
  const text = draft.value.trim();
  if (!text) {
    return;
  }
  draft.value = "";
  emit("send", text);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="chat-shell">
    <div class="chat-toolbar">
      <div>
        <p class="eyebrow">Conversation</p>
        <h2>{{ title }}</h2>
      </div>
      <el-tag :type="running ? 'warning' : 'success'" effect="dark">
        {{ running ? 'RUNNING' : 'IDLE' }}
      </el-tag>
    </div>

    <div ref="scroller" class="message-list">
      <div
        v-for="message in messages"
        :key="message.messageId"
        :class="['message-card', message.role]"
      >
        <div class="message-meta">
          <span>{{ message.role }}</span>
          <span>#{{ message.messageId }}</span>
          <span>{{ formatTime(message.updatedAt) }}</span>
        </div>
        <div class="message-body">{{ message.text }}</div>
      </div>
      <el-empty v-if="messages.length === 0" description="这里还没有消息" />
    </div>

    <div class="composer-card">
      <el-input
        v-model="draft"
        type="textarea"
        :rows="6"
        resize="none"
        placeholder="输入任务描述。Web 端不再要求你手写 /skills 这类命令。"
        @keydown.ctrl.enter.prevent="submit"
        @keydown.meta.enter.prevent="submit"
      />
      <div class="composer-actions">
        <span class="hint">Ctrl/Cmd + Enter 发送</span>
        <el-button type="primary" :icon="Promotion" :loading="sending" @click="submit">
          发送任务
        </el-button>
      </div>
    </div>
  </div>
</template>
