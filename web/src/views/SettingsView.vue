<script setup lang="ts">
import { useConsole } from "../console";
import CredentialForm from "../components/CredentialForm.vue";
const { state } = useConsole();
</script>
<template>
  <section id="settings-view" class="view settings-grid">
    <article class="settings-card"><div class="section-heading"><h2>管理账号</h2></div><p class="muted">修改后其他登录会话将失效。</p><CredentialForm /></article>
    <article class="settings-card"><div class="section-heading"><h2>运行环境</h2></div><dl class="system-details"><dt>版本</dt><dd>MeloFox {{ state.data?.runtime.version }}</dd><dt>协议</dt><dd>OneBot 11</dd><dt>平台</dt><dd>{{ state.data?.runtime.platform }} / {{ state.data?.runtime.arch }}</dd><dt>Node.js</dt><dd>{{ state.data?.runtime.nodeVersion }}</dd><dt>进程内存</dt><dd>{{ ((state.data?.runtime.memoryBytes || 0) / 1024 / 1024).toFixed(0) }} MB</dd></dl></article>
  </section>
</template>
