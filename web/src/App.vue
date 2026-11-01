<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { consoleKey, createConsole } from "./console";
import { createTheme, themeKey } from "./composables/theme";
import { views, type ViewName } from "./presentation";
import LoginScreen from "./components/LoginScreen.vue";
import ThemeControl from "./components/ThemeControl.vue";
import ChannelDialog from "./components/ChannelDialog.vue";
import DeleteChannelDialog from "./components/DeleteChannelDialog.vue";
import AssistDialog from "./components/AssistDialog.vue";

const store = createConsole(),
  { state } = store;
const theme = createTheme(),
  { asset } = theme;
provide(consoleKey, store);
provide(themeKey, theme);
const route = useRoute();
const current = computed(() => views[route.name as ViewName] || views.overview);
const topStatus = computed(() =>
  state.connectionError
    ? "管理服务连接中断"
    : state.data?.account.online
      ? "消息连接在线"
      : state.data?.account.loggedIn
        ? "账号已登录"
        : "等待账号登录",
);
watch(
  () => route.fullPath,
  () => {
    store.closeDialogs();
    document.title = `${current.value.label} · Douyin OneBot`;
  },
  { immediate: true },
);
let stop: (() => void) | undefined;
onMounted(() => {
  stop = store.start(() => route.name === "account");
});
onUnmounted(() => {
  stop?.();
  theme.dispose();
});
</script>
<template>
  <LoginScreen v-if="!state.authenticated" />
  <div v-else id="app" class="app">
    <aside class="sidebar">
      <RouterLink class="brand" to="/overview" data-view="overview">
        <img
          class="brand-mark"
          data-theme-asset="logo"
          :src="asset('logo')"
          width="31"
          height="31"
          alt=""
        />
        <span>Douyin<span class="brand-light"> OneBot</span></span>
      </RouterLink>
      <div class="workspace-label">工作空间 <span>LOCAL</span></div>
      <nav aria-label="主导航">
        <RouterLink
          v-for="(view, name) in views"
          :key="name"
          class="nav-item"
          :to="`/${name}`"
          :data-view="name"
        >
          <span>{{ view.icon }}</span> {{ view.label }}
          <span
            v-if="name === 'channels'"
            id="nav-channel-count"
            class="nav-count"
            >{{ state.data?.channels.length || 0 }}</span
          >
        </RouterLink>
      </nav>
      <div class="sidebar-bottom">
        <div class="protocol-badge">
          <span class="dot"></span>
          <div>OneBot 11<span>消息连接协议</span></div>
          <span class="protocol-icon">↗</span>
        </div>
        <button
          id="logout"
          class="nav-item"
          :disabled="state.authBusy"
          @click="store.logout"
        >
          <span>⇥</span> 退出管理台
        </button>
        <span class="sidebar-version">DOUYIN ONEBOT <span>v0.1.0</span></span>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <span
          >工作空间 <span class="breadcrumb">/</span>
          <strong id="breadcrumb-title">{{ current.label }}</strong></span
        >
        <div>
          <ThemeControl name="console-theme" label="管理台外观" />
          <span
            id="top-status"
            class="status-pill"
            :class="{
              offline: state.connectionError || !state.data?.account.online,
            }"
            >{{ topStatus }}</span
          >
          <span class="admin-avatar">A</span>
          <button
            id="mobile-logout"
            class="icon-button"
            aria-label="退出管理台"
            :disabled="state.authBusy"
            @click="store.logout"
          >
            ⇥
          </button>
        </div>
      </header>
      <main class="main">
        <div class="page-heading">
          <div>
            <div class="eyebrow">YOUR CONNECTION WORKSPACE</div>
            <h1 id="page-title">
              {{ current.title }}<span class="accent">。</span>
            </h1>
            <p id="page-description" class="muted">{{ current.description }}</p>
          </div>
          <button
            id="refresh"
            class="secondary"
            :disabled="state.refreshBusy"
            @click="store.refresh"
          >
            ↻ <span>刷新状态</span>
          </button>
        </div>
        <div
          id="server-error"
          class="notice"
          role="status"
          :hidden="!state.connectionError && !state.data?.error"
        >
          {{ state.connectionError || state.data?.error }}
        </div>
        <RouterView />
        <footer class="main-footer">
          <span>Douyin OneBot · 把连接变简单</span
          ><span>ONEBOT 11 / LOCAL CONSOLE</span>
        </footer>
      </main>
    </div>
    <ChannelDialog v-if="state.editor" :editor="state.editor" />
    <DeleteChannelDialog v-if="state.deleting" :channel="state.deleting" />
    <AssistDialog v-if="state.assist" />
  </div>
  <div
    id="toast"
    class="toast"
    :class="{ error: state.toast?.error }"
    role="status"
    :hidden="!state.toast"
  >
    {{ state.toast?.message }}
  </div>
</template>
