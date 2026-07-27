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
  title: "仿真画面",
  placeholder: "等待遥操作画面…",
  hint: "启动后将在这里实时显示从臂姿态",
  liveText: "实时",
  waitText: "等待",
});

const fallbackLoaded = ref(false);
const hasImage = computed(() => Boolean(props.frame) || fallbackLoaded.value);
</script>

<style scoped>
.mujoco-view { min-width: 0; container-type: inline-size; }
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
  width: 100%;
  min-width: 0;
  aspect-ratio: 16 / 9;
  position: relative;
}
.video-box img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.placeholder {
  color: #8aa0b3;
  font-size: 14px;
  text-align: center;
}
.placeholder small { display: block; margin-top: 8px; color: #597288; font-size: 12px; }

@container (max-width: 300px) {
  .view-heading { align-items: flex-end; margin-bottom: 7px; }
  .kicker { display: none; }
  h2 { margin-top: 0; font-size: 12px; }
  .live { font-size: 8px; }
  .live i { width: 5px; height: 5px; margin-right: 3px; }
  .video-box { border-radius: 6px; }
  .placeholder { padding: 6px; font-size: 9px; }
  .placeholder small { display: none; }
}

@container (max-width: 190px) {
  h2 { font-size: 10px; }
  .live { font-size: 0; }
  .live i { margin-right: 0; }
}
</style>
