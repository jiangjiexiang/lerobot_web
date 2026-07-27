<template>
  <div class="status-bar">
    <div class="connection">
      <div class="dot" :class="{ on: connected, run: running }"></div>
      <span class="status-text">{{ running ? "遥操作运行中" : connected ? "已连接，待机" : "未连接" }}</span>
    </div>
    <div class="metrics">
      <span>控制 {{ metrics.controlFps }} FPS / {{ formatLatency(metrics.controlLatency) }}</span>
      <span>视频1 {{ metrics.cameraFps }} FPS / {{ formatLatency(metrics.cameraLatency) }} / 丢{{ metrics.cameraDropped }}</span>
      <span>视频2 {{ metrics.camera2Fps }} FPS / {{ formatLatency(metrics.camera2Latency) }} / 丢{{ metrics.camera2Dropped }}</span>
      <span :class="metrics.streamConnected ? 'ok' : 'bad'">视频WS {{ metrics.streamConnected ? '正常' : '断开' }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { DebugMetrics } from "../composables/useWebSocket";

defineProps<{
  connected: boolean;
  running: boolean;
  metrics: DebugMetrics;
}>();

const formatLatency = (value: number | null) => value === null ? "-- ms" : `${value} ms`;
</script>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;
}
.connection { display: flex; align-items: center; gap: 8px; }
.metrics { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.metrics span { padding: 4px 7px; border-radius: 6px; background: #101e30; color: #8fa9bd; font: 10px/1.2 ui-monospace, monospace; }
.metrics .ok { color: #69d7a3; }
.metrics .bad { color: #ff9aaa; }
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
@media (max-width: 900px) { .status-bar { justify-content: flex-start; } }
@media (max-width: 560px) {
  .status-bar { width: 100%; gap: 7px; }
  .status-text { font-size: 10px; }
  .metrics { justify-content: flex-start; gap: 4px; }
  .metrics span { padding: 3px 5px; font-size: 8px; }
}
</style>
