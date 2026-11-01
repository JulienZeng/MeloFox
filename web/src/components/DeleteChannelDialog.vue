<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useConsole } from "../console";
import { errorMessage, isCancelled } from "../api";
import type { ConsoleChannel } from "../types";
const props = defineProps<{ channel: ConsoleChannel }>();
const store = useConsole(),
  dialog = ref<HTMLDialogElement>(),
  busy = ref(false);
onMounted(() => dialog.value?.showModal());
onUnmounted(() => dialog.value?.close());
function close() {
  if (store.state.deleting === props.channel) store.state.deleting = undefined;
}
async function remove() {
  if (busy.value) return;
  busy.value = true;
  try {
    await store.api.request(`/api/channels/${props.channel.id}`, {
      method: "DELETE",
    });
    close();
    await store.refresh();
    store.toast("通道已删除");
  } catch (error) {
    if (!isCancelled(error)) store.toast(errorMessage(error), true);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <dialog id="delete-dialog" ref="dialog" @close="close" @cancel="close">
    <div class="dialog-heading"><h2>删除这个通道？</h2></div>
    <p class="muted">
      通道「{{
        channel.name
      }}」的连接将关闭。如需暂时停止连接，可以使用停用开关。
    </p>
    <div class="dialog-footer">
      <button id="cancel-delete" class="secondary" @click="close">
        保留通道</button
      ><button
        id="confirm-delete"
        class="danger"
        :disabled="busy"
        @click="remove"
      >
        {{ busy ? "删除中…" : "删除通道" }}
      </button>
    </div>
  </dialog>
</template>
