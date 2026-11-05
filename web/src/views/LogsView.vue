<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useConsole } from '../console';
import { errorMessage, isCancelled } from '../api';
import { formatLogEntry, logLevels, type LogBatch, type LogEntry } from '../../../src/logger/contracts';

const store = useConsole();
const entries = ref<LogEntry[]>([]), snapshot = ref<LogEntry[]>([]);
const query = ref(''), level = ref('all'), paused = ref(false), follow = ref(true);
const loading = ref(true), failure = ref(''), notice = ref(''), pending = ref(0), capacity = ref(1000);
const panel = ref<HTMLDivElement>();
let cursor: number | undefined, stream: string | undefined, busy = false, disposed = false;
let timer: ReturnType<typeof setInterval> | undefined;
const labels = { trace: '追踪', debug: '调试', info: '信息', warn: '警告', error: '错误', fatal: '致命' };
const items = computed(() => {
  const term = query.value.trim().toLocaleLowerCase();
  return (paused.value ? snapshot.value : entries.value).filter(entry =>
    (level.value === 'all' || entry.level === level.value) &&
    (!term || `${entry.message}\n${entry.scope}\n${entry.details || ''}`.toLocaleLowerCase().includes(term)));
});
async function refresh() {
  if (busy || disposed || document.hidden) return;
  busy = true;
  try {
    const params = new URLSearchParams();
    if (cursor !== undefined) params.set('after', String(cursor));
    if (stream) params.set('stream', stream);
    const batch = await store.api.request<LogBatch>(`/api/logs${params.size ? '?' + params : ''}`);
    if (disposed) return;
    if (batch.reset) {
      entries.value = [];
      notice.value = '服务已重启，正在显示本次运行的日志。';
    } else if (batch.truncated) notice.value = '部分较早日志已超出服务端保留范围。';
    const incoming = batch.entries.filter(entry => batch.reset || cursor === undefined || entry.id > cursor);
    if (incoming.length) entries.value = [...entries.value, ...incoming].slice(-batch.capacity);
    if (paused.value) pending.value += incoming.length;
    cursor = batch.cursor; stream = batch.streamId; capacity.value = batch.capacity;
    failure.value = '';
  } catch (error) {
    if (!disposed && !isCancelled(error)) failure.value = errorMessage(error);
  } finally { busy = false; loading.value = false; }
}
async function scrollToLatest() {
  await nextTick();
  if (panel.value) panel.value.scrollTop = panel.value.scrollHeight;
}
watch(items, () => { if (follow.value && !paused.value) void scrollToLatest(); });
function togglePause() {
  if (!paused.value) snapshot.value = [...entries.value];
  else { snapshot.value = []; pending.value = 0; }
  paused.value = !paused.value;
}
function toggleFollow() {
  follow.value = !follow.value;
  if (follow.value) void scrollToLatest();
}
function clearView() {
  entries.value = []; snapshot.value = []; pending.value = 0; notice.value = '';
}
function download() {
  const url = URL.createObjectURL(new Blob([items.value.map(formatLogEntry).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `melofox-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const visible = () => { if (!document.hidden) void refresh(); };
onMounted(() => {
  void refresh(); timer = setInterval(() => void refresh(), 1000);
  document.addEventListener('visibilitychange', visible);
});
onUnmounted(() => {
  disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible);
});
</script>
<template>
  <section id="logs-view" class="view">
    <article class="logs-card">
      <div class="logs-toolbar">
        <label class="log-search"><span class="sr-only">搜索日志</span><input id="log-search" v-model="query" type="search" placeholder="搜索消息、模块或错误详情" /></label>
        <label class="log-filter"><span class="sr-only">日志级别</span><select id="log-level" v-model="level"><option value="all">全部级别</option><option v-for="value in logLevels" :key="value" :value="value">{{ labels[value] }} · {{ value.toUpperCase() }}</option></select></label>
        <div class="log-actions">
          <button id="log-pause" class="secondary" :aria-pressed="paused" @click="togglePause">{{ paused ? `继续更新${pending ? ` (${pending})` : ''}` : '暂停更新' }}</button>
          <button id="log-download" class="secondary" :disabled="!items.length" @click="download">下载日志</button>
          <button id="log-clear" class="text-button" :disabled="loading" title="仅清空当前页面，不删除服务端日志" @click="clearView">清空视图</button>
        </div>
      </div>
      <div class="logs-status">
        <span class="log-live" :class="{ interrupted: failure, paused }"><i aria-hidden="true"></i>{{ failure ? '连接中断' : loading ? '正在加载' : paused ? '显示已暂停' : '实时更新' }}</span>
        <span>{{ items.length }} 条<span v-if="query || level !== 'all'">匹配</span> · 最多保留 {{ capacity }} 条</span>
        <button id="log-follow" class="text-button" :class="{ selected: follow }" :aria-pressed="follow" @click="toggleFollow">{{ follow ? '↓ 自动滚动' : '↓ 跟随最新' }}</button>
      </div>
      <p v-if="failure" class="log-notice error" role="alert">{{ failure }}，正在尝试重新连接。<button class="text-button" @click="refresh">立即重试</button></p>
      <p v-if="notice" class="log-notice" role="status">{{ notice }}</p>
      <div id="log-list" ref="panel" class="log-list-panel" role="region" aria-label="日志内容" tabindex="0" @wheel="follow = false" @touchmove="follow = false">
        <div v-for="item in items" :key="`${stream}-${item.id}`" class="log-entry" :data-level="item.level">
          <time class="log-time">{{ item.time }}</time>
          <span class="log-level" :title="labels[item.level]">{{ item.level.toUpperCase() }}</span>
          <span class="log-scope" :title="item.scope">{{ item.scope }}</span>
          <div class="log-content"><span class="log-message">{{ item.message }}</span><details v-if="item.details" class="log-details"><summary>详情</summary><pre>{{ item.details }}</pre></details></div>
        </div>
        <div v-if="!items.length" class="log-empty">{{ loading ? '正在加载日志…' : query || level !== 'all' ? '没有匹配的日志' : '等待新日志…' }}</div>
      </div>
    </article>
  </section>
</template>
<style scoped>
.logs-card { border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); overflow:hidden; }
.logs-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:20px; }
.logs-toolbar label { margin:0; }
.log-search { flex:1 1 260px; }
.log-filter { flex:0 1 170px; }
.logs-toolbar input, .logs-toolbar select { height:42px; font-size:var(--text-14); }
.log-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.log-actions .secondary { min-height:42px; padding:9px 14px; }
.logs-status { display:flex; flex-wrap:wrap; align-items:center; gap:12px 20px; padding:12px 20px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); color:var(--muted); font-size:var(--text-14); }
.log-live { display:inline-flex; gap:7px; align-items:center; color:var(--positive-text); }
.log-live i { width:6px; height:6px; background:currentColor; border-radius:50%; }
.log-live.paused { color:var(--warning-text); }
.log-live.interrupted { color:var(--error-text); }
.logs-status button { margin-left:auto; color:var(--muted); }
.logs-status button.selected { color:var(--accent); }
.log-notice { padding:10px 20px; background:var(--sand-bg); color:var(--warning-text); font-size:var(--text-14); }
.log-notice.error { background:color-mix(in srgb,var(--error-text) 7%,var(--surface)); color:var(--error-text); }
.log-notice button { margin-left:12px; }
.log-list-panel { height:65vh; min-height:320px; max-height:850px; overflow:auto; padding:10px 0; scrollbar-gutter:stable; background:color-mix(in srgb,var(--surface) 92%,var(--bg)); font-family:ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace; font-size:var(--text-14); line-height:1.8; }
.log-entry { display:grid; grid-template-columns:194px 56px 96px minmax(0,1fr); gap:8px 12px; align-items:baseline; padding:8px 20px; border-bottom:1px solid color-mix(in srgb,var(--line) 50%,transparent); }
.log-entry:hover { background:color-mix(in srgb,var(--accent) 4%,transparent); }
.log-time { color:var(--muted); font-size:13px; white-space:nowrap; font-variant-numeric:tabular-nums; }
.log-level { color:var(--positive-text); font-size:12px; font-weight:700; letter-spacing:.4px; }
.log-entry[data-level='trace'] .log-level, .log-entry[data-level='debug'] .log-level { color:var(--muted); }
.log-entry[data-level='warn'] .log-level, .log-entry[data-level='warn'] .log-message { color:var(--warning-text); }
.log-entry[data-level='error'] .log-level, .log-entry[data-level='fatal'] .log-level, .log-entry[data-level='error'] .log-message, .log-entry[data-level='fatal'] .log-message { color:var(--error-text); }
.log-scope { color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.log-content { min-width:0; overflow-wrap:anywhere; }
.log-message { white-space:pre-wrap; }
.log-details { margin-top:4px; }
.log-details summary { cursor:pointer; color:var(--muted); font-size:12px; width:fit-content; }
.log-details pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:10px 12px; border-left:2px solid var(--line); margin-top:6px; color:var(--secondary-text); font-family:inherit; font-size:13px; }
.log-empty { color:var(--muted); padding:64px 20px; text-align:center; }
@media (max-width:1100px) {
  .log-entry { grid-template-columns:194px 56px minmax(0,1fr); gap:2px 12px; }
  .log-content { grid-column:1 / -1; }
}
@media (max-width:760px) {
  .logs-toolbar { padding:16px; gap:10px; }
  .log-search { flex-basis:100%; }
  .log-filter { flex:1; }
  .log-actions { flex:1 1 100%; gap:10px; }
  .log-actions .secondary { padding:9px 10px; }
  .logs-status { padding:12px 16px; gap:8px 12px; }
  .logs-status > span:nth-child(2) { font-size:12px; }
  .log-entry { padding:10px 16px; grid-template-columns:minmax(0,1fr) auto; column-gap:8px; }
  .log-scope { grid-row:2; grid-column:1 / -1; }
  .log-time { font-size:12px; }
  .log-list-panel { height:65dvh; }
}
</style>
