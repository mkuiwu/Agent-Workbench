<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  ArrowDown,
  ArrowUp,
  Delete,
  FolderAdd,
  FolderChecked,
  Plus,
  Promotion,
  Refresh,
  Setting,
  VideoPause,
  View,
} from "@element-plus/icons-vue";

import type { TeamWorkspaceState } from "../types";

const props = defineProps<{
  teams: TeamWorkspaceState["teams"];
  state: TeamWorkspaceState | null;
  loading: boolean;
  sending: boolean;
  connected: boolean;
}>();

const emit = defineEmits<{
  selectTeam: [teamId: string];
  createTeam: [name: string];
  renameTeam: [name: string];
  deleteTeam: [];
  refresh: [];
  addWorkdir: [path: string];
  removeWorkdir: [path: string];
  setPrimary: [path: string];
  moveWorkdir: [path: string, direction: "up" | "down"];
  send: [text: string];
  action: [action: string];
}>();

const activeView = ref<"workspace" | "run">("workspace");
const activeAgentId = ref<string>("implementer");
const draft = ref("");
const createDialogOpen = ref(false);
const settingsDialogOpen = ref(false);
const runTaskDialogOpen = ref(false);
const timelineDialogOpen = ref(false);
const activityDialogOpen = ref(false);
const createName = ref("");
const renameName = ref("");
const workdirInput = ref("");
const scroller = ref<HTMLElement | null>(null);

const timelineItems = computed(() => {
  const messages = props.state?.messages ?? [];
  return [...messages]
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "assistant") {
        const parsed = parseTeamAssistant(message.text);
        return {
          ...message,
          parsed,
          hasStructuredBlocks: Boolean(parsed.manager || parsed.implementer || parsed.reviewer),
        };
      }
      return {
        ...message,
        parsed: null,
        hasStructuredBlocks: false,
      };
    })
    .reverse();
});

const selectedAgent = computed(() => {
  const agents = props.state?.agents ?? [];
  return agents.find((agent) => agent.id === activeAgentId.value) ?? agents[0] ?? null;
});

const selectedAgentTimeline = computed(() => {
  const agentId = selectedAgent.value?.id;
  if (!agentId) {
    return [];
  }

  return timelineItems.value
    .map((message) => {
      if (message.role !== "assistant" || !message.parsed) {
        return null;
      }

      const text =
        agentId === "manager"
          ? (message.parsed.manager ?? message.text)
          : agentId === "implementer"
            ? message.parsed.implementer
            : message.parsed.reviewer;

      if (!text) {
        return null;
      }

      return {
        messageId: message.messageId,
        updatedAt: message.updatedAt,
        text,
      };
    })
    .filter((item): item is { messageId: number; updatedAt: number; text: string } => item !== null);
});

const selectedAgentLogs = computed(() => {
  const agentId = selectedAgent.value?.id;
  const logs = props.state?.runSnapshot?.logs ?? [];
  if (!agentId) {
    return logs;
  }

  if (props.state?.runSnapshot?.mode === "single" && agentId === "manager") {
    return logs;
  }

  const prefix = `[${agentId}]`;
  return logs.filter((line) => line.includes(prefix));
});

const selectedAgentTools = computed(() => {
  const agentId = selectedAgent.value?.id;
  const tools = props.state?.runSnapshot?.tools ?? [];
  if (!agentId) {
    return tools;
  }

  if (props.state?.runSnapshot?.mode === "single" && agentId === "manager") {
    return tools;
  }

  const prefix = `[${agentId}]`;
  return tools.filter((line) => line.includes(prefix));
});

const latestAgentLog = computed(() => selectedAgentLogs.value.at(-1) ?? null);
const latestAgentTool = computed(() => selectedAgentTools.value.at(-1) ?? null);
const latestAgentActivity = computed(() => latestAgentTool.value ?? latestAgentLog.value);
const selectedAgentActivityFeed = computed(() => {
  const entries = [
    ...selectedAgentTools.value.map((line) => ({ kind: "工具", line })),
    ...selectedAgentLogs.value.map((line) => ({ kind: "日志", line })),
  ];
  return entries.reverse().slice(0, 12);
});

watch(
  () => props.state?.teamId,
  () => {
    renameName.value = props.state?.name ?? "";
    const firstAgentId = props.state?.agents?.[0]?.id ?? "implementer";
    activeAgentId.value = firstAgentId;
  },
  { immediate: true },
);

watch(
  () => props.state?.agents,
  (agents) => {
    if (!agents || agents.length === 0) {
      activeAgentId.value = "implementer";
      return;
    }
    if (!agents.some((agent) => agent.id === activeAgentId.value)) {
      activeAgentId.value = agents[0].id;
    }
  },
  { immediate: true },
);

watch(
  () => props.state?.messages.length ?? 0,
  async () => {
    await nextTick();
    scroller.value?.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  },
);

function createTeam(): void {
  const name = createName.value.trim() || "New Team Workspace";
  createName.value = "";
  createDialogOpen.value = false;
  emit("createTeam", name);
}

function submitTask(): void {
  const text = draft.value.trim();
  if (!text) {
    return;
  }
  draft.value = "";
  runTaskDialogOpen.value = false;
  emit("send", text);
}

function submitWorkdir(): void {
  const path = workdirInput.value.trim();
  if (!path) {
    return;
  }
  workdirInput.value = "";
  emit("addWorkdir", path);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function parseTeamAssistant(text: string): {
  manager: string | null;
  implementer: string | null;
  reviewer: string | null;
} {
  const manager = text.match(/## Manager\s*([\s\S]*?)(?:\n## Implementer|$)/)?.[1]?.trim() ?? null;
  const implementer = text.match(/## Implementer\s*([\s\S]*?)(?:\n## Reviewer|$)/)?.[1]?.trim() ?? null;
  const reviewer = text.match(/## Reviewer\s*([\s\S]*?)(?:\n## Final|$)/)?.[1]?.trim() ?? null;
  const final = text.match(/## Final\s*([\s\S]*?)$/)?.[1]?.trim() ?? null;
  return {
    manager: final ? [manager, final].filter(Boolean).join("\n\n") : manager,
    implementer,
    reviewer,
  };
}
</script>

<template>
  <div class="team-shell">
    <aside class="team-nav">
      <div class="team-nav-head">
        <div>
          <p class="eyebrow">Team</p>
          <h2>列表</h2>
        </div>
        <el-button :icon="Plus" circle @click="createDialogOpen = true" />
      </div>

      <div class="team-list">
        <button
          v-for="team in teams"
          :key="team.id"
          :class="['team-list-item', state?.teamId === team.id ? 'active' : '']"
          @click="emit('selectTeam', team.id)"
        >
          <strong>{{ team.name }}</strong>
          <span>{{ team.workdirCount }} dirs</span>
          <small>{{ team.primaryPath ?? '未设置主目录' }}</small>
        </button>
      </div>
    </aside>

    <main class="team-main">
      <section v-if="activeView === 'workspace'" class="workspace-board">
        <div class="board-head">
          <div>
            <p class="eyebrow">My Workspace</p>
            <h3>{{ state?.name ?? '工作目录' }}</h3>
            <p class="board-subtitle">
              {{ state?.primaryPath ?? '先创建 Team，再绑定工作目录。' }}
            </p>
          </div>
          <div class="board-actions">
            <el-segmented
              v-model="activeView"
              :options="[
                { label: '我的工作台', value: 'workspace' },
                { label: '执行工作台', value: 'run' },
              ]"
            />
            <span :class="['status-pill', connected ? 'online' : 'offline']">
              {{ connected ? '实时同步中' : '实时连接中断' }}
            </span>
            <span class="status-pill neutral light">
              {{ state?.running ? '运行中' : '空闲' }}
            </span>
            <span class="status-pill neutral light subtle">
              {{ connected ? '状态自动更新' : '可手动同步兜底' }}
            </span>
            <el-button :icon="Setting" @click="settingsDialogOpen = true">设置</el-button>
          </div>
        </div>

        <div class="workspace-cards">
          <div v-for="workdir in state?.workdirs ?? []" :key="workdir.path" class="workspace-card">
            <div class="workspace-card-head">
              <div>
                <strong>{{ workdir.label }}</strong>
                <p>{{ workdir.isPrimary ? '主工作目录' : '附属工作目录' }}</p>
              </div>
              <el-tag :type="workdir.status === 'ready' ? 'success' : 'danger'" effect="plain">
                {{ workdir.status }}
              </el-tag>
            </div>
            <div class="workspace-meta">
              <span>路径: {{ workdir.path }}</span>
              <span>分支: {{ workdir.branch ?? '非 Git 或不可用' }}</span>
            </div>
          </div>
        </div>

        <el-card shadow="never" class="panel-card slim">
          <template #header>当前状态</template>
          <pre class="status-pre">{{ state?.statusText ?? '请选择或创建一个 Team。' }}</pre>
        </el-card>
      </section>

      <section v-else class="run-board">
        <section class="run-control-strip">
          <div class="run-strip-head">
            <div>
              <p class="eyebrow">Execution Desk</p>
              <h3>{{ state?.name ?? 'Agent 控制台' }}</h3>
              <p class="board-subtitle">
                {{ state?.primaryPath ?? '先创建 Team，再绑定工作目录。' }}
              </p>
            </div>
            <div class="run-strip-actions">
              <el-segmented
                v-model="activeView"
                :options="[
                  { label: '我的工作台', value: 'workspace' },
                  { label: '执行工作台', value: 'run' },
                ]"
              />
              <span :class="['status-pill', connected ? 'online' : 'offline']">
                {{ connected ? '实时同步中' : '实时连接中断' }}
              </span>
              <span class="status-pill neutral light">
                {{ state?.running ? '运行中' : '空闲' }}
              </span>
              <span class="status-pill neutral light subtle">
                {{ connected ? '状态自动更新' : '可手动同步兜底' }}
              </span>
              <el-button :icon="Refresh" :loading="loading" @click="emit('refresh')">手动同步</el-button>
              <el-button :icon="VideoPause" type="warning" @click="emit('action', 'stop')">停止</el-button>
              <el-button type="primary" :icon="Promotion" :loading="sending" @click="runTaskDialogOpen = true">
                新任务
              </el-button>
            </div>
          </div>

          <div class="agent-chip-list">
            <button
              v-for="agent in state?.agents ?? []"
              :key="agent.id"
              :class="['agent-chip', activeAgentId === agent.id ? 'active' : '']"
              type="button"
              @click="activeAgentId = agent.id"
            >
              <div class="agent-chip-main">
                <strong>{{ agent.label }}</strong>
                <span>{{ agent.role }}</span>
              </div>
              <div class="agent-chip-meta">
                <span>{{ agent.runtime }}</span>
                <span>{{ agent.model }}</span>
                <el-tag size="small" :type="agent.status === 'running' ? 'warning' : 'info'" effect="plain">
                  {{ agent.status === 'running' ? '运行中' : '空闲' }}
                </el-tag>
              </div>
            </button>
          </div>
        </section>

        <div class="run-bottom-grid">
          <section class="timeline-panel">
            <div class="timeline-panel-head">
              <div>
                <p class="eyebrow">Run Timeline</p>
                <h3>执行时间线</h3>
              </div>
              <div class="timeline-meta" v-if="state">
                <span>阶段: {{ state.runSnapshot?.phase ?? 'idle' }}</span>
                <span>角色: {{ state.runSnapshot?.activeRole ?? '-' }}</span>
                <el-button text :icon="View" @click="timelineDialogOpen = true">展开查看</el-button>
              </div>
            </div>

            <div ref="scroller" class="timeline-list timeline-scroll">
              <div
                v-for="message in timelineItems"
                :key="message.messageId"
                :class="['timeline-card', message.role]"
              >
                <div class="message-meta">
                  <span>{{ message.role }}</span>
                  <span>#{{ message.messageId }}</span>
                  <span>{{ formatTime(message.updatedAt) }}</span>
                </div>
                <template v-if="message.role === 'assistant' && message.parsed && message.hasStructuredBlocks">
                  <div class="timeline-split">
                    <section v-if="message.parsed.manager" class="timeline-block manager">
                      <h4>Manager</h4>
                      <pre>{{ message.parsed.manager }}</pre>
                    </section>
                    <section v-if="message.parsed.implementer" class="timeline-block implementer">
                      <h4>Implementer</h4>
                      <pre>{{ message.parsed.implementer }}</pre>
                    </section>
                    <section v-if="message.parsed.reviewer" class="timeline-block reviewer">
                      <h4>Reviewer</h4>
                      <pre>{{ message.parsed.reviewer }}</pre>
                    </section>
                  </div>
                </template>
                <pre v-else>{{ message.text }}</pre>
              </div>
              <el-empty v-if="timelineItems.length === 0" description="这里还没有 Team 任务" />
            </div>
          </section>

          <section class="timeline-panel agent-inspector">
            <div class="timeline-panel-head">
              <div>
                <p class="eyebrow">Agent Console</p>
                <h3>{{ selectedAgent?.label ?? '选择 Agent' }}</h3>
              </div>
              <div class="timeline-meta" v-if="selectedAgent">
                <span>{{ selectedAgent.runtime }}</span>
                <span>{{ selectedAgent.model }}</span>
              </div>
            </div>

            <div v-if="selectedAgent" class="agent-inspector-body">
              <div class="agent-console-actions">
                <el-button size="small" @click="emit('action', `reset-${selectedAgent.id}`)">
                  重置会话
                </el-button>
                <el-button size="small" :loading="sending" @click="emit('action', 'rerun-last')">
                  重跑上一轮
                </el-button>
              </div>

              <div class="agent-inspector-summary">
                <div>
                  <span class="agent-summary-label">角色</span>
                  <strong>{{ selectedAgent.role }}</strong>
                </div>
                <div>
                  <span class="agent-summary-label">状态</span>
                  <strong>{{ selectedAgent.status === 'running' ? '运行中' : '空闲' }}</strong>
                </div>
                <div>
                  <span class="agent-summary-label">会话</span>
                  <strong>{{ selectedAgent.sessionActive ? '已恢复' : '新会话' }}</strong>
                </div>
              </div>

              <div class="agent-inspector-section">
                <div class="agent-inspector-section-head">
                  <p class="eyebrow">最新活动</p>
                  <el-button text :icon="View" @click="activityDialogOpen = true">展开日志</el-button>
                </div>
                <div class="activity-spotlight">
                  <div class="activity-spotlight-meta">
                    <span>{{ selectedAgent.status === 'running' ? '实时输出' : '最近输出' }}</span>
                    <span>{{ latestAgentTool ? '工具优先展示' : latestAgentLog ? '日志展示' : '暂无活动' }}</span>
                  </div>
                  <pre v-if="latestAgentActivity">{{ latestAgentActivity }}</pre>
                  <p v-else>这个 Agent 还没有最新活动。</p>
                </div>
              </div>

              <div class="agent-inspector-section">
                <div class="agent-inspector-section-head">
                  <p class="eyebrow">Agent Timeline</p>
                  <span>{{ selectedAgentTimeline.length }} 条</span>
                </div>
                <div class="agent-inspector-scroll compact-scroll">
                  <div
                    v-for="item in selectedAgentTimeline.slice(0, 3)"
                    :key="`${selectedAgent.id}-${item.messageId}`"
                    class="agent-log-card"
                  >
                    <div class="message-meta">
                      <span>{{ selectedAgent.label }}</span>
                      <span>#{{ item.messageId }}</span>
                      <span>{{ formatTime(item.updatedAt) }}</span>
                    </div>
                    <pre>{{ item.text }}</pre>
                  </div>
                  <el-empty
                    v-if="selectedAgentTimeline.length === 0"
                    description="这个 Agent 还没有独立执行记录"
                  />
                </div>
              </div>

              <div class="agent-inspector-section two-column">
                <div class="agent-detail-block integrated">
                  <div class="agent-inspector-section-head">
                    <p class="eyebrow">完整日志</p>
                    <span>{{ selectedAgentLogs.length }} 条</span>
                  </div>
                  <div class="agent-inspector-scroll expanded">
                    <ul v-if="selectedAgentLogs.length > 0">
                      <li v-for="line in selectedAgentLogs" :key="line">{{ line }}</li>
                    </ul>
                    <p v-else>暂无日志</p>
                  </div>
                </div>
                <div class="agent-detail-block integrated">
                  <div class="agent-inspector-section-head">
                    <p class="eyebrow">工具活动</p>
                    <span>{{ selectedAgentTools.length }} 条</span>
                  </div>
                  <div class="agent-inspector-scroll expanded">
                    <ul v-if="selectedAgentTools.length > 0">
                      <li v-for="line in selectedAgentTools" :key="line">{{ line }}</li>
                    </ul>
                    <p v-else>暂无工具活动</p>
                  </div>
                </div>
              </div>
            </div>

            <el-empty v-else description="当前 Team 还没有可用 Agent" />
          </section>
        </div>
      </section>
    </main>

    <el-dialog v-model="createDialogOpen" title="新建 Team" width="420px">
      <div class="field">
        <label>Team Name</label>
        <el-input v-model="createName" placeholder="例如：Order Platform Team" @keydown.enter.prevent="createTeam" />
      </div>
      <template #footer>
        <el-button @click="createDialogOpen = false">取消</el-button>
        <el-button type="primary" @click="createTeam">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="settingsDialogOpen" title="Team 设置" width="640px">
      <div class="field">
        <label>Team Name</label>
        <div class="team-inline-actions">
          <el-input
            v-model="renameName"
            :disabled="!state"
            placeholder="Team 名称"
            @keydown.enter.prevent="emit('renameTeam', renameName)"
          />
          <el-button :disabled="!state" @click="emit('renameTeam', renameName)">保存</el-button>
        </div>
      </div>

      <div class="field">
        <label>添加工作目录</label>
        <div class="team-inline-actions">
          <el-input
            v-model="workdirInput"
            :disabled="!state"
            placeholder="输入服务目录绝对路径"
            @keydown.enter.prevent="submitWorkdir"
          />
          <el-button :disabled="!state" :icon="FolderAdd" @click="submitWorkdir">添加</el-button>
        </div>
      </div>

      <div class="workdir-list compact settings">
        <div v-for="workdir in state?.workdirs ?? []" :key="workdir.path" class="workdir-card compact">
          <div class="workdir-head">
            <div>
              <strong>{{ workdir.label }}</strong>
              <p class="mono-block compact">{{ workdir.path }}</p>
            </div>
            <el-tag :type="workdir.status === 'ready' ? 'success' : 'danger'" effect="plain">
              {{ workdir.status }}
            </el-tag>
          </div>
          <div class="workdir-actions compact">
            <el-button
              size="small"
              :icon="FolderChecked"
              :type="workdir.isPrimary ? 'primary' : 'default'"
              @click="emit('setPrimary', workdir.path)"
            >
              主目录
            </el-button>
            <el-button size="small" :icon="ArrowUp" @click="emit('moveWorkdir', workdir.path, 'up')" />
            <el-button size="small" :icon="ArrowDown" @click="emit('moveWorkdir', workdir.path, 'down')" />
            <el-button size="small" type="danger" :icon="Delete" @click="emit('removeWorkdir', workdir.path)" />
          </div>
        </div>
      </div>

      <template #footer>
        <el-button type="danger" :icon="Delete" @click="emit('deleteTeam')">删除 Team</el-button>
        <el-button @click="settingsDialogOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="runTaskDialogOpen" title="发送 Team 任务" width="760px">
      <div class="field">
        <label>Team Task</label>
        <el-input
          v-model="draft"
          type="textarea"
          :rows="10"
          resize="none"
          placeholder="输入 Team 任务，默认走 implementer + reviewer 双阶段。"
          @keydown.ctrl.enter.prevent="submitTask"
          @keydown.meta.enter.prevent="submitTask"
        />
      </div>
      <template #footer>
        <el-button @click="runTaskDialogOpen = false">取消</el-button>
        <el-button type="primary" :icon="Promotion" :loading="sending" @click="submitTask">
          发送任务
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="timelineDialogOpen" title="完整执行时间线" width="1100px" top="4vh">
      <div class="expanded-dialog-shell">
        <div class="expanded-dialog-head">
          <span>共 {{ timelineItems.length }} 条消息</span>
          <span>阶段: {{ state?.runSnapshot?.phase ?? 'idle' }}</span>
          <span>角色: {{ state?.runSnapshot?.activeRole ?? '-' }}</span>
        </div>
        <div class="expanded-dialog-scroll">
          <div
            v-for="message in timelineItems"
            :key="`dialog-${message.messageId}`"
            :class="['timeline-card', message.role]"
          >
            <div class="message-meta">
              <span>{{ message.role }}</span>
              <span>#{{ message.messageId }}</span>
              <span>{{ formatTime(message.updatedAt) }}</span>
            </div>
            <template v-if="message.role === 'assistant' && message.parsed && message.hasStructuredBlocks">
              <div class="timeline-split">
                <section v-if="message.parsed.manager" class="timeline-block manager">
                  <h4>Manager</h4>
                  <pre>{{ message.parsed.manager }}</pre>
                </section>
                <section v-if="message.parsed.implementer" class="timeline-block implementer">
                  <h4>Implementer</h4>
                  <pre>{{ message.parsed.implementer }}</pre>
                </section>
                <section v-if="message.parsed.reviewer" class="timeline-block reviewer">
                  <h4>Reviewer</h4>
                  <pre>{{ message.parsed.reviewer }}</pre>
                </section>
              </div>
            </template>
            <pre v-else>{{ message.text }}</pre>
          </div>
          <el-empty v-if="timelineItems.length === 0" description="这里还没有 Team 任务" />
        </div>
      </div>
    </el-dialog>

    <el-dialog
      v-model="activityDialogOpen"
      :title="`${selectedAgent?.label ?? 'Agent'} 最新活动`"
      width="960px"
      top="6vh"
    >
      <div class="expanded-dialog-shell">
        <div class="expanded-dialog-head">
          <span>{{ selectedAgent?.runtime ?? '-' }}</span>
          <span>{{ selectedAgent?.model ?? '-' }}</span>
          <span>{{ selectedAgentActivityFeed.length }} 条活动</span>
        </div>
        <div class="expanded-dialog-scroll activity-feed-scroll">
          <div
            v-for="(entry, index) in selectedAgentActivityFeed"
            :key="`${selectedAgent?.id ?? 'agent'}-${entry.kind}-${index}`"
            class="activity-feed-card"
          >
            <div class="message-meta">
              <span>{{ entry.kind }}</span>
              <span>{{ selectedAgent?.label ?? 'Agent' }}</span>
            </div>
            <pre>{{ entry.line }}</pre>
          </div>
          <el-empty v-if="selectedAgentActivityFeed.length === 0" description="当前没有可展开的日志或工具活动" />
        </div>
      </div>
    </el-dialog>
  </div>
</template>
