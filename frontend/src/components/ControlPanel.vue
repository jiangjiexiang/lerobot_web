<template>
  <div class="control-panel">
    <div class="section-heading">
      <div>
        <p class="kicker">设备控制</p>
        <h2>机械臂连接</h2>
      </div>
      <button class="btn-refresh" title="重新检测串口" @click="$emit('refresh')">↻</button>
    </div>

    <div class="form-group">
      <label>
        Follower 串口 <span>从臂</span>
      </label>
      <select v-model="local.followerPort">
        <option v-for="p in ports" :key="p" :value="p">{{ p }}</option>
      </select>
    </div>

    <div class="form-group">
      <label>Follower ID</label>
      <input v-model="local.followerId" placeholder="如 R12253102" />
    </div>

    <div class="form-group leader-mode">
      <label>控制来源</label>
      <div class="mode-options" role="group" aria-label="主臂连接方式">
        <button type="button" :class="{ active: local.controlMode === 'leader' }" @click="local.controlMode = 'leader'">Leader 串口</button>
        <button type="button" :class="{ active: local.controlMode === 'web' }" @click="local.controlMode = 'web'">网页 COM</button>
      </div>
      <small v-if="local.controlMode === 'web'" class="field-note">操作电脑使用 HTTPS 的 Chrome / Edge 连接 Leader COM。</small>
      <template v-else-if="local.controlMode === 'leader'">
        <label>Leader 串口 <span>主臂</span></label>
        <select v-model="local.leaderPort">
          <option v-for="p in ports" :key="p" :value="p">{{ p }}</option>
        </select>
      </template>
    </div>

    <div class="form-group">
      <label>Leader ID</label>
      <input v-model="local.leaderId" placeholder="如 R07253102" />
    </div>

    <div class="row2">
      <div class="form-group">
        <label>摄像头 1</label>
        <select :value="local.cameraIndex" @change="selectCamera('camera', Number(($event.target as HTMLSelectElement).value))">
          <option v-for="c in detectedCameras" :key="c" :value="c">/dev/video{{ c }} {{ c === local.cameraIndex ? '✓ 当前' : '' }}</option>
          <option v-if="!detectedCameras.length" disabled>未检测到摄像头</option>
        </select>
      </div>
      <div class="form-group">
        <label>摄像头 2</label>
        <select :value="local.camera2Index" @change="selectCamera('camera2', Number(($event.target as HTMLSelectElement).value))">
          <option v-for="c in detectedCameras" :key="c" :value="c">/dev/video{{ c }} {{ c === local.camera2Index ? '✓ 当前' : '' }}</option>
          <option v-if="!detectedCameras.length" disabled>未检测到摄像头</option>
        </select>
      </div>
    </div>

    <div class="row2">
      <div class="form-group">
        <label>控制刷新率 FPS</label>
        <select v-model.number="local.fps">
          <option :value="15">15</option>
          <option :value="30">30</option>
          <option :value="60">60</option>
        </select>
      </div>
    </div>

    <template v-if="local.controlMode === 'web'">
      <button class="btn btn-connect" :disabled="serialConnected" @click="$emit('connectLeader', { leaderId: local.leaderId, fps: local.fps })">
        {{ serialConnected ? "Leader COM 已连接" : "连接 Leader COM" }}
      </button>
      <button class="btn btn-disconnect" :disabled="!serialConnected" @click="$emit('disconnectLeader')">断开 Leader COM</button>
      <p v-if="serialError" class="serial-error">{{ serialError }}</p>
    </template>

    <button class="btn btn-start" :disabled="running || busy || (local.controlMode === 'web' && !serialConnected)" @click="$emit('start', { ...local, remoteLeader: local.controlMode === 'web', commandSource: local.controlMode })">
      {{ busy && !running ? "正在启动…" : running ? "遥操作运行中" : "启动遥操作" }}
    </button>
    <button class="btn btn-stop" :disabled="!running || busy" @click="$emit('stop')">
      {{ busy && running ? "正在停止…" : "停止遥操作" }}
    </button>

    <p class="hint">启动前请确认机械臂周围无障碍物。</p>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";

const props = defineProps<{
  ports: string[];
  detectedCameras: number[];
  activeCameras: { camera: number; camera2: number };
  running: boolean;
  busy: boolean;
  serialConnected: boolean;
  serialError: string | null;
}>();

const emit = defineEmits<{
  start: [config: Record<string, unknown>];
  stop: [];
  refresh: [];
  switchCamera: [config: { view: string; index: number }];
  swapCameraViews: [];
  connectLeader: [config: { leaderId: string; fps: number }];
  disconnectLeader: [];
}>();

const local = reactive({
  followerPort: "",
  followerId: "R12253102",
  leaderPort: "",
  leaderId: "R07253102",
  cameraIndex: 0,
  camera2Index: 0,
  fps: 60,
  controlMode: "leader" as "leader" | "web",
});

function selectCamera(view: "camera" | "camera2", index: number) {
  const previousIndex = view === "camera" ? local.cameraIndex : local.camera2Index;
  const otherIndex = view === "camera" ? local.camera2Index : local.cameraIndex;
  if (index === otherIndex) {
    if (view === "camera") {
      local.cameraIndex = index;
      local.camera2Index = previousIndex;
    } else {
      local.camera2Index = index;
      local.cameraIndex = previousIndex;
    }
    emit("swapCameraViews");
    return;
  }
  if (view === "camera") local.cameraIndex = index;
  else local.camera2Index = index;
  emit("switchCamera", { view, index });
}


// 当端口列表变化时，设置默认值
import { watch } from "vue";
watch(
  () => props.ports,
  (ports) => {
    if (ports.length >= 1 && !local.followerPort) local.followerPort = ports[0];
    if (ports.length >= 2 && !local.leaderPort) local.leaderPort = ports[1];
  },
  { immediate: true }
);
// 设置默认摄像头
watch(
  () => props.detectedCameras,
  (cameras) => {
    if (cameras.length >= 1 && !local.cameraIndex) local.cameraIndex = cameras[0];
    if (cameras.length >= 2 && !local.camera2Index) local.camera2Index = cameras[1];
    else if (cameras.length >= 1 && !local.camera2Index) local.camera2Index = cameras[0];
  },
  { immediate: true }
);
</script>

<style scoped>
.control-panel {
  display: flex;
  flex-direction: column;
}
.section-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.kicker { color: #73777a; font-size: 11px; font-weight: 650; letter-spacing: 0; }
h2 { color: #282a2d; font-size: 16px; margin-top: 3px; letter-spacing: 0;
}
.form-group {
  margin-bottom: 10px;
}
.form-group label {
  display: block;
  font-size: 12px;
  color: #5f6366;
  margin-bottom: 3px;
}
.form-group select,
.form-group input {
  width: 100%;
  padding: 7px 8px;
  background: #fff;
  border: 1px solid #dddedf;
  border-radius: 5px;
  color: #292b2e;
  font-size: 14px;
}
.form-group label span { color: #8c9093; font-size: 11px; }
.field-note { display: block; color: #7b8083; line-height: 1.4; margin-top: 5px; }
.leader-mode { margin-bottom: 12px; }
.mode-options { display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px; padding: 4px; border: 1px solid #dedfe0; border-radius: 6px; background: #f3f4f4; }
.mode-options button { min-height: 34px; padding: 5px 6px; border: 0; border-radius: 4px; background: transparent; color: #777b7f; font-size: 12px; cursor: pointer; transition: background .18s, color .18s; }
.mode-options button.active { color: #246f54; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
.mode-options span { display: block; margin-top: 1px; color: inherit; font-size: 10px; opacity: .7; }
.btn-refresh {
  background: #fff;
  border: 1px solid #dedfe0;
  color: #4a5054;
  border-radius: 5px;
  width: 32px;
  height: 32px;
  font-size: 19px;
  cursor: pointer;
}
.btn-refresh:hover { background: #f1f2f2; }
.row2 {
  display: flex;
  gap: 8px;
}
.row2 > div {
  flex: 1;
}
.btn {
  padding: 10px;
  border: none;
  border-radius: 5px;
  font-size: 15px;
  cursor: pointer;
  width: 100%;
  margin-top: 6px;
  font-weight: 600;
  transition: all 0.2s;
}
.btn-start { background: #3f78d1; color: #fff; }
.btn-start:hover { background: #2f64b4; }
.btn-stop { background: #ed5155; color: #fff; }.btn-stop:hover { background: #d94146; }
.btn-connect { background: #3f78d1; color: #fff; }.btn-disconnect { background: #6d7478; color: #fff; }
.serial-error { color: #c9363b; font-size: 11px; margin-top: 7px; }
.btn:disabled {
  background: #e4e6e6;
  color: #919598;
  cursor: not-allowed;
  opacity: 0.5;
}
.hint { margin-top: 12px; font-size: 11px; line-height: 1.5; color: #85898c; }
</style>
