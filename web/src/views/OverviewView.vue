<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { useConsole } from "../console";
import { channelTypes, channelSummary, endpoint } from "../presentation";
import { bytes, duration, percentage } from "../metrics-format";
import type { ChannelType } from "../types";
import StatusPill from "../components/StatusPill.vue";
import UsageRing from "../components/UsageRing.vue";
import AccountAvatar from "../components/AccountAvatar.vue";

const { state, openChannel } = useConsole();
const runtime = computed(() => state.data!.runtime);
const account = computed(() => state.data!.account), channels = computed(() => state.data!.channels);
const channelCounts = computed(() => channelSummary(channels.value));
const channelStateLabels = { ready: '就绪', waiting: '等待', error: '异常', disabled: '停用' };
const chromium = computed(() => runtime.value.chromium);
const chromiumLabel = computed(() => {
  const metrics = chromium.value;
  if (!metrics || metrics.state === 'stopped') return '尚未启动';
  if (metrics.state === 'unavailable') return '采集不可用';
  return metrics.processCount + ' 个进程' + (metrics.state === 'partial' ? ' · 部分数据' : metrics.state === 'sampling' ? ' · 采样中' : '');
});
const systemNames: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD" };
const now = ref(Date.now());
const timer = setInterval(() => { now.value = Date.now(); }, 1000);
onUnmounted(() => clearInterval(timer));
const sampleAge = computed(() => Math.max(0, Math.floor((
  state.data!.serverTime - runtime.value.sampledAt + now.value - state.lastUpdated
) / 1000)));
const stale = computed(() => !!state.connectionError || sampleAge.value > 10);
const frequency = computed(() => {
  const speed = runtime.value.cpu.frequencyMHz;
  if (!speed) return "不可用";
  const min = (speed.min / 1000).toFixed(2), max = (speed.max / 1000).toFixed(2);
  return (speed.min === speed.max ? max : min + "–" + max) + " GHz";
});
const channelGroups = computed(() => ([
  { type: "http", label: "HTTP 服务端" }, { type: "reverse-http", label: "HTTP 客户端" },
  { type: "forward-ws", label: "WS 服务端" }, { type: "reverse-ws", label: "WS 客户端" },
] as Array<{ type: ChannelType; label: string }>).map(group => {
  const items = channels.value.filter(channel => channel.type === group.type);
  return { ...group, count: items.length, enabled: items.filter(channel => channel.enabled).length };
}));
const localTime = (value: number) => new Date(value).toLocaleString("zh-CN", { hour12: false });
</script>
<template>
  <section id="overview-view" class="view overview-dashboard">
    <div v-if="!runtime?.cpu || !runtime?.memory" class="notice">管理服务尚未提供系统指标，请重启后端服务并刷新页面。</div>
    <template v-else>
    <div class="overview-sampling" :class="{ stale }" role="status">
      <span class="sampling-dot"></span><span>{{ stale ? '数据未更新' : '实时状态' }}</span>
      <span>{{ sampleAge > 10 ? sampleAge + ' 秒前采样' : '每 ' + runtime.sampleIntervalMs / 1000 + ' 秒采样' }} · {{ localTime(runtime.sampledAt) }}</span>
    </div>
    <div class="overview-primary-grid">
      <div class="overview-information">
        <article class="dashboard-card overview-account">
          <AccountAvatar :src="account.avatar" :name="account.name" />
          <div><span class="metric-label">抖音账号</span>
            <h2 id="stat-account">{{ account.loggedIn ? account.name || '已登录' : '未登录' }}</h2>
            <p id="stat-account-note">{{ account.id || '等待扫码登录' }}</p>
          </div>
          <RouterLink class="text-button" to="/account" data-view="account">{{ account.loggedIn ? '管理' : '登录' }} →</RouterLink>
          <div class="overview-session-status">
            <span :class="{ 'status-good': account.online }">消息连接 · {{ account.online ? '在线' : '离线' }}</span>
            <span>{{ { ready: '浏览器就绪', starting: '浏览器启动中', error: '浏览器启动失败' }[state.data!.browser] }}</span>
          </div>
        </article>
        <article id="system-information" class="dashboard-card">
          <div class="section-heading"><h2>系统信息</h2><span class="subtle-pill">OneBot 11</span></div>
          <dl class="overview-details">
            <dt>MeloFox</dt><dd>v{{ runtime.version }}</dd>
            <dt>管理台</dt><dd>v{{ runtime.version }} · Vue 3</dd>
            <dt>Node.js</dt><dd>{{ runtime.nodeVersion }}</dd>
            <dt>Chromium</dt><dd>{{ runtime.chromiumVersion || (state.data!.browser === 'ready' ? '版本不可用' : '尚未就绪') }}</dd>
            <dt>操作系统</dt><dd>{{ systemNames[runtime.platform] || runtime.osName }} / {{ runtime.machine }}</dd>
            <dt>内核版本</dt><dd>{{ runtime.osRelease }}</dd>
            <dt>主机名</dt><dd>{{ runtime.hostname }}</dd>
            <dt>系统已运行</dt><dd>{{ duration(runtime.systemUptimeSeconds) }}</dd>
            <dt>服务已运行</dt><dd id="stat-uptime">{{ duration(runtime.processUptimeSeconds) }}</dd>
            <dt>服务启动</dt><dd>{{ localTime(state.data!.startedAt) }}</dd>
            <dt>进程 PID</dt><dd>{{ runtime.pid }}</dd>
            <dt>系统时区</dt><dd>{{ runtime.timezone }}</dd>
            <dt>系统详情</dt><dd>{{ runtime.osVersion }}</dd>
            <dt>进程架构</dt><dd>{{ runtime.arch }}</dd>
            <dt>V8 引擎</dt><dd>{{ runtime.v8Version }}</dd>
            <dt>工作目录</dt><dd class="monospace">{{ runtime.workingDirectory || '不可用' }}</dd>
          </dl>
        </article>
      </div>
      <div class="overview-resources">
        <article id="cpu-information" class="dashboard-card resource-card">
          <div class="section-heading"><h2>CPU</h2><span class="metric-label">系统使用率</span></div>
          <div class="resource-main">
            <div class="resource-copy">
              <p class="cpu-model">{{ runtime.cpu.model || '型号不可用' }}</p>
              <dl class="resource-details">
                <div><dt>逻辑核心</dt><dd>{{ runtime.cpu.logicalCores || '—' }}</dd></div>
                <div><dt>可用并行度</dt><dd>{{ runtime.cpu.availableParallelism }}</dd></div>
                <div><dt>报告频率</dt><dd>{{ frequency }}</dd></div>
                <div><dt>MeloFox 主进程</dt><dd id="process-cpu-usage">{{ percentage(runtime.cpu.processUsagePercent) }}</dd></div>
                <div><dt>Chromium 进程组</dt><dd id="chromium-cpu-usage">{{ percentage(chromium?.cpuUsagePercent) }}</dd></div>
                <div><dt>浏览器进程</dt><dd id="chromium-process-count">{{ chromiumLabel }}</dd></div>
              </dl>
            </div>
            <UsageRing :value="runtime.cpu.usagePercent" label="CPU 占用" />
          </div>
          <details class="overview-extra core-details" open><summary>各逻辑核心 · {{ runtime.cpu.logicalCores }} 个</summary>
            <div v-if="runtime.cpu.coreUsagePercent.length" class="core-grid"><div v-for="(value, index) in runtime.cpu.coreUsagePercent" :key="index"><span>CPU {{ index + 1 }}</span><strong>{{ percentage(value) }}</strong><progress :value="value ?? undefined" max="100" :aria-label="'CPU ' + (index + 1) + ' 使用率'"></progress></div></div>
            <p v-else class="field-hint">当前环境未提供逻辑核心信息。</p>
          </details>
        </article>
        <article id="memory-information" class="dashboard-card resource-card">
          <div class="section-heading"><h2>内存</h2><span class="metric-label">系统内存</span></div>
          <div class="resource-main">
            <div class="resource-copy">
              <p class="memory-total">{{ bytes(runtime.memory.totalBytes) }} <span>总量</span></p>
              <dl class="resource-details">
                <div><dt>已用（含缓存）</dt><dd>{{ bytes(runtime.memory.usedBytes) }}</dd></div>
                <div><dt>空闲</dt><dd>{{ bytes(runtime.memory.freeBytes) }}</dd></div>
                <div><dt>MeloFox 主进程</dt><dd id="process-memory">{{ bytes(runtime.memory.rssBytes) }}</dd></div>
                <div><dt>Chromium 常驻内存</dt><dd id="chromium-memory">{{ bytes(chromium?.rssBytes) }}<small v-if="chromium?.rssBytes != null && chromium.measuredMemoryProcesses < chromium.processCount">（{{ chromium.measuredMemoryProcesses }}/{{ chromium.processCount }} 个进程）</small></dd></div>
                <div><dt>环境内存限制</dt><dd>{{ runtime.memory.constrainedBytes ? bytes(runtime.memory.constrainedBytes) : '未限制或不可用' }}</dd></div>
              </dl>
            </div>
            <UsageRing :value="runtime.memory.usagePercent" label="内存占用" />
          </div>
          <dl class="process-memory-details">
            <div><dt>JS 堆已用</dt><dd>{{ bytes(runtime.memory.heapUsedBytes) }}</dd></div>
            <div><dt>JS 堆已分配</dt><dd>{{ bytes(runtime.memory.heapTotalBytes) }}</dd></div>
            <div><dt>JS 堆上限</dt><dd>{{ bytes(runtime.memory.heapLimitBytes) }}</dd></div>
            <div><dt>外部内存</dt><dd>{{ bytes(runtime.memory.externalBytes) }}</dd></div>
            <div><dt>ArrayBuffer</dt><dd>{{ bytes(runtime.memory.arrayBuffersBytes) }}</dd></div>
          </dl>
        </article>
      </div>
    </div>
    <div class="overview-channel-stats">
      <RouterLink to="/channels" class="channel-stat total-channel-stat"><span>网络配置</span><strong id="stat-channels">{{ channels.length }}</strong><small id="stat-channels-note"><span v-for="(label, key) in channelStateLabels" :key="key" :data-channel-state="key">{{ channelCounts[key] }} {{ label }}</span></small></RouterLink>
      <RouterLink v-for="group in channelGroups" :key="group.type" to="/channels" class="channel-stat" :data-channel-type="group.type"><span>{{ group.label }}</span><strong>{{ group.count }}</strong><small>{{ group.enabled }} 启用 · {{ group.count - group.enabled }} 停用</small></RouterLink>
    </div>
    <div class="overview-secondary-grid">
      <article id="disk-information" class="dashboard-card">
        <div class="section-heading"><h2>数据目录磁盘</h2><span class="subtle-pill">{{ percentage(runtime.disk?.usagePercent) }}</span></div>
        <template v-if="runtime.disk">
          <div class="disk-capacity"><strong>{{ bytes(runtime.disk.usedBytes) }}</strong><span>/ {{ bytes(runtime.disk.totalBytes) }}</span></div>
          <progress :value="runtime.disk.usagePercent" max="100" aria-label="数据目录所在磁盘使用率"></progress>
          <dl class="resource-details"><div><dt>可用空间</dt><dd>{{ bytes(runtime.disk.availableBytes) }}</dd></div><div><dt>空闲（含保留）</dt><dd>{{ bytes(runtime.disk.freeBytes) }}</dd></div></dl>
        </template>
        <p v-else class="muted">当前环境无法读取磁盘容量。</p>
        <div class="directory-path"><span>管理数据目录</span><code>{{ runtime.dataDirectory || '不可用' }}</code></div>
        <p class="field-hint">容量统计为该目录所在文件系统，不是目录自身大小。</p>
      </article>
      <article id="network-information" class="dashboard-card">
        <div class="section-heading"><h2>网络接口</h2><span class="subtle-pill">{{ runtime.network.length }} 个</span></div>
        <div class="network-interface-list"><div v-for="entry in runtime.network" :key="entry.name" class="network-interface"><strong>{{ entry.name }}</strong><div><p v-for="address in entry.addresses" :key="address.address"><span>{{ address.family }}</span><code>{{ address.cidr || address.address }}</code></p></div></div><p v-if="!runtime.network.length" class="muted">没有可显示的非回环接口。</p></div>
      </article>
    </div>
    <div class="overview-secondary-grid">
      <article class="dashboard-card connection-summary">
        <div class="section-heading"><h2>连接通道</h2><button class="text-button new-channel" @click="openChannel()">＋ 新建</button></div>
        <div id="overview-channels"><div v-for="c in channels.slice(0, 4)" :key="c.id" class="mini-channel"><span>⇄</span><div>{{ c.name }}<small>{{ channelTypes[c.type] }} · {{ endpoint(c) }}</small></div><StatusPill :status="c.status.state" /></div><div v-if="!channels.length" class="empty-mini"><p>暂无通道</p><button class="text-button new-channel" @click="openChannel()">新建连接</button></div></div>
        <RouterLink v-if="channels.length" class="text-button" to="/channels">全部通道（{{ channels.length }}） →</RouterLink>
      </article>
      <article class="dashboard-card activity-card">
        <div class="section-heading"><h2>最近日志</h2><RouterLink class="text-button" to="/logs">查看全部 →</RouterLink></div>
        <div v-for="(item, index) in [...(state.data!.logs || [])].reverse()" :key="item.time + '-' + index" class="activity-row"><time>{{ item.time.slice(11, 19) }}</time><span :class="'recent-log-' + item.level"><b>[{{ item.scope }}]</b> {{ item.message }}</span></div>
        <p v-if="!state.data!.logs?.length" class="muted">暂无日志</p>
      </article>
    </div>
    <details class="metrics-help"><summary>指标说明</summary><p>系统指标反映运行环境可见的资源；容器中可能显示宿主机或虚拟机总量。MeloFox 主进程与 Chromium 进程组分别统计。Chromium 包含本实例报告的浏览器、渲染器、GPU 和工具进程；常驻内存为各进程 RSS 之和，共享页可能重复计入。</p><p>进程 CPU 按单个逻辑核心计量，可超过 100%。新建或退出进程的当次采样标记为部分数据。内存的 ArrayBuffer 包含在外部内存中；环境内存限制与系统总量分别展示。不可读取的指标显示为“—”。通道总数等于就绪、等待、异常、停用四类之和。</p></details>
    </template>
  </section>
</template>
<style scoped>
.overview-dashboard { display:grid; gap:20px; }
.overview-sampling { display:flex; align-items:center; flex-wrap:wrap; gap:8px; color:var(--muted); font-size:var(--text-14); margin-top:-8px; }
.overview-sampling > span:last-child { margin-left:auto; }
.sampling-dot { width:7px; height:7px; border-radius:50%; background:var(--positive-text); }
.stale .sampling-dot { background:var(--warning-text); }
.stale { color:var(--warning-text); }
.overview-primary-grid { display:grid; grid-template-columns:minmax(290px,.9fr) minmax(0,1.65fr); gap:20px; align-items:stretch; }
.overview-information, .overview-resources { display:grid; gap:20px; min-width:0; }
.overview-information, .overview-resources { grid-template-rows:auto 1fr; }
#system-information { display:flex; flex-direction:column; }
#system-information .overview-details { flex:1; align-content:space-between; }
.resource-card { display:flex; flex-direction:column; }
.resource-card .resource-main { flex:1; }
.dashboard-card { min-width:0; padding:20px; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); }
.dashboard-card .section-heading { margin-bottom:16px; }
.dashboard-card .section-heading h2 { color:var(--ink); font-size:var(--text-18); }
.metric-label, dt { color:var(--muted); font-size:var(--text-14); }
dd { margin:0; color:var(--ink); font-size:var(--text-14); overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.overview-account { display:grid; grid-template-columns:52px minmax(0,1fr) auto; align-items:center; gap:14px; }
.overview-account h2 { font-size:var(--text-22); margin:3px 0 4px; overflow-wrap:anywhere; }
.overview-account p { color:var(--muted); font-size:var(--text-14); overflow-wrap:anywhere; }
.overview-session-status { display:flex; flex-wrap:wrap; gap:8px 18px; grid-column:1/-1; border-top:1px solid var(--line); padding-top:14px; color:var(--muted); font-size:var(--text-14); }
.status-good { color:var(--positive-text); }
.overview-details { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:10px 16px; line-height:1.5; }
.overview-extra { border-top:1px solid var(--line); padding-top:12px; margin-top:16px; font-size:var(--text-14); }
summary { color:var(--secondary-text); cursor:pointer; }
.overview-extra .overview-details, .core-grid { margin-top:18px; }
.resource-main { display:flex; gap:24px; align-items:center; }
.resource-copy { min-width:0; flex:1; }
.cpu-model { line-height:1.5; font-weight:600; overflow-wrap:anywhere; margin-bottom:12px; }
.resource-details { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 18px; }
.resource-details dd { margin-top:6px; font-size:var(--text-16); }
.resource-details dd small { display:block; font-size:var(--text-14); color:var(--muted); margin-top:4px; }
.core-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(125px,1fr)); gap:16px; max-height:300px; overflow:auto; }
.core-grid > div { display:grid; grid-template-columns:1fr auto; gap:8px; color:var(--muted); }
.core-grid strong { color:var(--ink); font-weight:500; }
progress { display:block; width:100%; height:7px; appearance:none; border:0; border-radius:10px; overflow:hidden; background:var(--surface-soft); color:var(--accent); }
progress::-webkit-progress-bar { background:var(--surface-soft); border-radius:10px; }
progress::-webkit-progress-value { background:var(--accent); border-radius:10px; }
progress::-moz-progress-bar { background:var(--accent); border-radius:10px; }
.core-grid progress { grid-column:1/-1; }
.memory-total { font-size:var(--text-28); font-weight:600; margin-bottom:16px; }
.memory-total span { font-size:var(--text-14); color:var(--muted); margin-left:5px; font-weight:400; }
.process-memory-details { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:14px; padding-top:16px; margin-top:18px; border-top:1px solid var(--line); }
.process-memory-details dd { margin-top:6px; font-weight:500; }
.overview-channel-stats { display:grid; grid-template-columns:1.3fr repeat(4,minmax(0,1fr)); gap:14px; }
.channel-stat { display:flex; min-width:0; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:19px 12px; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); transition:border-color .15s; }
.channel-stat:hover { border-color:var(--accent); }
.channel-stat > span, .channel-stat small { font-size:var(--text-14); color:var(--muted); text-align:center; }
.channel-stat strong { font-size:var(--text-32); color:var(--ink); line-height:1.2; font-variant-numeric:tabular-nums; }
.total-channel-stat { background:var(--accent-soft); border-color:var(--accent-soft); }
.total-channel-stat strong { color:var(--accent); }
#stat-channels-note { display:grid; grid-template-columns:repeat(2,max-content); gap:5px 16px; }
.overview-secondary-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; }
.disk-capacity { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; margin:24px 0 16px; }
.disk-capacity strong { font-size:var(--text-24); font-weight:600; }
.disk-capacity span { color:var(--muted); font-size:var(--text-14); }
#disk-information > .resource-details { margin-top:20px; }
.directory-path { display:grid; gap:8px; margin:24px 0 14px; font-size:var(--text-14); }
.directory-path > span { color:var(--muted); }
.directory-path code { padding:10px 12px; background:var(--surface-soft); border-radius:8px; overflow-wrap:anywhere; }
.monospace, code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
.network-interface-list { max-height:245px; overflow:auto; padding-right:6px; }
.network-interface { display:grid; grid-template-columns:75px minmax(0,1fr); gap:14px; border-bottom:1px solid var(--line); padding:12px 0; font-size:var(--text-14); }
.network-interface:first-child { padding-top:0; }
.network-interface:last-child { border-bottom:0; }
.network-interface > strong { overflow-wrap:anywhere; font-weight:500; }
.network-interface p { display:flex; align-items:baseline; gap:10px; margin-bottom:7px; }
.network-interface p:last-child { margin-bottom:0; }
.network-interface p span { color:var(--muted); flex-shrink:0; }
.network-interface code { overflow-wrap:anywhere; }
.recent-log-error, .recent-log-fatal { color:var(--error-text); }
.recent-log-warn { color:var(--warning-text); }
.activity-row b { font-weight:500; }
.activity-row { grid-template-columns:85px minmax(0,1fr); font-size:var(--text-14); }
.metrics-help { font-size:var(--text-14); color:var(--muted); }
.metrics-help p { margin-top:10px; line-height:1.7; }
@media (min-width:1600px) { .overview-primary-grid { grid-template-columns:minmax(330px,1fr) minmax(0,2fr); } .resource-main { gap:40px; } }
@media (max-width:1150px) {
  .overview-primary-grid { grid-template-columns:1fr; }
  .overview-information { grid-template-columns:1fr; }
  .overview-details { grid-template-columns:max-content minmax(0,1fr) max-content minmax(0,1fr); }
}
@media (max-width:760px) {
  .overview-dashboard, .overview-primary-grid, .overview-information, .overview-resources, .overview-secondary-grid { gap:16px; }
  .dashboard-card { padding:18px; }
  .overview-sampling > span:last-child { width:100%; margin:0; }
  .overview-details { grid-template-columns:max-content minmax(0,1fr); }
  .overview-secondary-grid { grid-template-columns:1fr; }
  .overview-channel-stats { grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
  .total-channel-stat { grid-column:1/-1; }
  .channel-stat { padding:15px 12px; }
  .network-interface { grid-template-columns:60px minmax(0,1fr); }
  .process-memory-details { grid-template-columns:repeat(3,minmax(0,1fr)); }
}
@media (max-width:480px) {
  .resource-main { flex-direction:column-reverse; gap:18px; align-items:stretch; }
  .resource-main :deep(.usage-ring) { align-self:center; }
  .resource-details { gap:16px; }
  .process-memory-details { grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
}
</style>
