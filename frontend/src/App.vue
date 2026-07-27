<template>
  <div class="app-shell">
    <div v-if="selfCheckVisible && workspace === 'control'" class="self-check-overlay" role="dialog" aria-modal="true" aria-labelledby="self-check-title">
      <div class="self-check-modal">
        <div class="self-check-heading">
          <div><p class="eyebrow">SYSTEM DIAGNOSTICS</p><h2 id="self-check-title">启动自检</h2></div>
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
      <aside class="workspace-sidebar">
        <p class="nav-label">工作区</p>
        <nav class="workspace-tabs" aria-label="工作区">
          <button :class="{ active: workspace === 'control' }" @click="workspace = 'control'"><span class="nav-icon">⌁</span><span class="nav-text">遥操作</span></button>
          <button :class="{ active: workspace === 'datasets' }" @click="workspace = 'datasets'"><span class="nav-icon">▤</span><span class="nav-text">数据管理</span></button>
          <button :class="{ active: workspace === 'training' }" @click="workspace = 'training'"><span class="nav-icon">▷</span><span class="nav-text">训练管理</span></button>
        </nav>
      </aside>

      <div class="app-content">
        <header class="header">
          <div class="page-context"><p class="eyebrow">{{ pageContext.eyebrow }}</p><h1>{{ pageContext.title }}</h1></div>
          <StatusBar v-if="workspace === 'control'" :connected="connected" :running="running" :metrics="metrics" />
        </header>

        <main v-if="workspace === 'control'" class="main">
      <section class="panel ctrl" aria-label="遥操作配置">
        <ControlPanel
          :ports="ports"
          :detected-cameras="detectedCameras"
          :active-cameras="activeCameras"
          :running="running"
          :busy="actionPending"
          :serial-connected="serialConnected"
          :serial-error="serialError"
          @refresh="fetchPorts"
          @start="handleStart"
          @stop="handleStop"
          @switch-camera="handleSwitchCamera"
          @swap-camera-views="handleSwapCameraViews"
          @connect-leader="handleConnectLeader"
          @disconnect-leader="disconnectLeader"
        />
      </section>

      <section class="visuals" aria-label="机器人可视化">
        <section class="panel view" aria-label="摄像头 1 画面"><MuJoCoView :frame="cameraViewsSwapped ? camera2Frame : cameraFrame" :fallback-src="cameraViewsSwapped ? '/video/camera2' : '/video/camera'" kicker="实时画面" title="摄像头 1" placeholder="等待摄像头 1 画面…" :hint="`/dev/video${cameraViewsSwapped ? activeCameras.camera2 : activeCameras.camera}`" liveText="LIVE" waitText="READY" /></section>
        <section class="panel view" aria-label="摄像头 2 画面"><MuJoCoView :frame="cameraViewsSwapped ? cameraFrame : camera2Frame" :fallback-src="cameraViewsSwapped ? '/video/camera' : '/video/camera2'" kicker="实时画面" title="摄像头 2" placeholder="等待摄像头 2 画面…" :hint="`/dev/video${cameraViewsSwapped ? activeCameras.camera : activeCameras.camera2}`" liveText="LIVE" waitText="READY" /></section>
        <section class="console" aria-label="运行控制台"><LogPanel :logs="logs" /></section>
      </section>

      <aside class="right-rail" aria-label="实时状态">
        <section class="panel recorder" aria-label="数据集录制">
          <RecordingPanel :recording="recording" :running="running" :busy="recordingPending" @start="handleRecordingStart" @stop="handleRecordingStop" @cancel="handleRecordingCancel" />
        </section>
        <section class="panel joints" aria-label="实时关节数据"><JointPanel :leader="leaderJoints" :follower="followerJoints" /></section>
      </aside>
        </main>
        <DatasetWorkspace v-else-if="workspace === 'datasets'" />
        <TrainingWorkspace v-else />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from "vue";
import { useWebSocket } from "./composables/useWebSocket";
import StatusBar from "./components/StatusBar.vue";
import ControlPanel from "./components/ControlPanel.vue";
import MuJoCoView from "./components/MuJoCoView.vue";
import JointPanel from "./components/JointPanel.vue";
import LogPanel from "./components/LogPanel.vue";
import RecordingPanel from "./components/RecordingPanel.vue";
import DatasetWorkspace from "./components/DatasetWorkspace.vue";
import TrainingWorkspace from "./components/TrainingWorkspace.vue";
import { useLeaderSerial } from "./composables/useLeaderSerial";

const {
  connected,
  running,
  leaderJoints,
  followerJoints,
  cameraFrame,
  camera2Frame,
  logs,
  fatalError,
  recording,
  metrics,
  log,
  send,
} = useWebSocket();
const { connected: serialConnected, error: serialError, connect: connectLeader, disconnect: disconnectLeader } = useLeaderSerial(send, log, stopAfterLeaderFailure);
const modalError = computed({
  get: () => fatalError.value || frontError.value,
  set: (value) => { fatalError.value = value; frontError.value = value; },
});
const frontError = ref<string | null>(null);
type Workspace = "control" | "datasets" | "training";
const initialWorkspace: Workspace = location.hash === "#datasets" ? "datasets" : location.hash === "#training" ? "training" : "control";
const workspace = ref<Workspace>(initialWorkspace);
const pageContext = computed(() => ({
  control: { eyebrow: "TELEOPERATION", title: "遥操作控制台" },
  datasets: { eyebrow: "DATA OPERATIONS", title: "数据管理平台" },
  training: { eyebrow: "MODEL TRAINING", title: "训练管理平台" },
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
const selfCheckVisible = ref(true);
const selfCheckPassed = computed(() => Boolean(selfCheck.value?.server?.ok
  && selfCheck.value?.follower?.portPresent
  && selfCheck.value?.follower?.calibrationValid
  && selfCheck.value?.cameras?.length >= 2
  && selfCheck.value.cameras.every((camera: Record<string, any>) => camera.frameFresh)));

async function runSelfCheck(config?: { followerId?: string }) {
  if (selfCheckRunning.value) return;
  selfCheckVisible.value = true;
  selfCheckRunning.value = true;
  const minimumAnimation = new Promise<void>((resolve) => window.setTimeout(resolve, 2500));
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
    viewer: config.viewer,
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
  await runSelfCheck();
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
  background: #09111f;
  color: #e7edf8;
  min-height: 100vh;
}
.app-shell {
  min-height: 100vh;
  background:
    radial-gradient(circle at 72% -10%, rgba(38, 150, 214, 0.20), transparent 34rem),
    radial-gradient(circle at 0% 100%, rgba(78, 85, 206, 0.16), transparent 34rem),
    #09111f;
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
.app-layout { display: grid; grid-template-columns: 184px minmax(0, 1fr); min-height: 100vh; }
.workspace-sidebar { position: sticky; top: 0; height: 100vh; padding: 20px 12px; border-right: 1px solid rgba(160, 190, 220, .13); background: #081421; }
.app-content { min-width: 0; }
.header {
  min-height: 72px;
  padding: 14px 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(160, 190, 220, 0.13);
}
.page-context h1 { margin-top: 2px; font-size: 17px; }
.nav-label { margin: 4px 8px 10px; color: #526d82; font-size: 9px; }
.workspace-tabs { display: flex; flex-direction: column; gap: 3px; }
.workspace-tabs button { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 40px; padding: 8px 10px; border: 0; border-radius: 5px; cursor: pointer; text-align: left; background: transparent; color: #7891a5; font-size: 11px; }
.workspace-tabs button:hover { background: #102638; color: #b8d0e1; }
.workspace-tabs button.active { color: #e8f6ff; background: #1b4966; }
.nav-icon { width: 17px; color: #81bed8; font: 15px/1 ui-monospace, monospace; text-align: center; }
.eyebrow { color: #78a9c6; font-size: 10px; font-weight: 700; letter-spacing: 1.4px; }
.header h1 { font-size: 20px; letter-spacing: -0.3px; margin-top: 2px; }
.main {
  max-width: 1800px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(280px, 320px) minmax(700px, 1fr) minmax(250px, 290px);
  grid-template-areas: "control visuals rail";
  gap: 18px;
  padding: 24px 28px 20px;
  align-items: start;
}
.panel {
  background: rgba(15, 30, 50, 0.86);
  border: 1px solid rgba(151, 188, 222, 0.15);
  border-radius: 16px;
  padding: 18px;
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.18);
}
.ctrl { grid-area: control; }
.ctrl, .joints { align-self: start; }
.view { width: 100%; min-width: 0; }
.visuals { grid-area: visuals; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-self: start; min-width: 0; }
.visuals .console { grid-column: 1 / -1; }
.right-rail { grid-area: rail; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
@media (max-width: 1500px) {
  .main { grid-template-columns: minmax(285px, 340px) minmax(430px, 1fr); grid-template-areas: "control visuals" "rail rail"; }
  .right-rail { display: grid; grid-template-columns: 1fr 1fr; }
  .visuals { grid-template-columns: 1fr; }
}
@media (max-width: 900px) {
  .main { grid-template-columns: 1fr; grid-template-areas: "control" "visuals" "rail"; }
  .right-rail { display: flex; }
}
@media (max-width: 760px) {
  .app-layout { grid-template-columns: 124px minmax(0, 1fr); }
  .workspace-sidebar { padding: 16px 8px; }
  .workspace-tabs button { padding: 8px 7px; }
  .header, .main { padding-left: 12px; padding-right: 12px; }
  .main { padding-top: 16px; }
  .header { align-items: flex-start; gap: 10px; flex-wrap: wrap; }
}
@media (max-width: 560px) {
  .app-layout { grid-template-columns: 58px minmax(0, 1fr); }
  .workspace-sidebar { padding: 12px 6px; }
  .nav-label, .nav-text { display: none; }
  .workspace-tabs button { justify-content: center; padding: 8px 4px; }
  .nav-icon { width: auto; font-size: 18px; }
  .header { padding: 10px; }
  .header .page-context { width: 100%; }
  .main { padding: 10px; gap: 10px; }
  .panel { padding: 12px; }
}
</style>
