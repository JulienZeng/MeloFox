<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useConsole } from "../console";
import { errorMessage, isCancelled } from "../api";
const store = useConsole(),
  { state } = store;
const code = ref(""),
  now = ref(Date.now()),
  reconnecting = ref(false);
const timer = setInterval(() => {
  now.value = Date.now();
}, 1000);
onUnmounted(() => clearInterval(timer));
const labels = {
  waiting: "等待扫码",
  scanned: "已扫码，等待手机确认",
  confirmed: "正在确认登录",
  verifying: "需要身份验证",
  choose_trust: "选择保存方式",
  saved: "登录配置已保存",
  expired: "二维码已过期",
  refused: "已取消登录",
  error: "登录未完成",
};
const account = computed(() => state.data!.account);
const login = computed(() => state.login);
const verifying = computed(
  () =>
    login.value?.state === "verifying" &&
    login.value.verification?.smsAvailable,
);
const seconds = computed(() =>
  Math.max(
    0,
    Math.ceil(((login.value?.verification?.resendAt || 0) - now.value) / 1000),
  ),
);
const showQr = computed(
  () => !!login.value && ["waiting", "scanned"].includes(login.value.state),
);
const accountStatus = computed(() =>
  state.connectionError
    ? "连接中断 · 状态待更新"
    : account.value.loggedIn
      ? account.value.online
        ? "在线"
        : "已登录 · 等待消息连接"
      : state.data?.browser === "ready"
        ? "等待扫码"
        : "浏览器启动中",
);
watch([() => login.value?.id, () => login.value?.state], () => {
  code.value = "";
});
function verify() {
  const value = code.value;
  code.value = "";
  void store.loginStep("verify", { code: value });
}
async function reconnect() {
  if (reconnecting.value) return;
  reconnecting.value = true;
  try {
    await store.api.request("/api/douyin/reconnect", { method: "POST" });
    store.toast("正在重建会话");
    await store.refresh();
  } catch (error) {
    if (!isCancelled(error)) store.toast(errorMessage(error), true);
  } finally {
    reconnecting.value = false;
  }
}
</script>
<template>
  <section id="account-view" class="view">
    <article class="account-detail">
      <div class="section-heading">
        <div>
          <span class="small-label">ACCOUNT CONNECTION</span>
          <h2>抖音账号登录</h2>
        </div>
        <span id="account-status" class="subtle-pill">{{ accountStatus }}</span>
      </div>
      <div id="logged-in" :hidden="!account.loggedIn">
        <div class="success-mark">✓</div>
        <h2>账号已登录</h2>
        <p id="account-id" class="muted">抖音账号 ID · {{ account.id }}</p>
        <p class="muted">登录凭据已保存到服务端配置目录，下次启动自动恢复。</p>
        <button class="primary new-channel" @click="store.openChannel()">
          创建连接通道 →
        </button>
      </div>
      <div
        id="login-panel"
        :hidden="
          account.loggedIn &&
          !['verifying', 'choose_trust'].includes(login?.state || '')
        "
      >
        <div class="login-instructions">
          <div>
            <h3>扫码登录抖音</h3>
            <p class="muted">
              点击获取二维码，使用抖音 App
              扫码并在手机上确认，按提示完成验证及保存选择后连接消息服务。
            </p>
          </div>
          <button
            id="open-douyin"
            class="primary"
            :disabled="state.loginBusy"
            @click="store.loginAction('/api/douyin/login')"
          >
            {{ login ? "刷新登录二维码" : "获取登录二维码" }}
          </button>
        </div>
        <div class="qr-login-card">
          <div
            class="qr-code-wrap"
            :hidden="
              ['verifying', 'choose_trust', 'confirmed', 'saved'].includes(
                login?.state || '',
              )
            "
          >
            <img
              id="login-qrcode"
              :src="showQr ? `/api/douyin/login/${login!.id}/qr` : undefined"
              alt="抖音登录二维码"
              :hidden="!showQr"
            />
            <div id="qr-placeholder" :hidden="showQr">
              <span>▦</span>
              <p>点击获取二维码</p>
            </div>
          </div>
          <div class="qr-login-copy">
            <h3 id="qr-state-title">
              {{ login ? labels[login.state] : "等待获取二维码" }}
            </h3>
            <p id="qr-state-message" class="muted">
              {{ login?.message || "二维码由抖音官方登录接口提供。" }}
            </p>
            <p id="qr-expiry" class="field-hint">
              {{
                showQr
                  ? `二维码有效期至 ${new Date(login!.expiresAt).toLocaleTimeString("zh-CN")}`
                  : ""
              }}
            </p>
            <p id="douyin-login-error" class="error-text" role="alert">
              {{ state.loginError }}
            </p>
            <form
              id="verify-form"
              :hidden="!verifying"
              @submit.prevent="verify"
            >
              <p class="field-hint">
                点击发送短信，再输入抖音绑定手机收到的验证码。
              </p>
              <button
                id="send-verify-code"
                type="button"
                class="secondary"
                :disabled="state.loginBusy || seconds > 0"
                @click="store.loginStep('sms')"
              >
                {{
                  seconds ? `${seconds} 秒后可重发` : "发送短信验证码"
                }}</button
              ><label for="verify-code">短信验证码</label
              ><input
                id="verify-code"
                v-model="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                pattern="[0-9]{4,8}"
                minlength="4"
                maxlength="8"
                required
              /><button
                id="submit-verify-code"
                type="submit"
                class="primary"
                :disabled="state.loginBusy"
              >
                验证并继续登录
              </button>
            </form>
            <div id="trust-choice" :hidden="login?.state !== 'choose_trust'">
              <p class="field-hint">
                是否在抖音保存快捷登录信息？两种选择都会保存本网关会话，退出抖音登录后清除。
              </p>
              <button
                id="trust-save"
                type="button"
                class="primary"
                :disabled="state.loginBusy"
                @click="store.loginStep('trust', { save: true })"
              >
                保存快捷登录</button
              ><button
                id="trust-skip"
                type="button"
                class="secondary"
                :disabled="state.loginBusy"
                @click="store.loginStep('trust', { save: false })"
              >
                不保存快捷登录
              </button>
            </div>
            <button
              id="check-login"
              class="secondary"
              :hidden="
                !login ||
                !['waiting', 'scanned', 'confirmed'].includes(login.state)
              "
              :disabled="state.loginBusy"
              @click="store.pollLogin(true)"
            >
              检查登录状态
            </button>
          </div>
        </div>
      </div>
      <div class="account-footer">
        <span class="muted"
          >浏览器异常或消息连接中断时，可重建会话并复用已保存的登录态。</span
        ><button
          id="reconnect"
          class="text-button"
          :disabled="reconnecting"
          @click="reconnect"
        >
          重连会话 ↻</button
        ><button
          id="login-assist"
          class="secondary"
          :disabled="state.loginBusy"
          @click="
            state.assist = true;
            state.pollStopped = true;
          "
        >
          官方页面辅助验证</button
        ><button
          id="douyin-logout"
          class="secondary"
          :disabled="state.loginBusy"
          @click="store.logoutDouyin"
        >
          退出抖音登录
        </button>
      </div>
    </article>
  </section>
</template>
