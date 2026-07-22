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

    <div class="form-group">
      <label>Leader 串口 <span>主臂</span></label>
      <select v-model="local.leaderPort">
        <option v-for="p in ports" :key="p" :value="p">{{ p }}</option>
      </select>
    </div>

    <div class="form-group">
      <label>Leader ID</label>
      <input v-model="local.leaderId" placeholder="如 R07253102" />
    </div>

    <div class="row2">
      <div class="form-group">
        <label>刷新率 FPS</label>
        <select v-model.number="local.fps">
          <option :value="15">15</option>
          <option :value="30">30</option>
          <option :value="60">60</option>
        </select>
      </div>
      <div class="form-group">
        <label>本地 MuJoCo</label>
        <select v-model="viewerVal">
          <option :value="false">仅网页画面</option>
          <option :value="true">同时打开弹窗</option>
        </select>
      </div>
    </div>

    <button class="btn btn-start" :disabled="running || busy" @click="$emit('start', { ...local, viewer: viewerVal })">
      {{ busy && !running ? "正在启动…" : running ? "遥操作运行中" : "启动遥操作" }}
    </button>
    <button class="btn btn-stop" :disabled="!running || busy" @click="$emit('stop')">
      {{ busy && running ? "正在停止…" : "停止遥操作" }}
    </button>

    <p class="hint">网页仿真画面始终显示；可选同时打开本机 MuJoCo 窗口。</p>
    <div class="log-box" aria-live="polite">
      <div v-for="(line, i) in logs" :key="i" class="log-line">{{ line }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from "vue";

const props = defineProps<{
  ports: string[];
  running: boolean;
  busy: boolean;
  logs: string[];
}>();

const emit = defineEmits<{
  start: [config: Record<string, unknown>];
  stop: [];
  refresh: [];
}>();

const local = reactive({
  followerPort: "",
  followerId: "R12253102",
  leaderPort: "",
  leaderId: "R07253102",
  fps: 30,
});

const viewerVal = ref(false);

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
.btn:disabled {
  background: #26384c;
  cursor: not-allowed;
  opacity: 0.5;
}
.log-box {
  font-size: 12px;
  color: #8ba1b5;
  margin-top: 12px;
  max-height: 120px;
  overflow-y: auto;
  font-family: monospace;
  background: #091522;
  border: 1px solid #213a52;
  border-radius: 8px;
  padding: 8px;
}
.log-line {
  line-height: 1.6;
}
.hint { margin-top: 12px; font-size: 11px; line-height: 1.5; color: #7690a8; }
</style>
