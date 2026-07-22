<template>
  <div class="status-bar">
    <div class="dot" :class="{ on: connected, run: running }"></div>
    <span class="status-text">
      {{ running ? "遥操作运行中" : connected ? "已连接，待机" : "未连接" }}
    </span>
    <span class="clients" v-if="connected">· {{ clientCount }} 客户端</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  connected: boolean;
  running: boolean;
  clientCount?: number;
}>();
</script>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #555;
  transition: all 0.3s;
}
.dot.on {
  background: #4caf50;
  box-shadow: 0 0 8px #4caf50;
}
.dot.on.run {
  background: #e94560;
  box-shadow: 0 0 8px #e94560;
}
.status-text {
  font-size: 13px;
  color: #888;
}
.clients {
  font-size: 12px;
  color: #666;
}
</style>
