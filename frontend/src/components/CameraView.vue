<template>
  <div class="camera-view">
    <div class="view-heading">
      <div>
        <p class="kicker">机器人视角</p>
        <h2>摄像头</h2>
      </div>
      <span class="live" :class="{ active: frame }"><i></i>{{ frame ? "LIVE" : "READY" }}</span>
    </div>
    <div class="video-box">
      <img v-if="frame" :src="`data:image/jpeg;base64,${frame}`" alt="机器人摄像头画面" />
      <span v-else class="placeholder">摄像头待接入<small>连接 USB 摄像头后在配置中启用</small></span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{ frame: string | null }>();
</script>

<style scoped>
.view-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.kicker { color: #a98bf5; font-size: 10px; font-weight: 700; letter-spacing: 1.2px; }
h2 { font-size: 18px; margin-top: 3px; letter-spacing: -.25px; }
.live { color: #7e94a7; font: 11px ui-monospace, monospace; letter-spacing: .8px; }
.live i { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #647789; }
.live.active { color: #90e7c1; }.live.active i { background: #3ed58e; box-shadow: 0 0 9px #3ed58e; }
.video-box { min-height: 240px; display: grid; place-items: center; overflow: hidden; border: 1px solid #2c3c5f; border-radius: 12px; background: linear-gradient(135deg, #0d1022, #171434); }
img { width: 100%; height: 100%; max-height: 42vh; object-fit: contain; display: block; }
.placeholder { color: #a8a3c6; text-align: center; font-size: 14px; }.placeholder small { display: block; margin-top: 8px; color: #6d7397; font-size: 12px; }
</style>
