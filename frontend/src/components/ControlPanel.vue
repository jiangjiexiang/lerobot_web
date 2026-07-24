<template>
  <div class="control-panel">
    <div class="section-heading">
      <div>
        <p class="kicker">连接设置</p>
        <h2>遥操作配置</h2>
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
      <label>主臂连接方式</label>
      <div class="mode-options" role="group" aria-label="主臂连接方式">
        <button type="button" :class="{ active: !local.remoteLeader }" @click="local.remoteLeader = false">本机串口</button>
        <button type="button" :class="{ active: local.remoteLeader }" @click="local.remoteLeader = true">网页 COM <span>双电脑</span></button>
      </div>
      <small v-if="local.remoteLeader" class="field-note">操作电脑使用 HTTPS 的 Chrome / Edge 连接 Leader COM。</small>
      <template v-else>
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
        <label>摄像头 1 <span>左侧画面</span></label>
        <select v-model.number="local.cameraIndex" @change="$emit('switchCamera', { view: 'camera', index: local.cameraIndex })">
          <option v-for="c in detectedCameras" :key="c" :value="c" :disabled="c === local.camera2Index">/dev/video{{ c }} {{ c === activeCameras.camera ? '✓ 当前' : '' }}</option>
          <option v-if="!detectedCameras.length" disabled>未检测到摄像头</option>
        </select>
      </div>
      <div class="form-group">
        <label>摄像头 2 <span>右侧画面</span></label>
        <select v-model.number="local.camera2Index" @change="$emit('switchCamera', { view: 'camera2', index: local.camera2Index })">
          <option v-for="c in detectedCameras" :key="c" :value="c" :disabled="c === local.cameraIndex">/dev/video{{ c }} {{ c === activeCameras.camera2 ? '✓ 当前' : '' }}</option>
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

    <template v-if="local.remoteLeader">
      <button class="btn btn-connect" :disabled="serialConnected" @click="$emit('connectLeader', { leaderId: local.leaderId, fps: local.fps })">
        {{ serialConnected ? "Leader COM 已连接" : "连接 Leader COM" }}
      </button>
      <button class="btn btn-disconnect" :disabled="!serialConnected" @click="$emit('disconnectLeader')">断开 Leader COM</button>
      <p v-if="serialError" class="serial-error">{{ serialError }}</p>
    </template>

    <button class="btn btn-start" :disabled="running || busy || (local.remoteLeader && !serialConnected)" @click="$emit('start', { ...local, viewer: false })">
      {{ busy && !running ? "正在启动…" : running ? "遥操作运行中" : "启动遥操作" }}
    </button>
    <button class="btn btn-stop" :disabled="!running || busy" @click="$emit('stop')">
      {{ busy && running ? "正在停止…" : "停止遥操作" }}
    </button>

    <p class="hint">MuJoCo 仿真已关闭，仅运行真实机器人控制和摄像头。</p>
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
  remoteLeader: false,
});


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
// 同步当前激活的摄像头索引
watch(
  () => props.activeCameras,
  (ac) => {
    if (ac.camera >= 0) local.cameraIndex = ac.camera;
    if (ac.camera2 >= 0) local.camera2Index = ac.camera2;
  },
  { deep: true }
);
</script>

<style scoped>
.control-panel {
  display: flex;
  flex-direction: column;
}
.section-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; }
.kicker { color: #6db8d7; font-size: 10px; font-weight: 700; letter-spacing: 1.2px; }
h2 { font-size: 18px; margin-top: 3px; letter-spacing: -0.25px;
}
.form-group {
  margin-bottom: 10px;
}
.form-group label {
  display: block;
  font-size: 12px;
  color: #afc0d2;
  margin-bottom: 3px;
}
.form-group select,
.form-group input {
  width: 100%;
  padding: 7px 8px;
  background: #0a1728;
  border: 1px solid #29435f;
  border-radius: 8px;
  color: #edf5ff;
  font-size: 14px;
}
.form-group label span { color: #6f91aa; font-size: 11px; }
.field-note { display: block; color: #7894ab; line-height: 1.4; margin-top: 5px; }
.leader-mode { margin-bottom: 12px; }
.mode-options { display: grid; grid-template-columns: 1fr 1.25fr; gap: 5px; padding: 4px; border: 1px solid #29435f; border-radius: 9px; background: #0a1728; }
.mode-options button { min-height: 34px; padding: 5px 6px; border: 0; border-radius: 6px; background: transparent; color: #8098ad; font-size: 12px; cursor: pointer; transition: background .18s, color .18s; }
.mode-options button.active { color: #e7f9ff; background: #1b5273; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
.mode-options span { display: block; margin-top: 1px; color: inherit; font-size: 10px; opacity: .7; }
.btn-refresh {
  background: #102941;
  border: 1px solid #315574;
  color: #8dd4f4;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  font-size: 19px;
  cursor: pointer;
}
.btn-refresh:hover {
  background: #183957;
}
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
  border-radius: 9px;
  font-size: 15px;
  cursor: pointer;
  width: 100%;
  margin-top: 6px;
  font-weight: 600;
  transition: all 0.2s;
}
.btn-start {
  background: linear-gradient(135deg, #28b97a, #28a99d);
  color: #071a16;
}
.btn-start:hover {
  background: linear-gradient(135deg, #43d99a, #41cbbc);
}
.btn-stop {
  background: #f15d73;
  color: #fff;
}
.btn-stop:hover {
  background: #c73e54;
}
.btn-connect { background: #1c5c86; color: #e9f7ff; }
.btn-disconnect { background: #495a6b; color: #f3f7fb; }
.serial-error { color: #ff9aaa; font-size: 11px; margin-top: 7px; }
.btn:disabled {
  background: #26384c;
  cursor: not-allowed;
  opacity: 0.5;
}
.hint { margin-top: 12px; font-size: 11px; line-height: 1.5; color: #7690a8; }
</style>
