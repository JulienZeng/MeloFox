<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { consoleKey, createConsole } from "./console";
import { createTheme, themeKey } from "./composables/theme";
import { views, type ViewName } from "./presentation";
import LoginScreen from "./components/LoginScreen.vue";
import FirstLoginScreen from "./components/FirstLoginScreen.vue";
import ThemeControl from "./components/ThemeControl.vue";
import ChannelDialog from "./components/ChannelDialog.vue";
import DeleteChannelDialog from "./components/DeleteChannelDialog.vue";
import AssistDialog from "./components/AssistDialog.vue";
import RestartServiceDialog from "./components/RestartServiceDialog.vue";

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
    document.title = `${current.value.label} · MeloFox`;
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
  <FirstLoginScreen v-else-if="state.auth?.mustChangePassword" />
  <div v-else-if="state.data" id="app" class="app">
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
        <span>Melo<span class="brand-light">Fox</span></span>
      </RouterLink>

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
        <button
          id="logout"
          class="nav-item"
          :disabled="state.authBusy"
          @click="store.logout"
        >
          <span>⇥</span> 退出管理台
        </button>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <span
          >MeloFox <span class="breadcrumb">/</span>
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
          <RouterLink class="admin-link" to="/settings">{{ state.auth?.username }}</RouterLink>
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
            <h1 id="page-title">
              {{ current.title }}
            </h1>
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

      </main>
    </div>
    <ChannelDialog v-if="state.editor" :editor="state.editor" />
    <DeleteChannelDialog v-if="state.deleting" :channel="state.deleting" />
    <AssistDialog v-if="state.assist" />
  </div>
  <main v-else class="auth-screen"><section class="auth-card"><h1>正在连接管理服务</h1><p class="error-text">{{ state.connectionError }}</p><button class="secondary" @click="store.refresh">重试</button><button class="text-button auth-exit" @click="store.logout">退出登录</button></section></main>
  <RestartServiceDialog v-if="state.restartDialog" />
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
