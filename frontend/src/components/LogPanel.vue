<template>
  <div class="console-panel">
    <div class="console-header">
      <div class="console-title">
        <span class="console-dot"></span>
        <h2>运行日志</h2>
      </div>
      <span class="console-count">{{ logs.length }}</span>
    </div>
    <div class="console-body" ref="logContainer" aria-live="polite">
      <div v-if="!logs.length" class="empty">等待系统事件…</div>
      <div v-for="(line, i) in logs" :key="i" class="console-line">{{ line }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from "vue";

const props = defineProps<{ logs: string[] }>();
const logContainer = ref<HTMLElement | null>(null);

watch(() => props.logs.length, async () => {
  await nextTick();
  if (logContainer.value) {
    logContainer.value.scrollTop = logContainer.value.scrollHeight;
  }
});
</script>

<style scoped>
.console-panel {
  background: rgba(6, 14, 25, 0.95);
  border: 1px solid rgba(120, 160, 200, 0.12);
  border-radius: 12px;
  overflow: hidden;
}
.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid rgba(120, 160, 200, 0.08);
  background: rgba(8, 18, 32, 0.6);
}
.console-title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.console-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3ed58e;
  box-shadow: 0 0 6px #3ed58e;
}
.console-title h2 {
  font-size: 12px;
  font-weight: 600;
  color: #b0c8dd;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.console-count {
  min-width: 22px;
  padding: 2px 8px;
  border-radius: 99px;
  text-align: center;
  color: #8bc4dd;
  background: #0f2640;
  font: 11px/1.5 ui-monospace, monospace;
}
.console-body {
  max-height: 160px;
  overflow-y: auto;
  padding: 8px 16px;
  color: #9db2c5;
  font: 12px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  scrollbar-width: thin;
  scrollbar-color: #1a3a58 transparent;
}
.console-body::-webkit-scrollbar { width: 5px; }
.console-body::-webkit-scrollbar-track { background: transparent; }
.console-body::-webkit-scrollbar-thumb { background: #1a3a58; border-radius: 3px; }
.console-line {
  padding: 1px 0;
  word-break: break-word;
  border-bottom: 1px solid rgba(83, 112, 139, 0.08);
}
.console-line:last-child { border-bottom: 0; }
.empty { color: #4a6880; padding: 12px 0; text-align: center; font-style: italic; }
</style>
