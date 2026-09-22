<script setup lang="ts">
import { Search } from "@element-plus/icons-vue";
import { computed, ref } from "vue";

import type { SkillEntry } from "../types";

const props = defineProps<{
  modelValue: boolean;
  skills: SkillEntry[];
  pendingSkill: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  select: [skillName: string | null];
}>();

const keyword = ref("");

const filteredSkills = computed(() => {
  const value = keyword.value.trim().toLowerCase();
  if (!value) {
    return props.skills;
  }
  return props.skills.filter((skill) => {
    return (
      skill.name.toLowerCase().includes(value) ||
      skill.description.toLowerCase().includes(value) ||
      skill.displayPath.toLowerCase().includes(value)
    );
  });
});
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    size="520px"
    title="选择技能"
    @update:model-value="(value: boolean) => emit('update:modelValue', value)"
  >
    <div class="drawer-toolbar">
      <el-input v-model="keyword" :prefix-icon="Search" placeholder="搜索技能" clearable />
      <el-button v-if="pendingSkill" @click="emit('select', null)">取消待命技能</el-button>
    </div>

    <div class="skill-list">
      <el-card
        v-for="skill in filteredSkills"
        :key="skill.name"
        shadow="hover"
        class="skill-card"
        @click="emit('select', skill.name)"
      >
        <div class="skill-head">
          <strong>{{ skill.name }}</strong>
          <el-tag v-if="pendingSkill === skill.name" type="success">已选中</el-tag>
        </div>
        <p>{{ skill.description }}</p>
        <code>{{ skill.displayPath }}</code>
      </el-card>
      <el-empty v-if="filteredSkills.length === 0" description="没有匹配的技能" />
    </div>
  </el-drawer>
</template>
