<template>
  <div class="mujoco-view">
    <div class="view-heading">
      <div>
        <p class="kicker">实时镜像</p>
        <h2>MuJoCo 仿真画面</h2>
      </div>
      <span class="live"><i></i>{{ frame ? "LIVE" : "WAITING" }}</span>
    </div>
    <div class="video-box">
      <img v-if="frame" :src="`data:image/jpeg;base64,${frame}`" alt="MuJoCo" />
      <span v-else class="placeholder">等待遥操作画面…<small>启动后将在这里实时显示从臂姿态</small></span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  frame: string | null;
}>();
</script>

<style scoped>
.view-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.kicker { color: #6db8d7; font-size: 10px; font-weight: 700; letter-spacing: 1.2px; }
h2 { font-size: 18px; margin-top: 3px; letter-spacing: -0.25px; }
.live { color: #8ba6ba; font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: .8px; }
.live i { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #75899b; }
.live:has(i) { color: #8ba6ba; }
.video-box {
  background: linear-gradient(135deg, #07111d, #0a1c2d);
  border: 1px solid #223e56;
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 430px;
  position: relative;
}
.video-box img {
  width: 100%;
  height: 100%;
  max-height: 72vh;
  object-fit: contain;
  display: block;
}
.placeholder {
  color: #8aa0b3;
  font-size: 14px;
  text-align: center;
}
.placeholder small { display: block; margin-top: 8px; color: #597288; font-size: 12px; }
@media (max-width: 760px) { .video-box { min-height: 260px; } }
</style>
