<script setup lang="ts">
import { computed, ref } from "vue";
import { useConsole } from "../console";
const { state } = useConsole();
const query = ref(''), paused = ref(false), snapshot = ref<Array<{ time: string; message: string }>>([]);
const items = computed(() => (paused.value ? snapshot.value : state.data?.activity || []).filter(item => item.message.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
function togglePause() {
  if (!paused.value) snapshot.value = (state.data?.activity || []).map(item => ({ ...item }));
  paused.value = !paused.value;
}
const time = (value: string) => new Date(value).toLocaleString('zh-CN', { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit' });
</script>
<template>
  <section id="activity-view" class="view">
    <article class="activity-card">
      <div class="log-toolbar"><label class="search-field"><span class="sr-only">搜索运行记录</span><input id="activity-search" v-model="query" type="search" placeholder="搜索记录" /></label><button id="activity-pause" class="secondary" :aria-pressed="paused" @click="togglePause">{{ paused ? '继续更新' : '暂停更新' }}</button><span class="muted">{{ items.length }} 条</span></div>
      <div id="activity-list" class="log-list"><div v-for="(item, index) in items" :key="`${item.time}-${index}`" class="activity-row"><time>{{ time(item.time) }}</time><span>{{ item.message }}</span></div><div v-if="!items.length" class="empty-mini"><p>{{ query ? '没有匹配记录' : '暂无运行记录' }}</p></div></div>
      <p class="field-hint">{{ paused ? '已暂停显示更新。' : '' }}保留本次运行最近 50 条记录。</p>
    </article>
  </section>
</template>
