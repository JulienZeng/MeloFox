<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useConsole } from "../console";
import { errorMessage, isCancelled } from "../api";
const store = useConsole(),
  dialog = ref<HTMLDialogElement>(),
  image = ref<HTMLImageElement>();
const text = ref(""),
  src = ref(""),
  busy = ref(true),
  error = ref("");
let disposed = false,
  started = false,
  pointer: { x: number; y: number } | undefined;
function close() {
  store.state.assist = false;
}
function refresh() {
  if (!disposed && started)
    src.value = `/api/douyin/assist/image?t=${Date.now()}`;
}
const cleanup = () =>
  store.api
    .request("/api/douyin/assist", { method: "DELETE" })
    .catch(() => undefined);
onMounted(async () => {
  dialog.value?.showModal();
  try {
    await store.api.request("/api/douyin/assist", { method: "POST" });
    started = true;
    if (disposed) await cleanup();
    else refresh();
  } catch (failure) {
    if (!disposed && !isCancelled(failure)) error.value = errorMessage(failure);
  } finally {
    busy.value = false;
  }
});
onUnmounted(() => {
  disposed = true;
  text.value = "";
  src.value = "";
  dialog.value?.close();
  if (started) void cleanup();
});
async function input(body: object) {
  if (busy.value || !started) return;
  busy.value = true;
  error.value = "";
  try {
    await store.api.request("/api/douyin/assist/input", {
      method: "POST",
      body: JSON.stringify(body),
    });
    refresh();
  } catch (failure) {
    if (!disposed && !isCancelled(failure)) error.value = errorMessage(failure);
  } finally {
    busy.value = false;
  }
}
function typeText() {
  const value = text.value;
  text.value = "";
  void input({ type: "text", text: value });
}
function coordinates(event: PointerEvent) {
  const rect = image.value!.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(999, ((event.clientX - rect.left) * 1000) / rect.width),
    ),
    y: Math.max(
      0,
      Math.min(759, ((event.clientY - rect.top) * 760) / rect.height),
    ),
  };
}
function down(event: PointerEvent) {
  if (busy.value) return;
  pointer = coordinates(event);
  image.value?.setPointerCapture(event.pointerId);
}
function up(event: PointerEvent) {
  if (!pointer) return;
  const start = pointer,
    end = coordinates(event);
  pointer = undefined;
  void input(
    Math.hypot(start.x - end.x, start.y - end.y) > 8
      ? { type: "drag", ...start, toX: end.x, toY: end.y }
      : { type: "click", ...end },
  );
}
async function complete() {
  if (busy.value || !started) return;
  busy.value = true;
  try {
    await store.api.request("/api/douyin/assist/complete", { method: "POST" });
    close();
    store.toast("已保存登录，正在重连");
    await store.refresh();
  } catch (failure) {
    if (!disposed && !isCancelled(failure)) error.value = errorMessage(failure);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <dialog id="assist-dialog" ref="dialog" @close="close" @cancel="close">
    <h2>官方页面辅助验证</h2>
    <p>
      点击下方画面操作抖音官方页面。需要时输入验证码或拖动滑块；画面仅在操作和手动刷新时更新。请在官方页面完成登录与保存确认后点击“保存登录”。
    </p>
    <p class="error-text" role="alert">{{ error }}</p>
    <img
      id="assist-image"
      ref="image"
      :src="src || undefined"
      alt="抖音官方验证页面"
      draggable="false"
      @pointerdown="down"
      @pointerup="up"
      @pointercancel="pointer = undefined"
      @error="error = '无法获取验证画面，请刷新或重新打开辅助验证'"
    /><label for="assist-text">输入到当前选中的官方输入框</label
    ><input
      id="assist-text"
      v-model="text"
      type="password"
      autocomplete="off"
      maxlength="256"
    />
    <div class="assist-toolbar">
      <button
        id="assist-type"
        type="button"
        :disabled="busy || !started"
        @click="typeText"
      >
        输入</button
      ><button
        id="assist-enter"
        type="button"
        :disabled="busy || !started"
        @click="input({ type: 'key', key: 'Enter' })"
      >
        回车</button
      ><button
        id="assist-backspace"
        type="button"
        :disabled="busy || !started"
        @click="input({ type: 'key', key: 'Backspace' })"
      >
        退格</button
      ><button
        id="assist-refresh"
        type="button"
        :disabled="busy || !started"
        @click="refresh"
      >
        刷新画面</button
      ><button
        id="assist-complete"
        type="button"
        :disabled="busy || !started"
        @click="complete"
      >
        保存登录</button
      ><button id="assist-close" type="button" @click="close">关闭</button>
    </div>
  </dialog>
</template>
