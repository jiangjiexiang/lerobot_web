<template>
  <div class="app-shell">
    <header class="header">
      <div class="brand">
        <span class="brand-mark">SO</span>
        <div>
          <p class="eyebrow">LE ROBOT · TELEOPERATION</p>
          <h1>SO-101 控制台</h1>
        </div>
      </div>
      <StatusBar :connected="connected" :running="running" />
    </header>

    <main class="main">
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
          @connect-leader="handleConnectLeader"
          @disconnect-leader="disconnectLeader"
        />
      </section>

      <section class="visuals" aria-label="机器人可视化">
        <section class="panel view" aria-label="摄像头 1 画面"><MuJoCoView :frame="cameraFrame" kicker="实时画面" title="摄像头 1 (左侧)" placeholder="等待摄像头 1 画面…" hint="USB 摄像头 1 画面" liveText="LIVE" waitText="READY" /></section>
        <section class="panel view" aria-label="摄像头 2 画面"><MuJoCoView :frame="camera2Frame" kicker="实时画面" title="摄像头 2 (右侧)" placeholder="等待摄像头 2 画面…" hint="USB 摄像头 2 画面" liveText="LIVE" waitText="READY" /></section>
        <section class="console" aria-label="运行控制台"><LogPanel :logs="logs" /></section>
      </section>

      <aside class="right-rail" aria-label="实时状态">
        <section class="panel joints" aria-label="实时关节数据"><JointPanel :leader="leaderJoints" :follower="followerJoints" /></section>
      </aside>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useWebSocket } from "./composables/useWebSocket";
import StatusBar from "./components/StatusBar.vue";
import ControlPanel from "./components/ControlPanel.vue";
import MuJoCoView from "./components/MuJoCoView.vue";
import JointPanel from "./components/JointPanel.vue";
import LogPanel from "./components/LogPanel.vue";
import { useLeaderSerial } from "./composables/useLeaderSerial";

const {
  connected,
  running,
  leaderJoints,
  followerJoints,
  cameraFrame,
  camera2Frame,
  logs,
  log,
  send,
} = useWebSocket();
const { connected: serialConnected, error: serialError, connect: connectLeader, disconnect: disconnectLeader } = useLeaderSerial(send, log);

const ports = ref<string[]>([]);
const cameras = ref<{ index: number; path: string }[]>([]);
const detectedCameras = ref<number[]>([]);
const activeCameras = ref<{ camera: number; camera2: number }>({ camera: -1, camera2: -1 });
const actionPending = ref(false);

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
    const res = await fetch("/api/camera/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    if (data.ok) {
      const key = config.view === "camera" ? "camera" : "camera2";
      activeCameras.value[key] = config.index;
      log(`已切换 ${config.view === "camera" ? "摄像头 1" : "摄像头 2"} 到 /dev/video${config.index}`);
    } else {
      log(`切换摄像头失败: ${data.error}`);
    }
  } catch (e) {
    log(`切换摄像头请求失败: ${e}`);
  }
}

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
  catch (error) { log("连接 Leader 失败: " + (error instanceof Error ? error.message : String(error))); }
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

onMounted(() => fetchPorts());
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
.header {
  max-width: 1560px;
  margin: 0 auto;
  padding: 22px 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(160, 190, 220, 0.13);
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  color: #08111e;
  font-size: 13px;
  font-weight: 800;
  background: linear-gradient(135deg, #64dcff, #88a6ff);
  box-shadow: 0 8px 22px rgba(69, 174, 248, 0.25);
}
.eyebrow { color: #78a9c6; font-size: 10px; font-weight: 700; letter-spacing: 1.4px; }
.header h1 { font-size: 20px; letter-spacing: -0.3px; margin-top: 2px; }
.main {
  max-width: 1560px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(290px, 340px) minmax(380px, 1fr) minmax(280px, 320px);
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
@media (max-width: 1100px) {
  .main { grid-template-columns: minmax(285px, 340px) minmax(430px, 1fr); grid-template-areas: "control visuals" "rail rail"; }
  .right-rail { display: grid; grid-template-columns: 1fr 1fr; }
  .visuals { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .header, .main { padding-left: 16px; padding-right: 16px; }
  .main { grid-template-columns: 1fr; grid-template-areas: "control" "visuals" "rail"; padding-top: 16px; }
  .right-rail { display: flex; }
  .header { align-items: flex-start; gap: 14px; }
}
</style>
