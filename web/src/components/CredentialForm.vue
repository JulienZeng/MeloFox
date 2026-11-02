<script setup lang="ts">
import { ref } from "vue";
import { useConsole } from "../console";
import { errorMessage, isCancelled } from "../api";
import { validateAuthForm } from "../form-validation";
const props = defineProps<{ initial?: boolean }>();
const store = useConsole(), { state } = store;
const changeUsername = ref(false), username = ref(state.auth?.username || "melofox");
const currentPassword = ref(""), newPassword = ref(""), confirmPassword = ref(""), error = ref("");
async function save(event: SubmitEvent) {
  if (state.authBusy) return;
  error.value = validateAuthForm(event.currentTarget as HTMLFormElement);
  if (error.value) return;
  if (!/\S/u.test(newPassword.value)) { error.value = "密码不能全为空格"; return; }
  if (newPassword.value !== confirmPassword.value) { error.value = "两次输入的新密码不一致"; return; }
  try {
    await store.updateCredentials({
      ...(changeUsername.value ? { username: username.value } : {}),
      ...(!props.initial ? { currentPassword: currentPassword.value } : {}),
      newPassword: newPassword.value, confirmPassword: confirmPassword.value,
    });
    currentPassword.value = newPassword.value = confirmPassword.value = "";
    username.value = state.auth?.username || "melofox";
    changeUsername.value = false;
  } catch (failure) { if (!isCancelled(failure)) error.value = errorMessage(failure); }
}
</script>
<template>
  <form id="credentials-form" class="credential-form" novalidate @submit.prevent="save">
    <p class="current-username">当前账号 <strong>{{ state.auth?.username }}</strong></p>
    <template v-if="!initial">
      <label for="current-password">当前密码</label>
      <input id="current-password" v-model="currentPassword" type="password" autocomplete="current-password" required maxlength="1024" :disabled="state.authBusy" />
    </template>
    <label for="new-password">新密码</label>
    <input id="new-password" v-model="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128" :disabled="state.authBusy" aria-describedby="password-requirements" />
    <p id="password-requirements" class="field-hint">8–128 位，不能与当前密码相同。</p>
    <label for="confirm-password">确认新密码</label>
    <input id="confirm-password" v-model="confirmPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128" :disabled="state.authBusy" />
    <label class="checkbox-label"><input id="change-username" v-model="changeUsername" type="checkbox" :disabled="state.authBusy" /><span>同时修改账号</span></label>
    <template v-if="changeUsername">
      <label for="new-username">新账号</label>
      <input id="new-username" v-model="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\-]{3,32}" data-format-message="账号需为 3–32 位字母、数字、下划线、点或短横线" :disabled="state.authBusy" aria-describedby="username-requirements" />
      <p id="username-requirements" class="field-hint">3–32 位字母、数字、下划线、点或短横线。</p>
    </template>
    <p id="credentials-error" class="error-text" role="alert">{{ error }}</p>
    <button id="save-credentials" class="primary" type="submit" :disabled="state.authBusy">{{ state.authBusy ? '保存中…' : initial ? '保存并进入控制台' : '保存修改' }}</button>
  </form>
</template>
