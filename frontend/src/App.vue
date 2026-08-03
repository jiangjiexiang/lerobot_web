<template>
  <div class="app-shell">
    <div v-if="selfCheckVisible && workspace === 'control'" class="self-check-overlay" role="dialog" aria-modal="true" aria-labelledby="self-check-title">
      <div class="self-check-modal">
        <div class="self-check-heading">
          <div><h2 id="self-check-title">启动自检</h2></div>
          <span :class="['self-check-state', selfCheckRunning ? 'checking' : selfCheckPassed ? 'ok' : 'warn']">{{ selfCheckRunning ? "检查中" : selfCheckPassed ? "全部正常" : "需要检查" }}</span>
        </div>
        <div v-if="selfCheckRunning" class="self-check-loading">
          <span class="spinner"></span>
          <div><strong>正在执行启动自检</strong><small>检查服务器、Follower 串口、标定文件和摄像头画面</small></div>
          <span class="loading-dots"><i></i><i></i><i></i></span>
        </div>
        <div v-else-if="selfCheck?.server?.ok" class="self-check-results">
          <p :class="selfCheck?.server?.ok ? 'ok' : 'bad'">{{ selfCheck?.server?.ok ? '✓ Robot Server 正常' : '✕ Robot Server 无响应' }}</p>
          <p :class="selfCheck?.follower?.portPresent ? 'ok' : 'bad'">{{ selfCheck?.follower?.portPresent ? `✓ 检测到机械臂串口 (${selfCheck.follower.ports.join(', ')})` : '✕ 未检测到 ttyACM / ttyUSB 串口' }}</p>
          <p :class="selfCheck?.follower?.calibrationValid ? 'ok' : 'warn'">{{ selfCheck?.follower?.calibrationValid ? `✓ Follower 标定有效 (${selfCheck.follower.id})` : `! Follower 标定缺失或无效 (${selfCheck?.follower?.id || '-'})` }}</p>
          <p v-for="(camera, index) in selfCheck?.cameras || []" :key="index" :class="camera.frameFresh ? 'ok' : 'bad'">{{ camera.frameFresh ? `✓ 摄像头 ${index + 1} 正常 (/dev/video${camera.index})` : `✕ 摄像头 ${index + 1} 无画面${camera.index >= 0 ? ` (/dev/video${camera.index})` : ''}` }}</p>
        </div>
        <div v-else class="self-check-results"><p class="bad">✕ Robot Server 自检接口无响应</p><p class="self-check-error">{{ selfCheck?.server?.error || '请重启 start_robot.sh 后重试' }}</p></div>
        <p class="self-check-note">机械臂检查仅确认串口与标定，不会上扭矩或移动关节。</p>
        <div class="self-check-actions"><button class="secondary" :disabled="selfCheckRunning" @click="runSelfCheck()">重新检查</button><button class="primary" :disabled="selfCheckRunning" @click="selfCheckVisible = false">进入控制台</button></div>
      </div>
    </div>
    <div v-if="modalError" class="fatal-overlay" role="alertdialog" aria-modal="true" aria-labelledby="fatal-title">
      <div class="fatal-modal">
        <div class="fatal-heading"><span class="fatal-icon">✕</span><h2 id="fatal-title">出现异常</h2></div>
        <p class="fatal-message">{{ modalError }}</p>
        <p class="fatal-hint">请检查串口连接、电机供电或标定配置，修复后可重新启动遥操作。</p>
        <div class="fatal-actions"><button class="primary" @click="modalError = null">知道了</button></div>
      </div>
    </div>
    <div class="app-layout">
      <header class="topbar">
        <nav class="workspace-tabs" aria-label="工作区">
          <button :class="{ active: workspace === 'control' }" @click="workspace = 'control'"><span>▦</span>概览</button>
          <button :class="{ active: workspace === 'datasets' }" @click="workspace = 'datasets'"><span>▤</span>数据</button>
          <button :class="{ active: workspace === 'training' }" @click="workspace = 'training'"><span>◫</span>任务</button>
          <button :class="{ active: workspace === 'logs' }" @click="workspace = 'logs'"><span>☷</span>日志</button>
        </nav>
        <div class="topbar-status"><StatusBar v-if="workspace === 'control'" :connected="connected" :running="running" :metrics="metrics" /></div>
      </header>

      <main v-if="workspace === 'control'" class="main">
        <section class="live-workspace" aria-label="实时可视化">
          <div class="panel live-panel">
            <div class="workspace-heading"><div><p>实时可视化</p><h1>双臂采集视图</h1></div><span class="camera-count">2 路摄像头</span></div>
            <div class="camera-grid">
              <section class="camera-view" aria-label="摄像头 1 画面"><CameraView :stream="cameraViewsSwapped ? camera2Stream : cameraStream" :frame="cameraViewsSwapped ? camera2Frame : cameraFrame" :fallback-src="cameraViewsSwapped ? '/video/camera2' : '/video/camera'" :latency-ms="cameraViewsSwapped ? metrics.camera2Latency : metrics.cameraLatency" kicker="摄像头 1" title="实时画面" placeholder="等待摄像头 1 画面…" :hint="`/dev/video${cameraViewsSwapped ? activeCameras.camera2 : activeCameras.camera}`" liveText="实时" waitText="等待" /></section>
              <section class="camera-view" aria-label="摄像头 2 画面"><CameraView :stream="cameraViewsSwapped ? cameraStream : camera2Stream" :frame="cameraViewsSwapped ? cameraFrame : camera2Frame" :fallback-src="cameraViewsSwapped ? '/video/camera' : '/video/camera2'" :latency-ms="cameraViewsSwapped ? metrics.cameraLatency : metrics.camera2Latency" kicker="摄像头 2" title="实时画面" placeholder="等待摄像头 2 画面…" :hint="`/dev/video${cameraViewsSwapped ? activeCameras.camera : activeCameras.camera2}`" liveText="实时" waitText="等待" /></section>
            </div>
          </div>
          <div class="capture-details">
            <section class="panel recorder" aria-label="数据录制"><RecordingPanel :recording="recording" :running="running" :busy="recordingPending" @start="handleRecordingStart" @stop="handleRecordingStop" @cancel="handleRecordingCancel" /></section>
            <section class="panel joints" aria-label="实时关节数据"><JointPanel :leader="leaderJoints" :follower="followerJoints" /></section>
          </div>
        </section>
        <aside class="right-rail" aria-label="采集控制">
          <section class="panel ctrl" aria-label="机械臂连接"><ControlPanel :ports="ports" :detected-cameras="detectedCameras" :active-cameras="activeCameras" :running="running" :busy="actionPending" :serial-connected="serialConnected" :serial-error="serialError" :control-latency="metrics.controlLatency" @refresh="fetchPorts" @start="handleStart" @stop="handleStop" @switch-camera="handleSwitchCamera" @swap-camera-views="handleSwapCameraViews" @connect-leader="handleConnectLeader" @disconnect-leader="disconnectLeader" /></section>
        </aside>
      </main>
      <DatasetWorkspace v-else-if="workspace === 'datasets'" />
      <TrainingWorkspace v-else-if="workspace === 'training'" />
      <LogWorkspace v-else :logs="logs" @clear="clearLogs" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from "vue";
import { useWebSocket } from "./composables/useWebSocket";
import StatusBar from "./components/StatusBar.vue";
import ControlPanel from "./components/ControlPanel.vue";
import CameraView from "./components/CameraView.vue";
import JointPanel from "./components/JointPanel.vue";
import RecordingPanel from "./components/RecordingPanel.vue";
import DatasetWorkspace from "./components/DatasetWorkspace.vue";
import TrainingWorkspace from "./components/TrainingWorkspace.vue";
import LogWorkspace from "./components/LogWorkspace.vue";
import { useLeaderSerial } from "./composables/useLeaderSerial";

const {
  connected,
  running,
  leaderJoints,
  followerJoints,
  cameraFrame,
  camera2Frame,
  cameraStream,
  camera2Stream,
  logs,
  fatalError,
  recording,
  metrics,
  log,
  clearLogs,
  send,
} = useWebSocket();
const { connected: serialConnected, error: serialError, connect: connectLeader, disconnect: disconnectLeader } = useLeaderSerial(send, log, stopAfterLeaderFailure);
const modalError = computed({
  get: () => fatalError.value || frontError.value,
  set: (value) => { fatalError.value = value; frontError.value = value; },
});
const frontError = ref<string | null>(null);
type Workspace = "control" | "datasets" | "training" | "logs";
const initialWorkspace: Workspace = location.hash === "#datasets" || location.hash.startsWith("#datasets/")
  ? "datasets"
  : location.hash === "#training"
    ? "training"
    : location.hash === "#logs"
      ? "logs"
      : "control";
const workspace = ref<Workspace>(initialWorkspace);
const pageContext = computed(() => ({
  control: { title: "遥操作控制台" },
  datasets: { title: "数据管理平台" },
  training: { title: "训练管理平台" },
  logs: { title: "日志管理" },
})[workspace.value]);

const ports = ref<string[]>([]);
const cameras = ref<{ index: number; path: string }[]>([]);
const detectedCameras = ref<number[]>([]);
const activeCameras = ref<{ camera: number; camera2: number }>({ camera: -1, camera2: -1 });
const actionPending = ref(false);
const recordingPending = ref(false);
const cameraViewsSwapped = ref(false);
const selfCheckRunning = ref(false);
const selfCheck = ref<Record<string, any> | null>(null);
const selfCheckVisible = ref(false);
const selfCheckPassed = computed(() => Boolean(selfCheck.value?.server?.ok
  && selfCheck.value?.follower?.portPresent
  && selfCheck.value?.follower?.calibrationValid
  && selfCheck.value?.cameras?.length >= 2
  && selfCheck.value.cameras.every((camera: Record<string, any>) => camera.frameFresh)));

async function runSelfCheck(config?: { followerId?: string; showModal?: boolean }) {
  if (selfCheckRunning.value) return;
  if (config?.showModal !== false) selfCheckVisible.value = true;
  selfCheckRunning.value = true;
  const minimumAnimation = new Promise<void>((resolve) => window.setTimeout(resolve, 350));
  try {
    const params = new URLSearchParams({
      follower_id: config?.followerId || "R12253102",
    });
    const res = await fetch(`/api/self-check?${params}`);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("自检接口返回了网页内容；请重启 start_robot.sh 以加载新版 Robot Server");
    }
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
    await minimumAnimation;
    selfCheck.value = result;
    log("启动自检完成");
  } catch (cause) {
    await minimumAnimation;
    selfCheck.value = { server: { ok: false, error: String(cause) } };
    selfCheckVisible.value = true;
    log(`启动自检失败: ${cause}`);
  } finally {
    selfCheckRunning.value = false;
  }
}

async function stopAfterLeaderFailure() {
  if (serialError.value) frontError.value = `Leader 串口断开: ${serialError.value}`;
  if (!running.value) return;
  log("Leader 已断开，正在安全停止后端遥操作...");
  try {
    const res = await fetch("/api/stop", { method: "POST" });
    const data = await res.json();
    if (data.ok || data.error === "未在运行") log("后端遥操作已安全停止");
    else log(`后端停止失败: ${data.error}`);
  } catch (cause) {
    log(`后端停止请求失败: ${cause}`);
  }
}

async function fetchPorts() {
  try {
    const res = await fetch("/api/ports");
    const data = await res.json();
    ports.value = data.ports || [];
    log(`检测到 ${ports.value.length} 个串口`);
    const cameraRes = await fetch("/api/cameras");
    const cd = await cameraRes.json();
    cameras.value = cd.cameras || [];
    detectedCameras.value = cd.detected || [];
    if (cd.active) activeCameras.value = cd.active;
  } catch (e) {
    log("加载串口失败: " + e);
  }
}

async function handleSwitchCamera(config: { view: string; index: number }) {
  try {
    const backendView = cameraViewsSwapped.value
      ? (config.view === "camera" ? "camera2" : "camera")
      : config.view;
    const res = await fetch("/api/camera/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, view: backendView }),
    });
    const data = await res.json();
    if (data.ok) {
      const key = backendView === "camera" ? "camera" : "camera2";
      activeCameras.value[key] = config.index;
      log(`已切换 ${config.view === "camera" ? "摄像头 1" : "摄像头 2"} 到 /dev/video${config.index}`);
    } else {
      log(`切换摄像头失败: ${data.error}`);
    }
  } catch (e) {
    log(`切换摄像头请求失败: ${e}`);
  }
}

function handleSwapCameraViews() {
  cameraViewsSwapped.value = !cameraViewsSwapped.value;
  log("已交换左右摄像头画面");
}

async function recordingRequest(endpoint: "start" | "stop" | "cancel", body?: object) {
  if (recordingPending.value) return;
  recordingPending.value = true;
  try {
    const res = await fetch(`/api/recording/${endpoint}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    log(endpoint === "start" ? "数据集录制已启动" : endpoint === "stop" ? "正在编码并保存 episode" : "正在丢弃本次录制");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log(`录制操作失败: ${message}`);
    frontError.value = `录制操作失败: ${message}`;
  } finally {
    recordingPending.value = false;
  }
}

function handleRecordingStart(config: { dataset: string; task: string; fps: number; plannedEpisodes: number; episodeTime: number; resetTime: number; resume: boolean }) { void recordingRequest("start", config); }
function handleRecordingStop() { void recordingRequest("stop"); }
function handleRecordingCancel() { void recordingRequest("cancel"); }

async function handleStart(config: Record<string, unknown>) {
  if (actionPending.value || running.value) return;
  // 前端 camelCase -> 后端 snake_case
  const payload = {
    follower_port: config.followerPort,
    follower_id: config.followerId,
    leader_port: config.leaderPort,
    leader_id: config.leaderId,
    fps: config.fps,
    remote_leader: config.remoteLeader,
    // 机器人本地 USB 摄像头：/dev/video0 对应 OpenCV 索引 0。
    // 摄像头由 robot-server 的独立 camera_stream 进程采集，避免和遥操作进程抢占设备。
    camera_index: config.cameraIndex,
  };
  actionPending.value = true;
  log("正在启动遥操作...");
  try {
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      log("遥操作已启动");
    } else {
      log("启动失败: " + data.error);
    }
  } catch (e) {
    log("请求失败: " + e);
  } finally {
    actionPending.value = false;
  }
}

async function handleConnectLeader(config: { leaderId: string; fps: number }) {
  try { await connectLeader(config.leaderId, config.fps); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("连接 Leader 失败: " + message);
    frontError.value = `连接 Leader 失败: ${message}`;
  }
}

async function handleStop() {
  if (actionPending.value || !running.value) return;
  actionPending.value = true;
  log("正在停止遥操作...");
  try {
    const res = await fetch("/api/stop", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      await disconnectLeader();
      log("已停止，并断开 Leader COM");
    }
    else log("停止失败: " + data.error);
  } catch (e) {
    log("停止失败: " + e);
  } finally {
    actionPending.value = false;
  }
}

watch(running, async (isRunning, wasRunning) => {
  if (wasRunning && !isRunning && serialConnected.value) {
    await disconnectLeader();
    log("后端遥操作已停止，Leader COM 已自动断开");
  }
});

watch(workspace, (value) => {
  history.replaceState(null, "", value === "control" ? location.pathname + location.search : `#${value}`);
});

onMounted(async () => {
  await fetchPorts();
  await runSelfCheck({ showModal: false });
});
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
body {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #050505;
  color: #f4f4f5;
  min-height: 100vh;
}
.app-shell {
  min-height: 100vh;
  background:
    radial-gradient(circle at 72% -10%, rgba(124, 92, 255, 0.10), transparent 32rem),
    radial-gradient(circle at 0% 100%, rgba(255, 255, 255, 0.035), transparent 32rem),
    #050505;
}
.self-check-overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; background: rgba(2, 8, 16, .82); backdrop-filter: blur(8px); }
.self-check-modal { width: min(480px, 100%); padding: 24px; border: 1px solid rgba(119, 188, 225, .25); border-radius: 18px; background: #0d1c2e; box-shadow: 0 24px 80px rgba(0, 0, 0, .5); }
.self-check-heading { display: flex; align-items: center; justify-content: space-between; gap: 15px; margin-bottom: 20px; }
.self-check-heading h2 { margin-top: 3px; font-size: 22px; }
.self-check-state { padding: 5px 9px; border-radius: 99px; font: 10px ui-monospace, monospace; background: #172b40; }
.self-check-state.ok, .self-check-results .ok { color: #69d7a3; }
.self-check-state.warn, .self-check-results .warn { color: #f3c969; }
.self-check-state.checking { color: #76cdec; }
.self-check-results { display: grid; gap: 9px; padding: 15px; border-radius: 10px; background: rgba(4, 12, 22, .55); }
.self-check-results p { font-size: 13px; }
.self-check-results .bad { color: #ff9aaa; }
.self-check-results .self-check-error { color: #718da3; font: 10px/1.4 ui-monospace, monospace; word-break: break-word; }
.self-check-loading { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 13px; min-height: 150px; padding: 20px; color: #92aec4; font-size: 13px; }
.self-check-loading strong { display: block; color: #c7ddeb; font-size: 14px; }
.self-check-loading small { display: block; margin-top: 5px; color: #6f8da3; font-size: 10px; line-height: 1.4; }
.spinner { width: 28px; height: 28px; border: 3px solid #29465f; border-top-color: #72d2f2; border-radius: 50%; animation: self-check-spin .8s linear infinite; box-shadow: 0 0 14px rgba(114, 210, 242, .16); }
.loading-dots { display: flex; align-items: center; gap: 4px; }
.loading-dots i { width: 5px; height: 5px; border-radius: 50%; background: #72d2f2; animation: self-check-pulse 1s ease-in-out infinite; }
.loading-dots i:nth-child(2) { animation-delay: .15s; }
.loading-dots i:nth-child(3) { animation-delay: .3s; }
.self-check-note { margin-top: 13px; color: #718da3; font-size: 10px; }
.self-check-actions { display: flex; justify-content: flex-end; gap: 9px; margin-top: 20px; }
.self-check-actions button { padding: 9px 14px; border: 0; border-radius: 8px; cursor: pointer; font-weight: 600; }
.self-check-actions button:disabled { opacity: .45; cursor: default; }
.self-check-actions .secondary { color: #91bad2; background: #142b40; }
.self-check-actions .primary { color: #06101a; background: #64d6f4; }
@keyframes self-check-spin { to { transform: rotate(360deg); } }
@keyframes self-check-pulse { 0%, 100% { opacity: .25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-3px); } }
.fatal-overlay { position: fixed; inset: 0; z-index: 1100; display: grid; place-items: center; padding: 20px; background: rgba(2, 8, 16, .82); backdrop-filter: blur(8px); }
.fatal-modal { width: min(480px, 100%); padding: 24px; border: 1px solid rgba(255, 122, 143, .35); border-radius: 18px; background: #1c0f14; box-shadow: 0 24px 80px rgba(0, 0, 0, .5); }
.fatal-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.fatal-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: rgba(255, 122, 143, .18); color: #ff9aaa; font-weight: 800; }
.fatal-heading h2 { font-size: 20px; }
.fatal-message { padding: 12px 14px; border-radius: 10px; background: rgba(0, 0, 0, .3); color: #ffb8c4; font: 12px/1.5 ui-monospace, monospace; word-break: break-word; }
.fatal-hint { margin-top: 12px; color: #a48b90; font-size: 12px; }
.fatal-actions { display: flex; justify-content: flex-end; margin-top: 20px; }
.fatal-actions button { padding: 9px 16px; border: 0; border-radius: 8px; cursor: pointer; font-weight: 600; }
.fatal-actions .primary { color: #06101a; background: #64d6f4; }
/* Capture workspace: dense, light operational surface modelled around the live feed. */
body { background: #f7f8f8; color: #242629; }
.app-shell { background: #f7f8f8; }
.app-layout { display: block; min-height: 100vh; }
.topbar { height: 68px; display: flex; align-items: center; gap: 28px; padding: 0 34px; color: #e9e9e9; background: #0d0e10; border-bottom: 1px solid #242528; }
.workspace-tabs { display:flex; flex-direction:row; align-items:center; gap:2px; background:transparent; border:0; }
.workspace-tabs button { position:relative; display:inline-flex; align-items:center; gap:6px; width:auto; min-height:38px; padding:8px 11px; border:0; border-radius:0; color:#85878b; background:transparent; font-size:13px; font-weight:550; }
.workspace-tabs button span { color:#76797d; font-size:15px; line-height:1; }
.workspace-tabs button:hover { background:#151618; color:#cfd0d2; }.workspace-tabs button:hover span { color:#cfd0d2; }
.workspace-tabs button.active { background:#0d0e10 !important; box-shadow:none; color:#e4e5e6 !important; font-weight:650; }.workspace-tabs button.active span { color:#e4e5e6; }.workspace-tabs button.active::after { content:""; position:absolute; right:11px; bottom:5px; left:11px; height:1px; background:#b9bbbe; }
.topbar-status { min-width: 0; margin-left: auto; }
.topbar-status .status-bar { gap: 9px; }
.topbar-status .metrics { display: none; }
.topbar-status .status-text { color: #c7c9cc; font-size: 12px; }
.main { max-width: 1760px; margin: 0 auto; padding: 30px 40px; display: grid; grid-template-columns: minmax(0, 1fr) 410px; grid-template-areas: "live recorder"; gap: 20px; align-items: start; }
.live-workspace { grid-area: live; display: grid; gap: 18px; min-width: 0; }
.right-rail { grid-area: recorder; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.panel { padding: 0; border: 1px solid #dedfe0; border-radius: 7px; background: #fff; box-shadow: 0 1px 3px rgba(22, 27, 29, .04); }
.live-panel { overflow: hidden; }
.workspace-heading { display: flex; align-items: center; justify-content: space-between; padding: 15px 18px; border-bottom: 1px solid #e6e7e8; }
.workspace-heading p { color: #303235; font-size: 14px; font-weight: 700; }
.workspace-heading h1 { margin-top: 3px; color: #929497; font-size: 11px; font-weight: 500; }
.camera-count { padding: 5px 9px; border: 1px solid #d5e4df; border-radius: 12px; color: #348369; background: #f8fcfa; font-size: 11px; }
.camera-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 14px; }
.camera-view { min-width: 0; }
.ctrl, .joints { padding: 18px; }
.capture-details { display:grid; grid-template-columns:minmax(0, 1fr) minmax(230px, .55fr); gap:18px; align-items:start; }
.recorder { padding: 0; overflow: hidden; }
.self-check-overlay, .fatal-overlay { background: rgba(22, 25, 29, .52); }
.self-check-modal { border-color: #dedede; border-radius: 8px; background: #fff; box-shadow: 0 18px 55px rgba(0, 0, 0, .2); color: #282a2d; }
.self-check-results { background: #f7f8f8; }.self-check-note { color: #74777b; }.self-check-actions .secondary { color: #45494d; background: #e9eaeb; }.self-check-actions .primary { color: #fff; background: #e94b50; }
.spinner { border-color:#d8dadd; border-top-color:#5b83ca; box-shadow:none; }.loading-dots i { background:#5b83ca; }.self-check-state { background:#eef0f1; color:#62676b; }.self-check-state.checking { color:#3f73cb; }.self-check-state.ok,.self-check-results .ok { color:#35805d; }.self-check-state.warn,.self-check-results .warn { color:#956b1e; }.self-check-results .bad { color:#c23c43; }
.fatal-modal { border-radius: 8px; background: #fff; color: #282a2d; }.fatal-message { background: #fff3f4; color: #b63038; }.fatal-hint { color: #74777b; }.fatal-actions .primary { color: #fff; background: #e94b50; }
@media (max-width: 1180px) { .main { padding: 24px; grid-template-columns: minmax(0, 1fr) 350px; }.topbar { padding: 0 22px; gap: 15px; } }
@media (max-width: 880px) { .topbar { height: auto; min-height: 60px; flex-wrap: wrap; padding-block: 10px; }.topbar-status { display: none; }.main { grid-template-columns: 1fr; grid-template-areas: "live" "recorder"; }.right-rail { width: min(100%, 600px); } }
@media (max-width: 580px) { .topbar { gap: 9px; padding-inline: 12px; }.workspace-tabs { order: 3; width: 100%; overflow-x: auto; }.workspace-tabs button { padding: 7px 9px; font-size: 11px; }.main { padding: 12px; gap: 12px; }.camera-grid,.capture-details { grid-template-columns: 1fr; gap: 12px; padding: 12px; }.capture-details { padding:0; }.workspace-heading { padding: 13px; } }
</style>
