<script setup lang="ts">
import { useConsole } from "../console";
const { state } = useConsole();
const time = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
</script>
<template>
  <section id="activity-view" class="view">
    <article class="activity-card">
      <div class="section-heading">
        <div>
          <span class="small-label">ACTIVITY LOG</span>
          <h2>运行记录</h2>
        </div>
        <span class="subtle-pill">本次运行</span>
      </div>
      <div id="activity-list">
        <div
          v-for="(item, index) in state.data?.activity"
          :key="`${item.time}-${index}`"
          class="activity-row"
        >
          <span class="dot"></span><time>{{ time(item.time) }}</time
          ><span>{{ item.message }}</span>
        </div>
        <div v-if="!state.data?.activity.length" class="empty-mini">
          <p>暂无运行记录</p>
        </div>
      </div>
      <p class="field-hint">最多保留本次运行的 50 条记录。</p>
    </article>
  </section>
</template>
