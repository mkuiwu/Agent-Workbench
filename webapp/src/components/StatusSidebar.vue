<script setup lang="ts">
import { computed } from "vue";
import { MagicStick, Refresh, SwitchButton, VideoPause } from "@element-plus/icons-vue";

import type { WebState } from "../types";

const props = defineProps<{
  state: WebState | null;
  loading: boolean;
  connected: boolean;
  chatId: string;
}>();

const emit = defineEmits<{
  refresh: [];
  project: [path: string];
  action: [name: string];
  skill: [];
  "update:chatId": [value: string];
}>();

const projectPath = computed(() => props.state?.cwd ?? "");
</script>

<template>
  <div class="sidebar">
    <div class="hero-card">
      <p class="eyebrow">Web Channel</p>
      <h1>Claude Bot Console</h1>
      <p class="subtitle">把浏览器端从命令拼接页面，升级成真正可维护的工作台。</p>
      <div class="hero-meta">
        <span :class="['status-pill', connected ? 'online' : 'offline']">
          {{ connected ? 'SSE 已连接' : 'SSE 断开' }}
        </span>
        <span class="status-pill neutral">
          {{ state?.running ? '任务执行中' : '当前空闲' }}
        </span>
      </div>
    </div>

    <el-card shadow="never" class="panel-card">
      <template #header>会话</template>
      <div class="field">
        <label>Chat ID</label>
        <el-input
          :model-value="chatId"
          placeholder="default"
          @change="(value: string) => emit('update:chatId', value)"
        />
      </div>
      <div class="stats-grid">
        <div>
          <span>Provider</span>
          <strong>{{ state?.provider ?? '-' }}</strong>
        </div>
        <div>
          <span>Model</span>
          <strong>{{ state?.model ?? '-' }}</strong>
        </div>
        <div>
          <span>Session</span>
          <strong>{{ state?.sessionId ? '已恢复' : '新会话' }}</strong>
        </div>
        <div>
          <span>Memory</span>
          <strong>{{ state?.memoryMode ?? '-' }}</strong>
        </div>
      </div>
    </el-card>

    <el-card shadow="never" class="panel-card">
      <template #header>项目</template>
      <div class="field">
        <label>Current CWD</label>
        <div class="mono-block">{{ state?.cwd ?? '-' }}</div>
      </div>
      <div class="field">
        <label>切换项目</label>
        <el-select
          :model-value="projectPath"
          placeholder="选择项目"
          filterable
          @change="(value: string) => emit('project', value)"
        >
          <el-option
            v-for="project in state?.projects ?? []"
            :key="project.path"
            :label="`${project.name} · ${project.path}`"
            :value="project.path"
          />
        </el-select>
      </div>
    </el-card>

    <el-card shadow="never" class="panel-card">
      <template #header>快捷动作</template>
      <div class="actions-grid">
        <el-button :icon="Refresh" :loading="loading" @click="emit('refresh')">刷新</el-button>
        <el-button :icon="MagicStick" @click="emit('skill')">
          {{ state?.pendingSkill ? '切换技能' : '选择技能' }}
        </el-button>
        <el-button @click="emit('action', 'info')">会话信息</el-button>
        <el-button @click="emit('action', 'start')">欢迎消息</el-button>
        <el-button @click="emit('action', 'heartbeat')">心跳状态</el-button>
        <el-button @click="emit('action', 'heartbeat-run')">执行心跳</el-button>
        <el-button @click="emit('action', 'reset')">重置会话</el-button>
        <el-button :icon="VideoPause" type="warning" @click="emit('action', 'stop')">停止任务</el-button>
        <el-button :icon="SwitchButton" @click="emit('action', 'compress')">压缩上下文</el-button>
      </div>
    </el-card>
  </div>
</template>
