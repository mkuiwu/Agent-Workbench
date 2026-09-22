<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { onBeforeUnmount, onMounted, ref } from "vue";

import MessagePane from "./components/MessagePane.vue";
import SkillDrawer from "./components/SkillDrawer.vue";
import StatusSidebar from "./components/StatusSidebar.vue";
import TeamWorkspace from "./components/TeamWorkspace.vue";
import { useChatStore } from "./stores/chat";
import { useTeamStore } from "./stores/team";

const store = useChatStore();
const teamStore = useTeamStore();
const drawerOpen = ref(false);
const view = ref<"console" | "team">("console");

async function safeRun(task: () => Promise<void>, successText?: string): Promise<void> {
  try {
    await task();
    if (successText) {
      ElMessage.success(successText);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function deleteCurrentTeam(): Promise<void> {
  if (!teamStore.state) {
    return;
  }
  try {
    await ElMessageBox.confirm(
      `删除 Team「${teamStore.state.name}」后，关联工作目录配置、消息历史和会话恢复信息都会被移除。`,
      "删除 Team",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }

  await safeRun(() => teamStore.remove(), "Team 已删除");
}

onMounted(async () => {
  await safeRun(() => store.switchChat(store.chatId));
  await safeRun(() => teamStore.bootstrap());
});

onBeforeUnmount(() => {
  store.disconnect();
  teamStore.disconnect();
});
</script>

<template>
  <div class="view-switcher">
    <el-segmented
      v-model="view"
      :options="[
        { label: 'Console', value: 'console' },
        { label: 'Team Workspace', value: 'team' },
      ]"
    />
  </div>

  <div v-if="view === 'console'" class="app-shell">
    <StatusSidebar
      :state="store.state"
      :loading="store.loading"
      :connected="store.connected"
      :chat-id="store.chatId"
      @refresh="safeRun(() => store.refresh(), '状态已刷新')"
      @project="(path) => safeRun(() => store.changeProject(path), '项目已切换')"
      @action="(name) => safeRun(() => store.action(name))"
      @skill="drawerOpen = true"
      @update:chat-id="(value) => safeRun(() => store.switchChat(value), '已切换会话')"
    />

    <main class="workspace">
      <MessagePane
        :messages="store.state?.messages ?? []"
        :pending-skill="store.state?.pendingSkill ?? null"
        :running="store.state?.running ?? false"
        :sending="store.sending"
        @send="(text) => safeRun(() => store.send(text))"
      />
    </main>

    <SkillDrawer
      v-model="drawerOpen"
      :skills="store.state?.skills ?? []"
      :pending-skill="store.state?.pendingSkill ?? null"
      @select="
        (skillName) =>
          safeRun(() => store.changeSkill(skillName), skillName ? '技能已选择' : '技能已取消').then(() => {
            drawerOpen = false;
          })
      "
    />
  </div>

  <TeamWorkspace
    v-else
    :teams="teamStore.teams"
    :state="teamStore.state"
    :loading="teamStore.loading"
    :sending="teamStore.sending"
    :connected="teamStore.connected"
    @select-team="(id) => safeRun(() => teamStore.selectTeam(id), '已切换 Team')"
    @create-team="(name) => safeRun(() => teamStore.create(name), 'Team 已创建')"
    @rename-team="(name) => safeRun(() => teamStore.rename(name), 'Team 已重命名')"
    @delete-team="deleteCurrentTeam"
    @refresh="safeRun(() => teamStore.refresh(), 'Team 状态已刷新')"
    @add-workdir="(path) => safeRun(() => teamStore.addWorkdir(path), '工作目录已添加')"
    @remove-workdir="(path) => safeRun(() => teamStore.removeWorkdir(path), '工作目录已移除')"
    @set-primary="(path) => safeRun(() => teamStore.setPrimary(path), '主目录已更新')"
    @move-workdir="(path, direction) => safeRun(() => teamStore.moveWorkdir(path, direction), '工作目录顺序已更新')"
    @send="(text) => safeRun(() => teamStore.send(text))"
    @action="(action) => safeRun(() => teamStore.action(action))"
  />
</template>
