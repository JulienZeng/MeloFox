<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps<{ src?: string; name?: string }>();
const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });
</script>
<template>
  <span class="account-avatar">
    <img v-if="src && !failed" :src="src" :alt="(name || '抖音账号') + '的头像'" referrerpolicy="no-referrer" @error="failed = true" />
    <span v-else role="img" aria-label="默认账号头像">{{ name ? Array.from(name)[0] : '◎' }}</span>
  </span>
</template>
<style scoped>
.account-avatar { display:grid; place-items:center; width:52px; height:52px; flex-shrink:0; border-radius:16px; background:var(--accent-soft); color:var(--accent); font-size:var(--text-24); overflow:hidden; }
.account-avatar img { display:block; width:100%; height:100%; object-fit:cover; }
</style>
