<template>
  <div class="recording-panel">
    <div class="heading">
      <div><h2>数据录制</h2></div>
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
      <p v-if="recording.error" class="error">{{ recording.error }}</p>
      <p v-else-if="recording.path && recording.frames" class="saved">片段 {{ recording.episode ?? "-" }} 已保存 · {{ recording.frames }} 帧</p>
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
.recording-panel { display: flex; flex-direction: column; gap: 13px; padding: 18px; }
.heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: -18px -18px 2px; padding: 17px 18px; border-bottom: 1px solid #e5e6e6; }
h2 { color: #292b2e; font-size: 16px; }
.state { display: flex; align-items: center; gap: 5px; padding: 5px 9px; border-radius: 12px; color: #777b7e; background: #f0f1f1; font-size: 10px; font-weight: 650; }
.state i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.state.recording { color: #fff; background: #f04d52; }
.state.recording i { animation: pulse 1s ease-in-out infinite; }
.state.preparing, .state.saving { color: #a46b17; background: #fff5df; }
.state.error, .error { color: #c9363b; }
label { display: grid; gap: 5px; color: #616568; font-size: 12px; font-weight: 600; }
input, select { width: 100%; padding: 10px; border: 1px solid #dedfe0; border-radius: 5px; outline: none; background: #fff; color: #27292b; font-size: 13px; }
input:focus, select:focus { border-color: #75b99f; box-shadow: 0 0 0 3px rgba(66, 167, 129, .1); }
button { min-height: 36px; border: 0; border-radius: 7px; cursor: pointer; font-weight: 650; }
button:disabled { cursor: default; opacity: .45; }
.record { margin-top: 3px; min-height: 44px; color: #fff; background: #f04d52; font-size: 14px; }
.record:hover:not(:disabled) { background: #db3d43; }
.record span { margin-right: 6px; }
.counter { display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 4px 7px; padding: 12px; border: 1px solid #f2c9ca; border-radius: 5px; background: #fff8f8; }
.counter strong { color: #d63f44; font: 700 28px/1 ui-monospace, monospace; }
.counter span { color: #777b7e; font-size: 11px; }
.counter small { grid-column: 1 / -1; color: #85898c; font-size: 10px; }
.task, .saved, .error { overflow-wrap: anywhere; font-size: 10px; line-height: 1.45; }
.capture-grid { display: grid; grid-template-columns: repeat(3,1fr); gap: 7px; }.capture-grid label { font-size: 10px; }.resume { display: flex; grid-template-columns: auto 1fr; align-items: center; gap: 6px; }.resume input { width: auto; }.camera-note { padding: 7px 8px; border-left: 2px solid #68b693; background: #f3faf7; color: #52866f; font-size: 9px; line-height: 1.4; }
.task { color: #5e6265; }.saved { color: #258260; }
.actions { display: grid; grid-template-columns: .8fr 1.4fr; gap: 7px; }
.discard { color: #55595c; background: #eaebeb; }.save { color: #fff; background: #f04d52; }
@keyframes pulse { 50% { opacity: .25; } }
</style>
