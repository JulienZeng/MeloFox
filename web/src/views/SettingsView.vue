<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { onBeforeRouteLeave, RouterLink } from 'vue-router';
import { useConsole } from '../console';
import { errorMessage, isCancelled } from '../api';
import CredentialForm from '../components/CredentialForm.vue';
import { settingsGroups, type SettingsField, type SettingsSnapshot, type RuntimeSettings } from '../../../src/config/settings-contracts';

const { api, state, toast } = useConsole();
const snapshot = ref<SettingsSnapshot>(), draft = ref<RuntimeSettings>();
const tab = ref('messages'), loading = ref(false), saving = ref(false), error = ref('');
const savedValues = ref('');
let active = true;
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== savedValues.value);
const group = computed(() => settingsGroups.find(item => item.id === tab.value));
const tabs = [...settingsGroups.map(item => ({ id: item.id, title: item.title })), { id: 'account', title: '管理账号' }, { id: 'deployment', title: '部署信息' }];
function accept(value: SettingsSnapshot) {
  snapshot.value = value;
  draft.value = JSON.parse(JSON.stringify(value.values)) as RuntimeSettings;
  savedValues.value = JSON.stringify(value.values);
}
async function load() {
  if (loading.value || saving.value) return;
  loading.value = true; error.value = '';
  try {
    const value = await api.request<SettingsSnapshot>('/api/settings');
    if (active) accept(value);
  } catch (failure) { if (active && !isCancelled(failure)) error.value = errorMessage(failure); }
  finally { if (active) loading.value = false; }
}
function valueAt(path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], draft.value);
}
function display(field: SettingsField): string | number {
  const value = valueAt(field.path);
  return Array.isArray(value) ? value.join('\n') : typeof value === 'number' ? value : String(value ?? '');
}
function update(field: SettingsField, event: Event) {
  if (!draft.value) return;
  const input = event.target as HTMLInputElement;
  const keys = field.path.split('.');
  let target = draft.value as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = field.kind === 'boolean' ? input.checked
    : field.kind === 'number' && input.value !== '' ? Number(input.value)
    : field.kind === 'lines' ? input.value.split('\n') : input.value;
}
function revert() {
  if (snapshot.value) accept(snapshot.value);
  error.value = '';
}
async function save() {
  if (!snapshot.value || !draft.value || saving.value) return;
  error.value = '';
  for (const item of settingsGroups) for (const field of item.fields) {
    const value = valueAt(field.path);
    if (field.kind === 'number' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < field.min! || value > field.max!)) {
      tab.value = item.id;
      error.value = `${field.label}须为 ${field.min}–${field.max} 之间的整数`;
      return;
    }
  }
  const values: RuntimeSettings = JSON.parse(JSON.stringify(draft.value));
  values.runtime.fileSendAllowedDirs = values.runtime.fileSendAllowedDirs.map(value => value.trim()).filter(Boolean);
  saving.value = true;
  try {
    const result = await api.request<SettingsSnapshot>('/api/settings', {
      method: 'PUT', body: JSON.stringify({ revision: snapshot.value.revision, values }),
    });
    if (active) {
      accept(result);
      toast(result.restartRequired ? '设置已保存，重启 MeloFox 后生效' : '设置已保存');
    }
  } catch (failure) { if (active && !isCancelled(failure)) error.value = errorMessage(failure); }
  finally { if (active) saving.value = false; }
}
const deploymentRows = computed(() => {
  const value = snapshot.value?.deployment;
  return value ? [
    ['配置文件', value.settingsFile], ['管理台监听', `${value.webHost}:${value.webPort}`],
    ['管理数据目录', value.consoleDirectory], ['浏览器资料目录', value.browserDirectory],
    ['浏览器模式', value.browserHeadless ? '无头模式' : '有头模式'],
    ['媒体缓存目录', value.mediaDirectory], ['消息缓存目录', value.messageDirectory],
    ['版本', `MeloFox ${state.data?.runtime.version ?? '—'}`], ['协议', 'OneBot 11'],
    ['平台', `${state.data?.runtime.platform ?? '—'} / ${state.data?.runtime.arch ?? '—'}`],
    ['Node.js', state.data?.runtime.nodeVersion ?? '—'],
  ] : [];
});
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ''; } }
onBeforeRouteLeave(() => !dirty.value || window.confirm('还有未保存的设置，确定离开？'));
onMounted(() => { void load(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => { active = false; window.removeEventListener('beforeunload', beforeUnload); });
</script>

<template>
  <section id="settings-view" class="view settings-page">
    <div class="settings-intro">
      <p class="muted">运行参数保存后重启 MeloFox 生效。通道地址、令牌与开关在 <RouterLink to="/channels">网络配置</RouterLink> 中管理。</p>
      <div class="settings-actions">
        <button type="button" class="secondary" :disabled="loading || saving || dirty" @click="load">{{ loading ? '加载中…' : '重新加载' }}</button>
        <button type="button" class="secondary" :disabled="loading || saving || state.authBusy || dirty || !snapshot" :title="dirty ? '请先保存或撤销修改' : undefined" @click="state.restartDialog = true">重启服务</button>
      </div>
    </div>
    <p v-if="snapshot?.restartRequired" class="notice" role="status">有已保存的设置尚未生效，点击「重启服务」应用。{{ dirty ? '请先保存或撤销当前修改。' : '' }}</p>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分类">
        <button v-for="item in tabs" :key="item.id" type="button" :class="{ active: tab === item.id }" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id">{{ item.title }}</button>
      </nav>
      <div class="settings-content">
        <article v-if="tab === 'account'" class="settings-card"><div class="section-heading"><h2>管理账号</h2></div><p class="muted">修改后其他登录会话将失效。</p><CredentialForm /></article>
        <article v-else-if="tab === 'deployment'" class="settings-card">
          <div class="section-heading"><h2>部署信息</h2></div>
          <p class="muted">监听地址、数据目录与浏览器模式在首次启动时确定。容器端口映射、数据卷与资源限制由 Compose 管理。</p>
          <dl class="settings-deployment"><template v-for="[label, value] in deploymentRows" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></template></dl>
        </article>
        <form v-else-if="draft && group" class="settings-card runtime-settings-form" novalidate @submit.prevent="save">
          <div class="section-heading"><h2>{{ group.title }}</h2></div>
          <fieldset :disabled="saving || loading">
            <div v-for="field in group.fields" :key="field.path" class="setting-field" :class="{ 'setting-switch': field.kind === 'boolean' }">
              <label :for="'setting-' + field.path">{{ field.label }}<span v-if="field.unit" class="setting-unit">{{ field.unit }}</span></label>
              <input v-if="field.kind === 'boolean'" :id="'setting-' + field.path" type="checkbox" role="switch" :checked="valueAt(field.path) === true" :aria-describedby="'hint-' + field.path" @change="update(field, $event)" />
              <select v-else-if="field.kind === 'select'" :id="'setting-' + field.path" :value="display(field)" :aria-describedby="'hint-' + field.path" @change="update(field, $event)"><option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
              <textarea v-else-if="field.kind === 'lines'" :id="'setting-' + field.path" :value="display(field)" rows="4" spellcheck="false" :aria-describedby="'hint-' + field.path" @input="update(field, $event)" />
              <input v-else :id="'setting-' + field.path" :type="field.kind === 'number' ? 'number' : field.kind === 'password' ? 'password' : 'text'" :value="display(field)" :min="field.min" :max="field.max" :step="field.kind === 'number' ? 1 : undefined" :autocomplete="field.kind === 'password' ? 'new-password' : 'off'" :aria-describedby="'hint-' + field.path" @input="update(field, $event)" />
              <p :id="'hint-' + field.path" class="field-hint">{{ field.hint }}</p>
            </div>
          </fieldset>
          <div class="settings-save-bar"><span class="muted">{{ dirty ? '有未保存的修改，请先保存再重启' : '已与保存的设置同步' }}</span><button type="button" class="secondary" :disabled="!dirty || saving" @click="revert">撤销修改</button><button class="primary" type="submit" :disabled="!dirty || saving">{{ saving ? '保存中…' : '保存设置' }}</button></div>
        </form>
        <article v-else class="settings-card"><p class="muted">{{ loading ? '正在加载设置…' : '设置尚未加载，请重试。' }}</p></article>
        <p v-if="error" class="error-text settings-error" role="alert">{{ error }}</p>
      </div>
    </div>
  </section>
</template>
