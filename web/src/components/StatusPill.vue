<script setup lang="ts">
import { healthy, statuses } from "../presentation";
defineProps<{ status: string }>();
</script>
<template>
  <span class="status-pill" :class="{ offline: !healthy(status) }">{{
    statuses[status] || status
  }}</span>
</template>
