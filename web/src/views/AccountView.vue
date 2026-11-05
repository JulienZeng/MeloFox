<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useConsole } from "../console";
import { errorMessage, isCancelled } from "../api";
import AccountAvatar from "../components/AccountAvatar.vue";

const store = useConsole(), { state } = store;
const code = ref(""), now = ref(Date.now()), reconnecting = ref(false), qrFailed = ref(false), creatingQr = ref(false);
const timer = setInterval(() => { now.value = Date.now(); }, 1000);
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
const steps = [
  { title: "扫码确认", description: "使用抖音 App 扫码，在手机上确认" },
  { title: "安全验证", description: "如有提示，完成短信二次验证" },
  { title: "保存登录", description: "选择快捷登录方式，完成连接" },
];
const account = computed(() => state.data!.account);
const login = computed(() => state.login);
const connected = computed(() => account.value.loggedIn && !["verifying", "choose_trust"].includes(login.value?.state || ""));
const verifying = computed(() => login.value?.state === "verifying" && login.value.verification?.smsAvailable);
const seconds = computed(() => Math.max(0, Math.ceil(((login.value?.verification?.resendAt || 0) - now.value) / 1000)));
const qrStage = computed(() => !login.value || ["waiting", "scanned", "expired", "refused", "error"].includes(login.value.state));
const showQr = computed(() => !!login.value && ["waiting", "scanned"].includes(login.value.state));
const qrSeconds = computed(() => Math.max(0, Math.ceil(((login.value?.expiresAt || 0) - now.value) / 1000)));
const qrExpired = computed(() => login.value?.state === "expired" || (showQr.value && qrSeconds.value === 0));
const qrVisible = computed(() => showQr.value && !qrExpired.value && !qrFailed.value);
const stageTitle = computed(() => qrExpired.value ? "二维码已过期" : qrFailed.value && showQr.value ? "二维码加载失败" : login.value ? labels[login.value.state] : "扫描二维码登录");
const stageMessage = computed(() => {
  if (qrExpired.value) return "刷新二维码后重新扫码即可。";
  if (qrFailed.value && showQr.value) return "请刷新二维码后重试。";
  if (!login.value) return "点击下方按钮获取登录二维码。";
  if (login.value.state === "saved") return "正在连接抖音消息服务，请稍候。";
  if (login.value.state === "choose_trust") return "是否在抖音保存本设备的快捷登录信息？";
  return login.value.message;
});
const currentStep = computed(() => ["choose_trust", "confirmed", "saved"].includes(login.value?.state || "") ? 2 : login.value?.state === "verifying" ? 1 : 0);
const accountStatus = computed(() =>
  state.connectionError ? "连接中断 · 状态待更新" : account.value.loggedIn
    ? account.value.online ? "在线" : "已登录 · 等待消息连接"
    : state.data?.browser === "ready" ? "未登录" : state.data?.browser === "error" ? "浏览器异常" : "浏览器启动中",
);
watch(() => login.value?.id, () => { qrFailed.value = false; });
watch([() => login.value?.id, () => login.value?.state], () => { code.value = ""; });
async function createQr() {
  if (state.loginBusy) return;
  creatingQr.value = true;
  try { await store.loginAction("/api/douyin/login"); }
  finally { creatingQr.value = false; }
}
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
  } finally { reconnecting.value = false; }
}
</script>
<template>
  <section id="account-view" class="view">
    <article class="account-detail">
      <header class="account-bar">
        <span class="account-platform">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M14 3v12.5a4.5 4.5 0 1 1-4-4.47M14 3c.5 4 3 6 7 6V5c-2.5 0-3-1-3-2h-4Z" stroke-linejoin="round" stroke-linecap="round" /></svg>
          抖音
        </span>
        <span id="account-status" class="connection-status" :class="{ online: account.loggedIn && account.online && !state.connectionError }">
          <span class="status-dot" aria-hidden="true"></span>{{ accountStatus }}
        </span>
      </header>

      <div id="logged-in" :hidden="!connected">
        <div class="profile-row">
          <AccountAvatar class="account-profile-avatar" :src="account.avatar" :name="account.name" />
          <div class="profile-copy">
            <h2>{{ account.name || '账号已登录' }}</h2>
            <p id="account-id">抖音账号 ID · {{ account.id || '获取中' }}</p>
          </div>
          <span class="profile-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
        </div>
      </div>

      <div id="login-panel" :hidden="connected" class="login-layout">
        <div class="login-guide">
          <div class="guide-intro"><h2>扫码登录</h2><p>用手机确认，将抖音账号连接到 MeloFox。</p></div>
          <ol class="login-steps" aria-label="登录步骤">
            <li v-for="(step, index) in steps" :key="step.title" :class="{ active: index === currentStep, done: index < currentStep || login?.state === 'saved' }" :aria-current="index === currentStep ? 'step' : undefined">
              <span class="step-number" aria-hidden="true">
                <svg v-if="index < currentStep || login?.state === 'saved'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6" stroke-linecap="round" stroke-linejoin="round" /></svg>
                <template v-else>{{ index + 1 }}</template>
              </span>
              <div><strong>{{ step.title }}</strong><p>{{ step.description }}</p></div>
            </li>
          </ol>
          <p class="session-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" stroke-linejoin="round" /><path d="m8 12 3 3 5-6" stroke-linecap="round" stroke-linejoin="round" /></svg>登录状态保存在当前 MeloFox 服务中</p>
        </div>

        <div class="login-stage" :class="{ 'form-stage': !qrStage }">
          <div v-if="qrStage" class="qr-frame" :class="{ 'qr-empty': !qrVisible }">
            <img id="login-qrcode" :src="showQr ? `/api/douyin/login/${login!.id}/qr` : undefined" alt="抖音登录二维码" :hidden="!qrVisible" @error="qrFailed = true" />
            <div id="qr-placeholder" :hidden="qrVisible">
              <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><rect x="8" y="8" width="17" height="17" rx="3" /><rect x="39" y="8" width="17" height="17" rx="3" /><rect x="8" y="39" width="17" height="17" rx="3" /><path d="M39 39h8v8h9v9H39V39ZM8 32h17m7-24v17m0 14v17m7-24h17" stroke-linecap="round" stroke-linejoin="round" /></svg>
              <span>{{ creatingQr ? '正在生成二维码…' : qrExpired ? '二维码已失效' : qrFailed ? '图片加载失败' : '等待生成二维码' }}</span>
            </div>
          </div>
          <div v-else class="stage-symbol" :class="{ success: ['choose_trust', 'saved'].includes(login?.state || '') }" aria-hidden="true">
            <svg v-if="login?.state === 'verifying'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M10 5h4m-3 14h2" stroke-linecap="round" /></svg>
            <svg v-else-if="login?.state === 'confirmed'" class="waiting-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 12a8 8 0 1 1-8-8" stroke-linecap="round" /></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" stroke-linejoin="round" /><path d="m8 12 3 3 5-6" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </div>
          <div class="stage-copy" role="status" aria-live="polite" aria-atomic="true">
            <h3 id="qr-state-title">{{ stageTitle }}</h3>
            <p id="qr-state-message" :hidden="!stageMessage">{{ stageMessage }}</p>
          </div>
          <p id="qr-expiry" v-if="qrVisible" class="qr-expiry">二维码有效期剩余 <span>{{ Math.floor(qrSeconds / 60) }}:{{ String(qrSeconds % 60).padStart(2, '0') }}</span></p>

          <form id="verify-form" :hidden="!verifying" @submit.prevent="verify">
            <label for="verify-code">短信验证码</label>
            <div class="verification-input">
              <input id="verify-code" v-model="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="输入验证码" pattern="[0-9]{4,8}" minlength="4" maxlength="8" required :disabled="state.loginBusy" aria-describedby="verify-hint" />
              <button id="send-verify-code" type="button" class="secondary" :disabled="state.loginBusy || seconds > 0" @click="store.loginStep('sms')">{{ seconds ? `${seconds} 秒后重发` : '发送验证码' }}</button>
            </div>
            <p id="verify-hint" class="form-hint">验证码将发送至抖音账号绑定的手机。</p>
            <button id="submit-verify-code" type="submit" class="primary" :disabled="state.loginBusy">{{ state.loginBusy ? '处理中…' : '验证并继续' }}</button>
          </form>

          <div id="trust-choice" :hidden="login?.state !== 'choose_trust'">
            <button id="trust-save" type="button" class="primary" :disabled="state.loginBusy" @click="store.loginStep('trust', { save: true })">保存快捷登录</button>
            <button id="trust-skip" type="button" class="secondary" :disabled="state.loginBusy" @click="store.loginStep('trust', { save: false })">不保存快捷登录</button>
            <p class="form-hint">两种选择都会保留 MeloFox 的登录状态；退出抖音登录后清除。</p>
          </div>
          <p v-if="login?.state === 'verifying' && !verifying" class="form-hint">请点击下方「辅助验证」，在官方页面完成验证。</p>
          <div class="stage-actions" :class="{ 'secondary-actions': !qrStage }">
            <button id="open-douyin" :class="qrStage ? 'primary' : 'text-button'" :hidden="['confirmed', 'saved'].includes(login?.state || '')" :disabled="state.loginBusy" @click="createQr">
              <svg v-if="login && qrStage" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3" stroke-linecap="round" stroke-linejoin="round" /></svg>
              {{ creatingQr ? '获取中…' : !login ? '获取登录二维码' : qrStage ? '刷新二维码' : '重新扫码' }}
            </button>
            <button id="check-login" class="text-button" :hidden="!login || !['waiting', 'scanned', 'confirmed'].includes(login.state)" :disabled="state.loginBusy" @click="store.pollLogin(true)">检查登录状态</button>
          </div>
        </div>
      </div>

      <p id="douyin-login-error" :hidden="!state.loginError" class="login-error" role="alert">{{ state.loginError }}</p>
      <footer class="account-tools">
        <span class="tools-label">{{ connected ? '账号操作' : '遇到登录问题？' }}</span>
        <div class="tool-actions">
          <button id="login-assist" class="text-button" :disabled="state.loginBusy" @click="state.assist = true; state.pollStopped = true;">辅助验证</button>
          <button id="reconnect" class="text-button" :disabled="reconnecting" @click="reconnect">{{ reconnecting ? '重连中…' : '重连会话' }}</button>
          <button id="douyin-logout" class="text-button" :class="{ 'logout-action': account.loggedIn }" :disabled="state.loginBusy" @click="store.logoutDouyin">{{ account.loggedIn ? '退出抖音登录' : '清除登录状态' }}</button>
        </div>
      </footer>
    </article>
  </section>
</template>
<style scoped>
.account-detail { max-width:1040px; margin:0 auto; padding:0; overflow:hidden; }
.account-bar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:18px 28px; border-bottom:1px solid var(--line); }
.account-platform { display:inline-flex; align-items:center; gap:10px; font-size:var(--text-16); font-weight:650; flex-shrink:0; }
.account-platform svg { width:22px; height:22px; }
.connection-status { display:inline-flex; align-items:center; gap:8px; font-size:var(--text-14); color:var(--muted); }
.status-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex-shrink:0; }
.connection-status.online { color:var(--positive-text); }
.login-layout { display:grid; grid-template-columns:minmax(260px, .85fr) minmax(0, 1.15fr); }
.login-guide { padding:38px 32px 30px; background:linear-gradient(150deg, color-mix(in srgb, var(--accent) 9%, var(--surface)), transparent 85%); border-right:1px solid var(--line); display:flex; flex-direction:column; }
.guide-intro h2 { font-size:var(--text-28); font-weight:650; letter-spacing:-.5px; }
.guide-intro > p { color:var(--muted); margin-top:10px; max-width:240px; }
.login-steps { list-style:none; padding:0; margin:36px 0; display:grid; gap:26px; }
.login-steps li { position:relative; display:flex; align-items:flex-start; gap:13px; color:var(--muted); }
.login-steps li:not(:last-child)::after { content:""; position:absolute; top:38px; bottom:-20px; left:15px; width:1px; background:var(--line); }
.step-number { display:grid; place-items:center; width:32px; height:32px; border-radius:50%; border:1px solid var(--line); background:var(--surface); font-weight:650; flex-shrink:0; }
.step-number svg { width:18px; height:18px; }
.login-steps strong { display:block; margin-top:3px; font-weight:600; }
.login-steps p { margin-top:5px; font-size:var(--text-14); }
.login-steps .active strong { color:var(--ink); }
.login-steps .active .step-number { background:var(--primary-bg); color:var(--on-primary); border-color:var(--primary-bg); box-shadow:0 0 0 4px var(--focus-ring); }
.login-steps .done .step-number { color:var(--accent); background:var(--accent-soft); border-color:transparent; box-shadow:none; }
.session-note { display:flex; align-items:flex-start; gap:8px; color:var(--muted); font-size:var(--text-14); margin-top:auto; }
.session-note svg { width:18px; height:18px; flex-shrink:0; margin-top:2px; }
.login-stage { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:34px 40px; min-width:0; min-height:490px; text-align:center; }
.qr-frame { display:grid; place-items:center; width:224px; max-width:100%; aspect-ratio:1; padding:13px; background:#fff; border:1px solid var(--line); border-radius:16px; box-shadow:0 5px 22px var(--focus-ring); }
.qr-frame.qr-empty { background:var(--surface); border:1px dashed var(--outline); box-shadow:none; }
#login-qrcode { display:block; width:100%; height:auto; aspect-ratio:1; image-rendering:pixelated; }
#qr-placeholder { display:flex; flex-direction:column; align-items:center; gap:18px; color:var(--muted); font-size:var(--text-14); }
#qr-placeholder svg { width:68px; height:68px; color:var(--accent); opacity:.65; }
.stage-copy { margin-top:24px; width:100%; overflow-wrap:anywhere; }
.stage-copy h3 { font-size:var(--text-20); font-weight:650; line-height:1.5; }
.stage-copy p { color:var(--muted); margin:8px auto 0; max-width:340px; font-size:var(--text-14); }
.qr-expiry { margin-top:8px; color:var(--muted); font-size:var(--text-14); }
.qr-expiry span { color:var(--accent); font-variant-numeric:tabular-nums; }
.stage-actions { width:100%; max-width:320px; display:flex; flex-direction:column; align-items:stretch; gap:10px; margin-top:22px; }
.stage-actions svg { width:18px; height:18px; }
.stage-actions .text-button { padding:6px 0; color:var(--muted); }
.stage-actions .text-button:hover { color:var(--accent); }
.stage-symbol { display:grid; place-items:center; width:66px; height:66px; background:var(--accent-soft); color:var(--accent); border-radius:20px; }
.stage-symbol svg { width:32px; height:32px; }
.stage-symbol.success { color:var(--positive-text); background:var(--positive-bg); }
.waiting-symbol { animation:login-spin 1.5s linear infinite; }
.form-stage .stage-copy { margin-top:20px; }
.form-stage .secondary-actions { margin-top:16px; }
#verify-form { display:grid; gap:12px; width:100%; max-width:360px; margin-top:28px; text-align:left; }
#verify-form label { margin:0; font-size:var(--text-14); font-weight:600; }
.verification-input { display:flex; gap:8px; }
#verify-code { min-width:0; width:100%; height:46px; padding:10px 12px; border:1px solid var(--outline); border-radius:8px; background:var(--surface); color:var(--ink); font-size:var(--text-16); font-variant-numeric:tabular-nums; }
#verify-code:focus { border-color:var(--accent); }
#send-verify-code { padding:10px 12px; flex-shrink:0; }
#submit-verify-code { margin-top:8px; width:100%; }
.form-hint { color:var(--muted); font-size:var(--text-14); line-height:1.8; }
#trust-choice { display:grid; gap:12px; width:100%; max-width:320px; margin-top:28px; }
#trust-choice .form-hint { margin-top:6px; }
.login-error { margin:0 28px 20px; padding:12px 16px; color:var(--error-text); background:color-mix(in srgb, var(--error-text) 8%, transparent); border:1px solid color-mix(in srgb, var(--error-text) 25%, transparent); border-radius:10px; overflow-wrap:anywhere; }
.account-tools { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px 24px; padding:16px 28px; border-top:1px solid var(--line); }
.tools-label { font-size:var(--text-14); color:var(--muted); }
.tool-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px 22px; }
.tool-actions .text-button { color:var(--secondary-text); padding:6px 0; }
.tool-actions .text-button:hover { color:var(--accent); }
.tool-actions .logout-action { color:var(--error-text); }
#logged-in { padding:36px; }
.profile-row { display:flex; align-items:center; gap:20px; }
.account-profile-avatar { width:76px; height:76px; border-radius:24px; }
.profile-copy { min-width:0; flex:1; }
.profile-copy h2 { font-size:var(--text-24); overflow-wrap:anywhere; }
.profile-copy p { color:var(--muted); margin-top:6px; overflow-wrap:anywhere; font-size:var(--text-14); }
.profile-check { display:grid; place-items:center; width:36px; height:36px; border-radius:50%; background:var(--positive-bg); color:var(--positive-text); }
.profile-check svg { width:20px; height:20px; }
@keyframes login-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) { .waiting-symbol { animation:none; } }
@media (max-width:1100px) {
  .login-guide { padding:32px 24px; }
  .login-stage { padding:32px 24px; }
}
@media (max-width:900px) {
  .login-layout { grid-template-columns:1fr; }
  .login-guide { padding:24px; border-right:0; border-bottom:1px solid var(--line); }
  .guide-intro h2 { font-size:var(--text-24); }
  .guide-intro > p { max-width:none; margin-top:6px; }
  .login-steps { display:flex; justify-content:space-between; gap:12px; margin:24px 0 0; }
  .login-steps li { flex:1; flex-direction:column; gap:8px; align-items:center; text-align:center; }
  .login-steps li:not(:last-child)::after { top:16px; bottom:auto; left:calc(50% + 25px); width:calc(100% - 38px); height:1px; }
  .login-steps strong { margin:0; font-size:var(--text-14); }
  .login-steps p, .session-note { display:none; }
  .login-stage { min-height:0; padding:30px 24px; }
  .form-stage { padding-top:36px; padding-bottom:36px; }
}
@media (max-width:760px) {
  .account-detail { padding:0; }
  .account-bar { padding:16px 20px; }
  .login-guide { padding:20px 16px; }
  .guide-intro { display:none; }
  .login-steps { margin:0; }
  .login-stage { padding:26px 20px; }
  .qr-frame { width:208px; }
  .stage-symbol { width:56px; height:56px; border-radius:18px; }
  .stage-copy { margin-top:20px; }
  .stage-actions { margin-top:18px; }
  .account-tools { padding:14px 20px; }
  .account-tools .tools-label { display:none; }
  .tool-actions { justify-content:space-between; width:100%; gap:8px 14px; }
  .tool-actions .text-button { min-height:40px; }
  .login-error { margin:0 20px 20px; }
  #logged-in { padding:24px 20px; }
  .profile-row { gap:14px; }
  .account-profile-avatar { width:60px; height:60px; border-radius:18px; }
  .profile-check { display:none; }
  .profile-copy h2 { font-size:var(--text-20); }
}
</style>
