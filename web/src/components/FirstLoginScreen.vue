<script setup lang="ts">
import { useConsole } from "../console";
import { useTheme } from "../composables/theme";
import CredentialForm from "./CredentialForm.vue";
import ThemeControl from "./ThemeControl.vue";
const { state, logout } = useConsole();
const { asset } = useTheme();
</script>
<template>
  <main id="first-login-screen" class="auth-screen">
    <ThemeControl class="auth-theme" name="setup-theme" label="页面外观" />
    <section class="auth-card">
      <div class="auth-brand"><img :src="asset('logo')" width="44" height="44" alt="" /><div><h1>设置管理密码</h1><p>首次登录，修改密码后继续。账号可保持不变。</p></div></div>
      <CredentialForm initial />
      <button id="setup-logout" class="text-button auth-exit" :disabled="state.authBusy" @click="logout">退出登录</button>
    </section>
  </main>
</template>
