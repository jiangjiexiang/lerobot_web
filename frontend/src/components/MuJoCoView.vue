<template>
  <div class="mujoco-view">
    <div class="view-heading">
      <div>
        <p class="kicker">{{ kicker }}</p>
        <h2>{{ title }}</h2>
      </div>
      <span class="live" :class="{ active: hasImage }"><i></i>{{ hasImage ? liveText : waitText }}</span>
    </div>
    <div class="video-box">
      <img v-if="frame || fallbackSrc" :src="frame || fallbackSrc" :alt="title" @load="fallbackLoaded = true" @error="fallbackLoaded = false" />
      <span v-else class="placeholder">{{ placeholder }}<small>{{ hint }}</small></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = withDefaults(defineProps<{
  frame: string | null;
  fallbackSrc?: string;
  kicker?: string;
  title?: string;
  placeholder?: string;
  hint?: string;
  liveText?: string;
  waitText?: string;
}>(), {
  kicker: "实时镜像",
  title: "MuJoCo 仿真画面",
  placeholder: "等待遥操作画面…",
  hint: "启动后将在这里实时显示从臂姿态",
  liveText: "LIVE",
  waitText: "WAITING",
});

const fallbackLoaded = ref(false);
const hasImage = computed(() => Boolean(props.frame) || fallbackLoaded.value);
</script>

<style scoped>
.view-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.kicker { color: #6db8d7; font-size: 10px; font-weight: 700; letter-spacing: 1.2px; }
h2 { font-size: 18px; margin-top: 3px; letter-spacing: -0.25px; }
.live { color: #8ba6ba; font-family: ui-monospace, monospace; font-size: 11px; letter-spacing: .8px; }
.live i { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: #75899b; }
.live.active { color: #90e7c1; }
.live.active i { background: #3ed58e; box-shadow: 0 0 9px #3ed58e; }
.video-box {
  background: linear-gradient(135deg, #07111d, #0a1c2d);
  border: 1px solid #223e56;
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 360px;
  aspect-ratio: 4 / 3;
  position: relative;
}
.video-box img {
  width: 100%;
  height: auto;
  height: 100%;
  max-height: 58vh;
  object-fit: contain;
  display: block;
}
.placeholder {
  color: #8aa0b3;
  font-size: 14px;
  text-align: center;
}
.placeholder small { display: block; margin-top: 8px; color: #597288; font-size: 12px; }

@media (max-width: 1100px) { .video-box { min-height: 320px; } }
@media (max-width: 760px) { .video-box { min-height: 220px; } }
</style>
