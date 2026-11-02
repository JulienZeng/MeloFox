<script setup lang="ts">
import { ref } from "vue";
import { useConsole } from "../console";
import { errorMessage, isCancelled } from "../api";
import { validateAuthForm } from "../form-validation";
import { useTheme } from "../composables/theme";
import ThemeControl from "./ThemeControl.vue";
const { state, authenticate } = useConsole();
const { asset } = useTheme();
const username = ref("melofox"), password = ref(""), showPassword = ref(false), error = ref("");
async function submit(event: SubmitEvent) {
  if (state.authBusy || !state.ready) return;
  error.value = validateAuthForm(event.currentTarget as HTMLFormElement);
  if (error.value) return;
  const value = password.value;
  password.value = "";
  try { await authenticate(username.value, value); }
  catch (failure) { if (!isCancelled(failure)) error.value = errorMessage(failure); }
}
</script>
<template>
  <main id="login-screen" class="auth-screen">
    <ThemeControl class="auth-theme" name="login-theme" label="登录页外观" />
    <section class="auth-card">
      <div class="auth-brand"><img :src="asset('logo')" data-theme-asset="logo" width="48" height="48" alt="" /><div><h1>MeloFox</h1><p>管理台登录</p></div></div>
      <form id="login-form" novalidate @submit.prevent="submit">
        <label for="login-username">账号</label>
        <input id="login-username" v-model="username" name="username" autocomplete="username" required maxlength="32" :disabled="state.authBusy" />
        <label for="login-password">密码</label>
        <div class="password-field">
          <input id="login-password" v-model="password" name="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required maxlength="1024" :disabled="state.authBusy" />
          <button type="button" class="icon-button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword">◉</button>
        </div>
        <p id="login-error" class="error-text" role="alert">{{ error || state.connectionError }}</p>
        <button type="submit" class="primary full" :disabled="state.authBusy || !state.ready">{{ state.authBusy ? '登录中…' : '登录' }}</button>
      </form>
      <details class="auth-help"><summary>首次登录</summary><p>默认账号 <code>melofox</code>，初始密码为现有管理令牌。登录后必须修改密码，账号可选修改。</p><p>初始密码来源：<code>WEB_TOKEN</code>，未配置时读取服务端 <code>data/console/admin-token</code>。</p></details>
    </section>
  </main>
</template>
