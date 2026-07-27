<template>
  <div class="recording-panel">
    <div class="heading">
      <div><p class="kicker">DATA CAPTURE</p><h2>数据集录制</h2></div>
      <span class="state" :class="recording.state"><i></i>{{ stateText }}</span>
    </div>

    <template v-if="!active">
      <label>数据集名称<input v-model.trim="form.dataset" :disabled="busy" placeholder="so101_pick_cube" maxlength="64" /></label>
      <label>任务描述<input v-model.trim="form.task" :disabled="busy" placeholder="抓取方块并放入盒中" maxlength="200" /></label>
      <label>录制帧率
        <select v-model.number="form.fps" :disabled="busy">
          <option :value="10">10 FPS</option><option :value="15">15 FPS</option><option :value="30">30 FPS</option>
        </select>
      </label>
      <div class="capture-grid">
        <label>计划组数<input v-model.number="form.plannedEpisodes" type="number" min="1" max="10000" /></label>
        <label>单轮时长（秒）<input v-model.number="form.episodeTime" type="number" min="1" max="3600" /></label>
        <label>复位时间（秒）<input v-model.number="form.resetTime" type="number" min="0" max="3600" /></label>
      </div>
      <label class="resume"><input v-model="form.resume" type="checkbox" /> 续录到已有同名数据集</label>
      <p class="camera-note">双摄像头应连接不同 USB HUB · MJPG 640×360@30 FPS</p>
      <p v-if="recording.error" class="error">{{ recording.error }}</p>
      <p v-else-if="recording.path && recording.frames" class="saved">Episode {{ recording.episode ?? "-" }} 已保存 · {{ recording.frames }} 帧</p>
      <button class="record" :disabled="!running || busy || !valid" @click="$emit('start', { ...form })"><span>●</span>开始录制</button>
    </template>

    <template v-else>
      <div class="counter"><strong>{{ recording.frames }}</strong><span>帧</span><small>{{ recording.fps }} FPS · Episode {{ recording.episode ?? "准备中" }} · {{ elapsed }} / {{ recording.episodeTime }} 秒</small></div>
      <p class="task">{{ recording.task }}</p>
      <div class="actions">
        <button class="discard" :disabled="recording.state === 'saving' || busy" @click="$emit('cancel')">丢弃</button>
        <button class="save" :disabled="recording.state !== 'recording' || busy" @click="$emit('stop')">{{ recording.state === "saving" ? "正在保存…" : "停止并保存" }}</button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";
import type { RecordingStatus } from "../composables/useWebSocket";

const props = defineProps<{ recording: RecordingStatus; running: boolean; busy: boolean }>();
defineEmits<{
  start: [config: { dataset: string; task: string; fps: number; plannedEpisodes: number; episodeTime: number; resetTime: number; resume: boolean }];
  stop: [];
  cancel: [];
}>();

const form = reactive({ dataset: "so101_dataset", task: "", fps: 30, plannedEpisodes: 10, episodeTime: 20, resetTime: 5, resume: false });
const active = computed(() => ["preparing", "recording", "saving"].includes(props.recording.state));
const valid = computed(() => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(form.dataset) && form.task.length > 0);
const elapsed = computed(() => Math.floor(props.recording.frames / Math.max(1, props.recording.fps)));
const stateText = computed(() => ({ idle: "待机", preparing: "准备中", recording: "录制中", saving: "保存中", error: "异常" })[props.recording.state]);
</script>

<style scoped>
.recording-panel { display: flex; flex-direction: column; gap: 11px; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
.kicker { color: #d2a85e; font-size: 10px; font-weight: 700; letter-spacing: 1.2px; }
h2 { margin-top: 3px; font-size: 17px; }
.state { display: flex; align-items: center; gap: 5px; color: #8399aa; font-size: 10px; }
.state i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.state.recording { color: #ff7384; }
.state.recording i { animation: pulse 1s ease-in-out infinite; }
.state.preparing, .state.saving { color: #f0c76a; }
.state.error, .error { color: #ff9aaa; }
label { display: grid; gap: 4px; color: #afc0d2; font-size: 11px; }
input, select { width: 100%; padding: 8px; border: 1px solid #29435f; border-radius: 7px; outline: none; background: #0a1728; color: #edf5ff; font-size: 12px; }
input:focus, select:focus { border-color: #5a8bad; }
button { min-height: 36px; border: 0; border-radius: 7px; cursor: pointer; font-weight: 650; }
button:disabled { cursor: default; opacity: .45; }
.record { margin-top: 2px; color: #fff; background: #b63f52; }
.record span { margin-right: 6px; }
.counter { display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 4px 7px; padding: 12px; border: 1px solid rgba(255, 115, 132, .22); border-radius: 7px; background: #171823; }
.counter strong { color: #fff; font: 700 28px/1 ui-monospace, monospace; }
.counter span { color: #9fb0bf; font-size: 11px; }
.counter small { grid-column: 1 / -1; color: #71889b; font-size: 10px; }
.task, .saved, .error { overflow-wrap: anywhere; font-size: 10px; line-height: 1.45; }
.capture-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 5px; }.capture-grid label { font-size: 9px; }.resume { display: flex; grid-template-columns: auto 1fr; align-items: center; gap: 6px; }.resume input { width: auto; }.camera-note { padding: 6px 7px; border-left: 2px solid #d2a85e; background: #211d18; color: #a99570; font-size: 8px; line-height: 1.4; }
.task { color: #9eb0bf; }
.saved { color: #69d7a3; }
.actions { display: grid; grid-template-columns: .8fr 1.4fr; gap: 7px; }
.discard { color: #d0dae2; background: #344252; }
.save { color: #101820; background: #edc05f; }
@keyframes pulse { 50% { opacity: .25; } }
</style>
