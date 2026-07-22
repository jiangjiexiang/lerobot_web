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
          :running="running"
          :busy="actionPending"
          :logs="logs"
          @refresh="fetchPorts"
          @start="handleStart"
          @stop="handleStop"
        />
      </section>

      <section class="panel view" aria-label="MuJoCo 仿真画面">
        <MuJoCoView :frame="mujocoFrame" />
      </section>

      <section class="panel joints" aria-label="实时关节数据">
        <JointPanel :leader="leaderJoints" :follower="followerJoints" />
      </section>
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

const {
  connected,
  running,
  leaderJoints,
  followerJoints,
  mujocoFrame,
  logs,
  log,
} = useWebSocket();

const ports = ref<string[]>([]);
const actionPending = ref(false);

async function fetchPorts() {
  try {
    const res = await fetch("/api/ports");
    const data = await res.json();
    ports.value = data.ports || [];
    log(`检测到 ${ports.value.length} 个串口`);
  } catch (e) {
    log("加载串口失败: " + e);
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

async function handleStop() {
  if (actionPending.value || !running.value) return;
  actionPending.value = true;
  log("正在停止遥操作...");
  try {
    const res = await fetch("/api/stop", { method: "POST" });
    const data = await res.json();
    if (data.ok) log("已发送停止指令");
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
  grid-template-columns: minmax(290px, 340px) minmax(480px, 1fr) minmax(280px, 320px);
  gap: 18px;
  padding: 24px 28px 32px;
}
.panel {
  background: rgba(15, 30, 50, 0.86);
  border: 1px solid rgba(151, 188, 222, 0.15);
  border-radius: 16px;
  padding: 18px;
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.18);
}
@media (max-width: 1100px) {
  .main { grid-template-columns: minmax(285px, 340px) minmax(430px, 1fr); }
  .joints { grid-column: 1 / -1; }
}
@media (max-width: 760px) {
  .header, .main { padding-left: 16px; padding-right: 16px; }
  .main { grid-template-columns: 1fr; padding-top: 16px; }
  .joints { grid-column: auto; }
  .header { align-items: flex-start; gap: 14px; }
}
</style>
