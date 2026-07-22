<template>
  <div class="log-panel">
    <div class="heading">
      <div>
        <p class="kicker">系统事件</p>
        <h2>运行日志</h2>
      </div>
      <span class="count">{{ logs.length }}</span>
    </div>
    <div class="log-box" aria-live="polite">
      <div v-if="!logs.length" class="empty">等待系统事件…</div>
      <div v-for="(line, i) in logs" :key="i" class="log-line">{{ line }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ logs: string[] }>();
</script>

<style scoped>
.heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.kicker { color: #6db8d7; font-size: 10px; font-weight: 700; letter-spacing: 1.2px; }
h2 { font-size: 17px; margin-top: 3px; letter-spacing: -.25px; }
.count { min-width: 24px; padding: 3px 7px; border-radius: 99px; text-align: center; color: #8bc4dd; background: #13334c; font: 11px ui-monospace, monospace; }
.log-box { min-height: 170px; max-height: 290px; overflow-y: auto; padding: 9px; border: 1px solid #213a52; border-radius: 9px; background: #091522; color: #9db2c5; font: 11px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; }
.log-line { padding: 2px 0; border-bottom: 1px solid rgba(83, 112, 139, .16); word-break: break-word; }.log-line:last-child { border-bottom: 0; }
.empty { color: #5e768c; padding: 18px 4px; text-align: center; }
</style>
