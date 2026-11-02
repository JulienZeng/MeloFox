<script setup lang="ts">
import { computed } from "vue";
const props = defineProps<{ value: number | null; label: string }>();
const value = computed(() => props.value !== null && Number.isFinite(props.value) ? Math.max(0, Math.min(100, props.value)) : null);
</script>
<template>
  <div class="usage-ring" role="img" :aria-label="label + '：' + (value === null ? '暂无数据' : value.toFixed(1) + '%')">
    <svg viewBox="0 0 108 108" aria-hidden="true">
      <circle class="usage-track" cx="54" cy="54" r="46" />
      <circle v-if="value !== null" class="usage-fill" cx="54" cy="54" r="46" pathLength="100" :stroke-dasharray="value + ' 100'" transform="rotate(-90 54 54)" />
    </svg>
    <div><span>{{ label }}</span><strong>{{ value === null ? '—' : value.toFixed(1) }}<small v-if="value !== null">%</small></strong></div>
  </div>
</template>
<style scoped>
.usage-ring { position:relative; width:152px; height:152px; flex-shrink:0; }
svg { width:100%; height:100%; overflow:visible; }
circle { fill:none; stroke-width:8; }
.usage-track { stroke:var(--surface-soft); }
.usage-fill { stroke:var(--accent); stroke-linecap:round; transition:stroke-dasharray .35s ease; }
.usage-ring > div { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px; }
span { color:var(--muted); font-size:var(--text-14); }
strong { color:var(--ink); font-size:var(--text-28); line-height:1.1; font-variant-numeric:tabular-nums; }
small { font-size:var(--text-14); margin-left:2px; color:var(--muted); font-weight:400; }
@media (prefers-reduced-motion:reduce) { .usage-fill { transition:none; } }
@media (max-width:480px) { .usage-ring { width:120px; height:120px; } strong { font-size:var(--text-24); } }
</style>
