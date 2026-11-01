<script setup lang="ts">
import { computed, ref } from "vue";
import { useConsole } from "../console";
import { channelTypes, endpoint } from "../presentation";
import StatusPill from "../components/StatusPill.vue";
const { state, openChannel, toggleChannel } = useConsole();
const filter = ref("all");
const filters = { all: "全部通道", enabled: "已启用", disabled: "已停用" };
const channels = computed(() => state.data!.channels);
const filtered = computed(() =>
  channels.value.filter(
    (c) => filter.value === "all" || c.enabled === (filter.value === "enabled"),
  ),
);
</script>
<template>
  <section id="channels-view" class="view">
    <div class="channel-toolbar">
      <div class="filter-tabs">
        <button
          v-for="(label, name) in filters"
          :key="name"
          :data-filter="name"
          :class="{ active: filter === name }"
          @click="filter = name"
        >
          {{ label }}
        </button>
      </div>
      <button class="primary new-channel" @click="openChannel()">
        ＋ 创建通道
      </button>
    </div>
    <div id="channel-list" class="channel-list">
      <article v-for="c in filtered" :key="c.id" class="channel-card">
        <div class="channel-card-header">
          <span class="channel-icon">{{ c.type === "http" ? "⌘" : "⇄" }}</span>
          <div>
            <h3>{{ c.name }}</h3>
            <div class="tiny-label">{{ channelTypes[c.type] }}</div>
          </div>
          <button
            class="switch"
            role="switch"
            :aria-checked="c.enabled"
            :aria-label="`${c.enabled ? '停用' : '启用'}${c.name}`"
            :data-toggle="c.id"
            :disabled="state.pendingChannels.has(c.id)"
            @click="toggleChannel(c)"
          ></button>
        </div>
        <div class="channel-endpoint">{{ endpoint(c) }}</div>
        <div class="channel-meta">
          <StatusPill :status="c.status.state" /><span
            >{{ c.accessToken ? "已配置令牌" : "未设置令牌"
            }}{{
              c.status.clients !== undefined
                ? ` · ${c.status.clients} 个连接`
                : ""
            }}</span
          >
        </div>
        <p v-if="c.status.error" class="channel-error">{{ c.status.error }}</p>
        <div class="channel-card-footer">
          <span>ONEBOT 11</span
          ><button
            :data-edit="c.id"
            :disabled="state.pendingChannels.has(c.id)"
            @click="openChannel(c)"
          >
            编辑配置</button
          ><button
            class="delete-channel"
            :data-delete="c.id"
            :disabled="state.pendingChannels.has(c.id)"
            @click="state.deleting = c"
          >
            删除
          </button>
        </div>
      </article>
      <div v-if="!filtered.length" class="empty-state">
        <span>⇄</span>
        <h2>
          {{ channels.length ? "没有符合条件的通道" : "准备好第一条连接" }}
        </h2>
        <p>
          {{
            channels.length
              ? "切换筛选条件，查看其他通道。"
              : "选择连接方式，将抖音消息接入你的机器人。"
          }}
        </p>
        <button class="primary new-channel" @click="openChannel()">
          ＋ 创建通道
        </button>
      </div>
    </div>
    <div class="channel-help">
      <span class="help-icon">i</span>
      <p>
        <strong>如何选择连接方式？</strong> HTTP 用于调用接口及访问媒体；正向
        WebSocket 等待应用连接；反向 WebSocket 主动连接 AstrBot
        等服务。媒体访问需要启用 HTTP 通道。
      </p>
    </div>
  </section>
</template>
