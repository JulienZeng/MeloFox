<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useConsole } from "../console";
import { channelTypes, elapsed, healthy } from "../presentation";
import StatusPill from "../components/StatusPill.vue";
const { state, openChannel } = useConsole();
const account = computed(() => state.data!.account),
  channels = computed(() => state.data!.channels);
</script>
<template>
  <section id="overview-view" class="view">
    <div class="stats-grid">
      <article class="stat">
        <span>抖音账号</span>
        <div>
          <strong id="stat-account">{{
            account.loggedIn ? "已登录" : "等待登录"
          }}</strong
          ><span class="stat-icon mint">◎</span>
        </div>
        <small id="stat-account-note">{{
          account.loggedIn ? `账号 ${account.id}` : "登录后即可收发消息"
        }}</small>
      </article>
      <article class="stat">
        <span>连接通道</span>
        <div>
          <strong id="stat-channels"
            >{{ channels.length }} <small>个</small></strong
          ><span class="stat-icon lavender">⇄</span>
        </div>
        <small id="stat-channels-note">{{
          channels.length
            ? `${channels.filter((c) => c.enabled).length} 个启用 · ${channels.filter((c) => healthy(c.status.state)).length} 个已就绪`
            : "创建你的第一个连接"
        }}</small>
      </article>
      <article class="stat">
        <span>服务运行时间</span>
        <div>
          <strong id="stat-uptime">{{ elapsed(state.data!.startedAt) }}</strong
          ><span class="stat-icon sand">◷</span>
        </div>
        <small>{{
          state.connectionError
            ? "服务连接中断，状态待更新"
            : "管理服务持续在线"
        }}</small>
      </article>
    </div>
    <article class="setup-card">
      <div class="section-heading">
        <div>
          <span class="small-label">QUICK START</span>
          <h2>三步，接入你的机器人</h2>
        </div>
        <span id="setup-progress" class="subtle-pill"
          >{{ 1 + Number(account.loggedIn) + Number(channels.length > 0) }} / 3
          已完成</span
        >
      </div>
      <div class="steps">
        <div class="step done">
          <span class="step-number">✓</span>
          <div>
            <h3>进入管理台</h3>
            <p>你的工作空间已准备就绪</p>
          </div>
          <span class="step-tag">已完成</span>
        </div>
        <div id="account-step" class="step" :class="{ done: account.loggedIn }">
          <span class="step-number">{{ account.loggedIn ? "✓" : "02" }}</span>
          <div>
            <h3>登录抖音账号</h3>
            <p>使用抖音 App 扫码，自动保存登录配置</p>
          </div>
          <RouterLink class="text-button" to="/account" data-view="account">{{
            account.loggedIn ? "管理账号 ↗" : "前往登录 ↗"
          }}</RouterLink>
        </div>
        <div
          id="channel-step"
          class="step"
          :class="{ done: channels.length > 0 }"
        >
          <span class="step-number">{{ channels.length ? "✓" : "03" }}</span>
          <div>
            <h3>创建连接通道</h3>
            <p>通过 OneBot 11 连接 AstrBot 等应用</p>
          </div>
          <button class="text-button new-channel" @click="openChannel()">
            创建通道 ↗
          </button>
        </div>
      </div>
    </article>
    <div class="overview-bottom">
      <article class="account-summary">
        <div class="section-heading">
          <h2>当前账号</h2>
          <span class="tiny-label">DOUYIN</span>
        </div>
        <div class="account-identity">
          <div class="account-avatar">抖</div>
          <div>
            <h3 id="summary-account">
              {{ account.loggedIn ? "抖音账号已登录" : "还没有登录账号" }}
            </h3>
            <p id="summary-account-note" class="muted">
              {{
                account.loggedIn
                  ? `ID ${account.id}`
                  : "扫码登录，开始你的第一条连接"
              }}
            </p>
          </div>
        </div>
        <RouterLink class="secondary" to="/account" data-view="account"
          >管理账号 <span>→</span></RouterLink
        >
      </article>
      <article class="connection-summary">
        <div class="section-heading">
          <h2>通道动态</h2>
          <RouterLink class="text-button" to="/channels" data-view="channels"
            >查看全部 ↗</RouterLink
          >
        </div>
        <div id="overview-channels">
          <template v-if="channels.length"
            ><div
              v-for="c in channels.slice(0, 2)"
              :key="c.id"
              class="mini-channel"
            >
              <span>⇄</span>
              <div>
                {{ c.name }}<small>{{ channelTypes[c.type] }}</small>
              </div>
              <StatusPill :status="c.status.state" /></div
          ></template>
          <div v-else class="empty-mini">
            <span>⇄</span>
            <p>这里还没有连接通道</p>
            <button class="text-button new-channel" @click="openChannel()">
              创建你的第一个通道 ↗
            </button>
          </div>
        </div>
      </article>
    </div>
    <div class="workspace-tip">
      <span>✳</span>
      <p>一个账号，多种连接。通道可独立启停，配置会在重启后自动恢复。</p>
      <span>BUILT TO CONNECT</span>
    </div>
  </section>
</template>
