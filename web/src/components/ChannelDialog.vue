<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useConsole } from "../console";
import { errorMessage, isCancelled } from "../api";
import type { ChannelInput } from "../types";
const props = defineProps<{
  editor: { id?: string; initial?: ChannelInput };
}>();
const store = useConsole(),
  dialog = ref<HTMLDialogElement>(),
  saving = ref(false),
  error = ref("");
const form = reactive<ChannelInput>({
  name: "",
  type: "reverse-ws",
  enabled: true,
  host: "127.0.0.1",
  port: 3002,
  url: "ws://127.0.0.1:6700/onebot/v11/ws",
  secret: "",
  timeoutMs: 10000,
  accessToken: "",
  publicBaseUrl: "",
  ...props.editor.initial,
});
const reverse = computed(() => form.type.startsWith("reverse-"));
const hints = {
  http: "提供 OneBot HTTP API 和媒体下载服务。",
  "forward-ws": "本服务监听端口，机器人应用主动连入。",
  "reverse-ws": "本服务主动连接应用；适用于 AstrBot 的反向 WebSocket 接入。",
  "reverse-http":
    "向应用上报事件，支持签名、离线重试和快速回复。媒体下载需另配 HTTP 通道。",
};
let mounted = true;
onMounted(() => dialog.value?.showModal());
onUnmounted(() => {
  mounted = false;
  dialog.value?.close();
});
function close() {
  if (store.state.editor === props.editor) store.state.editor = undefined;
}
watch(
  () => form.type,
  (type) => {
    if (
      type === "reverse-http" &&
      form.url === "ws://127.0.0.1:6700/onebot/v11/ws"
    )
      form.url = "http://127.0.0.1:5701";
    else if (type === "reverse-ws" && form.url === "http://127.0.0.1:5701")
      form.url = "ws://127.0.0.1:6700/onebot/v11/ws";
    if (!props.editor.id) form.port = type === "http" ? 3001 : 3002;
  },
);
async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await store.api.request(
      `/api/channels${props.editor.id ? `/${props.editor.id}` : ""}`,
      {
        method: props.editor.id ? "PUT" : "POST",
        body: JSON.stringify({
          ...form,
          url: reverse.value ? form.url : "",
          publicBaseUrl: form.type === "http" ? form.publicBaseUrl : "",
        }),
      },
    );
    if (mounted) close();
    // Saving never changes the user's route or closes a newer editor.
    await store.refresh();
    store.toast("通道配置已保存");
  } catch (failure) {
    if (!isCancelled(failure)) {
      if (mounted) error.value = errorMessage(failure);
      else store.toast(errorMessage(failure), true);
    }
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <dialog id="channel-dialog" ref="dialog" @close="close" @cancel="close">
    <form id="channel-form" @submit.prevent="save">
      <div class="dialog-heading">
        <div>
          <span class="small-label">{{
            editor.id ? "EDIT CONNECTION" : "NEW CONNECTION"
          }}</span>
          <h2 id="dialog-title">
            {{ editor.id ? "编辑连接通道" : "创建连接通道" }}
          </h2>
        </div>
        <button
          id="close-dialog"
          type="button"
          class="icon-button"
          aria-label="关闭"
          @click="close"
        >
          ✕
        </button>
      </div>
      <p class="muted">选择连接方式，接入你的机器人应用。</p>
      <label for="channel-name">通道名称</label
      ><input
        id="channel-name"
        v-model="form.name"
        name="name"
        required
        maxlength="60"
        placeholder="例如：AstrBot 主连接"
        :disabled="saving"
      />
      <label for="channel-type">连接方式</label
      ><select
        id="channel-type"
        v-model="form.type"
        name="type"
        :disabled="saving"
      >
        <option value="reverse-ws">反向 WebSocket · 主动连接应用</option>
        <option value="forward-ws">正向 WebSocket · 等待应用连接</option>
        <option value="reverse-http">反向 HTTP · 上报事件</option>
        <option value="http">HTTP · 接口与媒体服务</option>
      </select>
      <p id="type-hint" class="field-hint">{{ hints[form.type] }}</p>
      <div id="url-fields" :hidden="!reverse">
        <label for="channel-url">应用接收地址</label
        ><input
          id="channel-url"
          v-model="form.url"
          name="url"
          type="url"
          :required="reverse"
          :disabled="!reverse || saving"
          :placeholder="
            form.type === 'reverse-http'
              ? 'http://127.0.0.1:5701'
              : 'ws://127.0.0.1:6700/onebot/v11/ws'
          "
        />
      </div>
      <div id="http-push-fields" :hidden="form.type !== 'reverse-http'">
        <label for="channel-secret"
          >签名密钥 <span class="optional">可选</span></label
        ><input
          id="channel-secret"
          v-model="form.secret"
          name="secret"
          type="password"
          autocomplete="new-password"
          maxlength="512"
          :disabled="form.type !== 'reverse-http' || saving"
        /><label for="channel-timeout">上报超时（毫秒）</label
        ><input
          id="channel-timeout"
          v-model.number="form.timeoutMs"
          name="timeoutMs"
          type="number"
          min="100"
          max="60000"
          required
          :disabled="form.type !== 'reverse-http' || saving"
        />
      </div>
      <div id="listener-fields" :hidden="reverse">
        <div class="form-grid">
          <div>
            <label for="channel-host">监听地址</label
            ><input
              id="channel-host"
              v-model="form.host"
              name="host"
              required
              :disabled="reverse || saving"
            />
          </div>
          <div>
            <label for="channel-port">监听端口</label
            ><input
              id="channel-port"
              v-model.number="form.port"
              name="port"
              type="number"
              min="1"
              max="65535"
              required
              :disabled="reverse || saving"
            />
          </div>
        </div>
        <p class="field-hint">
          127.0.0.1 仅本机访问；0.0.0.0 允许其他设备连接。
        </p>
      </div>
      <div id="media-fields" :hidden="form.type !== 'http'">
        <label for="channel-public-url"
          >媒体公开地址 <span class="optional">可选</span></label
        ><input
          id="channel-public-url"
          v-model="form.publicBaseUrl"
          name="publicBaseUrl"
          type="url"
          placeholder="http://你的服务器:3001"
          :disabled="form.type !== 'http' || saving"
        />
        <p class="field-hint">
          填写机器人可访问的 HTTP 地址；Docker 部署需映射相应端口。
        </p>
      </div>
      <div id="channel-token-fields" :hidden="form.type === 'reverse-http'">
        <label for="channel-token"
          >Access Token <span class="optional">可选</span></label
        ><input
          id="channel-token"
          v-model="form.accessToken"
          name="accessToken"
          type="password"
          autocomplete="new-password"
          maxlength="512"
          placeholder="与机器人应用中配置的令牌保持一致"
          :disabled="form.type === 'reverse-http' || saving"
        />
      </div>
      <label class="checkbox-label"
        ><input
          v-model="form.enabled"
          name="enabled"
          type="checkbox"
          :disabled="saving"
        /><span>保存后启用通道</span></label
      >
      <p id="channel-error" class="error-text" role="alert">{{ error }}</p>
      <div class="dialog-footer">
        <button
          id="cancel-dialog"
          type="button"
          class="secondary"
          @click="close"
        >
          {{ saving ? "关闭" : "取消" }}</button
        ><button
          id="save-channel"
          type="submit"
          class="primary"
          :disabled="saving"
        >
          {{ saving ? "保存中…" : editor.id ? "保存配置 →" : "创建通道 →" }}
        </button>
      </div>
    </form>
  </dialog>
</template>
