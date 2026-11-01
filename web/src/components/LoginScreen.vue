<script setup lang="ts">
import { ref } from "vue";
import { RouterLink } from "vue-router";
import { useConsole } from "../console";
import { errorMessage, isCancelled } from "../api";
import { useTheme } from "../composables/theme";
import ThemeControl from "./ThemeControl.vue";
const { state, authenticate } = useConsole();
const { asset } = useTheme();
const token = ref(""),
  showToken = ref(false),
  error = ref("");
async function submit() {
  if (state.authBusy || !state.ready) return;
  error.value = "";
  const value = token.value;
  token.value = "";
  try {
    await authenticate(value);
  } catch (failure) {
    if (!isCancelled(failure)) error.value = errorMessage(failure);
  }
}
</script>
<template>
  <div id="login-screen" class="login-screen">
    <section class="login-story">
      <RouterLink class="brand" to="/overview" data-view="overview"
        ><img
          class="brand-mark"
          data-theme-asset="logo"
          :src="asset('logo')"
          width="35"
          height="35"
          alt=""
        />
        <span>Douyin<span class="brand-light"> OneBot</span></span></RouterLink
      >
      <div class="story-copy">
        <div class="eyebrow">A LITTLE BRIDGE. MORE POSSIBILITIES.</div>
        <h1>让每一条消息，<br />连接更多可能<span class="accent">。</span></h1>
        <p>从抖音到你的机器人。<br />登录账号、配置通道，让消息自然流动。</p>
        <div class="bridge-art" aria-hidden="true">
          <div class="art-node douyin-node">
            <img
              data-theme-asset="douyin"
              :src="asset('douyin')"
              width="30"
              height="34"
              alt=""
            />
          </div>
          <div class="art-line"><i></i><i></i><i></i></div>
          <img
            class="art-center"
            data-theme-asset="logo"
            :src="asset('logo')"
            width="72"
            height="72"
            alt=""
          />
          <div class="art-line"><i></i><i></i><i></i></div>
          <div class="art-node onebot-node">
            <!-- Shared light/dark asset from https://onebot.dev/logo.png -->
            <img src="/onebot.png" width="48" height="48" alt="" />
          </div>
        </div>
      </div>
      <div class="story-footer">
        <span class="dot"></span> 为你的连接，留一个简单的入口
        <span>ONEBOT 11</span>
      </div>
    </section>
    <main class="login-panel">
      <ThemeControl class="login-theme" name="login-theme" label="登录页外观" />
      <div class="login-form-wrap">
        <span class="small-label">CONTROL CONSOLE / 01</span>
        <h2>欢迎回来</h2>
        <p class="muted">使用管理令牌，进入你的连接控制台。</p>
        <form id="login-form" @submit.prevent="submit">
          <label for="login-token">管理令牌</label>
          <div class="password-field">
            <input
              id="login-token"
              name="token"
              v-model="token"
              :type="showToken ? 'text' : 'password'"
              required
              autocomplete="current-password"
              placeholder="输入你的管理令牌"
            /><button
              id="show-login-token"
              type="button"
              class="icon-button"
              :aria-label="showToken ? '隐藏管理令牌' : '显示管理令牌'"
              @click="showToken = !showToken"
            >
              ◉
            </button>
          </div>
          <p id="login-error" class="error-text" role="alert">
            {{ error || state.connectionError }}
          </p>
          <button
            type="submit"
            class="primary full"
            :disabled="state.authBusy || !state.ready"
          >
            进入控制台 <span>→</span>
          </button>
        </form>
        <div class="token-help">
          <span class="help-icon">i</span>
          <div>
            <strong>第一次使用？</strong>
            <p>
              管理令牌位于服务端
              <code>data/console/admin-token</code>，也可以通过
              <code>WEB_TOKEN</code> 自行设置。
            </p>
          </div>
        </div>
        <div class="login-note">
          <span class="dot"></span> 登录信息仅用于当前管理台
        </div>
      </div>
    </main>
  </div>
</template>
