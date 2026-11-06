<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useConsole } from '../console';
import { ApiError, errorMessage, isCancelled } from '../api';
import { isServiceHealth, waitForServiceRestart } from '../service-restart';

const store = useConsole(), dialog = ref<HTMLDialogElement>();
const phase = ref<'confirm' | 'requesting' | 'waiting' | 'failed'>('confirm');
const error = ref(''), sent = ref(false);
const lifetime = new AbortController();
let previousId = '';
const busy = () => phase.value === 'requesting' || phase.value === 'waiting';
onMounted(() => dialog.value?.showModal());
onUnmounted(() => { lifetime.abort(); dialog.value?.close(); });
function close() {
  if (busy() || sent.value) return;
  store.state.restarting = false;
  store.state.restartDialog = false;
}
async function reconnect() {
  phase.value = 'waiting'; error.value = '';
  try {
    await waitForServiceRestart(previousId, lifetime.signal);
    window.location.reload();
  } catch (failure) {
    if (!lifetime.signal.aborted) { error.value = errorMessage(failure); phase.value = 'failed'; }
  }
}
async function restart() {
  if (busy() || sent.value) return;
  phase.value = 'requesting'; error.value = '';
  store.prepareServiceRestart();
  try {
    const health = await store.api.request<unknown>('/healthz', { cache: 'no-store' });
    if (!isServiceHealth(health)) throw new Error('无法确认服务状态，请刷新页面后重试');
    previousId = health.instanceId;
    try {
      await store.api.request('/api/service/restart', { method: 'POST' });
    } catch (failure) {
      if (!store.state.authenticated) throw new Error('登录已失效，请重新登录管理台');
      if (failure instanceof ApiError || isCancelled(failure)) throw failure;
      // The server may have accepted the command before the connection dropped.
      // Observe the new instance instead of sending another restart command.
    }
    sent.value = true;
    await reconnect();
  } catch (failure) {
    if (!lifetime.signal.aborted) {
      error.value = errorMessage(failure);
      phase.value = 'failed';
      store.state.restarting = false;
    }
  }
}
function reload() { window.location.reload(); }
</script>
<template>
  <dialog id="restart-dialog" ref="dialog" aria-labelledby="restart-title" @cancel.prevent="close">
    <div class="dialog-heading"><h2 id="restart-title">{{ busy() ? '正在重启服务' : sent ? '等待服务恢复' : '重启 MeloFox？' }}</h2></div>
    <p v-if="!sent && !busy()" class="muted">服务将短暂中断，并加载已保存的设置。重启后需重新登录管理台，已保存的抖音登录状态将保留。</p>
    <p v-else class="muted" role="status">{{ phase === 'requesting' ? '正在提交重启请求…' : '正在等待服务重新连接，恢复后自动返回登录页。' }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="dialog-footer">
      <template v-if="!sent && !busy()">
        <button class="secondary" @click="close">取消</button>
        <button class="primary" @click="restart">确认重启</button>
      </template>
      <template v-else-if="phase === 'failed'">
        <button class="secondary" @click="reload">刷新页面</button>
        <button class="primary" @click="reconnect">继续等待</button>
      </template>
      <button v-else class="primary" disabled>重启中…</button>
    </div>
  </dialog>
</template>
