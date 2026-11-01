<script setup lang="ts">
import { useTheme } from "../composables/theme";
defineProps<{ name: string; label: string }>();
const { preference, setPreference } = useTheme();
</script>
<template>
  <div
    class="theme-control"
    role="radiogroup"
    :aria-label="label"
    data-theme-control
    :data-choice="preference"
  >
    <span class="theme-thumb" aria-hidden="true"></span>
    <label class="theme-option"
      ><input
        type="radio"
        :name="name"
        value="dark"
        :checked="preference === 'dark'"
        @change="setPreference('dark')"
        data-theme-option
        aria-label="暗色主题" />
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M20.4 13.5A8.6 8.6 0 0 1 10.5 3.6a8.6 8.6 0 1 0 9.9 9.9Z"
        /></svg
    ></label>
    <label class="theme-option"
      ><input
        type="radio"
        :name="name"
        value="system"
        :checked="preference === 'system'"
        @change="setPreference('system')"
        data-theme-option
        aria-label="跟随系统" />
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="3.5" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4.5V21" />
        <circle cx="12" cy="10" r="3" />
        <path d="M12 7a3 3 0 0 1 0 6Z" fill="currentColor" stroke="none" /></svg
    ></label>
    <label class="theme-option"
      ><input
        type="radio"
        :name="name"
        value="light"
        :checked="preference === 'light'"
        @change="setPreference('light')"
        data-theme-option
        aria-label="浅色主题" />
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        /></svg
    ></label>
  </div>
</template>
