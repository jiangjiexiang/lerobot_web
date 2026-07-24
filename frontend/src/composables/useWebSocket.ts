import { ref, onMounted, onUnmounted } from "vue";

export interface JointData {
  shoulder_pan: number;
  shoulder_lift: number;
  elbow_flex: number;
  wrist_flex: number;
  wrist_roll: number;
  gripper: number;
}

export interface WSMessage {
  type: string;
  leader?: JointData;
  follower?: JointData;
  running?: boolean;
  data?: string;
  ts?: number;
  [key: string]: unknown;
}

export interface DebugMetrics {
  controlFps: number;
  controlLatency: number | null;
  cameraFps: number;
  cameraLatency: number | null;
  cameraDropped: number;
  camera2Fps: number;
  camera2Latency: number | null;
  camera2Dropped: number;
  streamConnected: boolean;
}

export function useWebSocket() {
  const connected = ref(false);
  const running = ref(false);
  const leaderJoints = ref<JointData | null>(null);
  const followerJoints = ref<JointData | null>(null);
  const cameraFrame = ref<string | null>(null);
  const camera2Frame = ref<string | null>(null);
  const logs = ref<string[]>([]);
  const metrics = ref<DebugMetrics>({
    controlFps: 0, controlLatency: null,
    cameraFps: 0, cameraLatency: null, cameraDropped: 0,
    camera2Fps: 0, camera2Latency: null, camera2Dropped: 0,
    streamConnected: false,
  });

  let ws: WebSocket | null = null;
  let streamWs: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let streamReconnectTimer: number | null = null;
  let frameAnimation: number | null = null;
  let pendingCameraFrame: string | null = null;
  let pendingCamera2Frame: string | null = null;
  let metricsTimer: number | null = null;
  let controlFrames = 0;
  let cameraFrames = 0;
  let camera2Frames = 0;
  let cameraDropped = 0;
  let camera2Dropped = 0;
  let disposed = false;

  function latency(ts?: number): number | null {
    if (typeof ts !== "number") return null;
    return Math.max(0, Math.round(Date.now() - ts * 1000));
  }

  function updateMetrics() {
    metrics.value = {
      ...metrics.value,
      controlFps: controlFrames,
      cameraFps: cameraFrames,
      cameraDropped,
      camera2Fps: camera2Frames,
      camera2Dropped,
    };
    controlFrames = cameraFrames = camera2Frames = 0;
    cameraDropped = camera2Dropped = 0;
  }

  function scheduleFrames() {
    if (frameAnimation !== null) return;
    frameAnimation = requestAnimationFrame(() => {
      frameAnimation = null;
      if (pendingCameraFrame !== null) {
        cameraFrame.value = pendingCameraFrame;
        pendingCameraFrame = null;
      }
      if (pendingCamera2Frame !== null) {
        camera2Frame.value = pendingCamera2Frame;
        pendingCamera2Frame = null;
      }
    });
  }

  function log(msg: string) {
    const t = new Date().toLocaleTimeString();
    logs.value.unshift(`[${t}] ${msg}`);
    if (logs.value.length > 50) logs.value.pop();
  }

  function connect() {
    if (disposed || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/control`);

    ws.onopen = () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connected.value = true;
      log("WebSocket 已连接");
    };

    ws.onclose = () => {
      ws = null;
      connected.value = false;
      log("WebSocket 断开，3秒后重连...");
      if (!disposed && reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 3000);
      }
    };

    ws.onerror = () => log("WebSocket 错误");

    ws.onmessage = (ev) => {
      try {
        const msg: WSMessage = JSON.parse(ev.data);
        handleMessage(msg);
      } catch {
        // 忽略非 JSON
      }
    };
  }

  function connectStream() {
    if (disposed || (streamWs && (streamWs.readyState === WebSocket.CONNECTING || streamWs.readyState === WebSocket.OPEN))) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    streamWs = new WebSocket(`${proto}://${location.host}/ws/stream`);
    streamWs.onopen = () => { metrics.value = { ...metrics.value, streamConnected: true }; };
    streamWs.onmessage = (ev) => {
      try { handleMessage(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    };
    streamWs.onclose = () => {
      metrics.value = { ...metrics.value, streamConnected: false };
      streamWs = null;
      if (!disposed && streamReconnectTimer === null) {
        streamReconnectTimer = window.setTimeout(() => {
          streamReconnectTimer = null;
          connectStream();
        }, 3000);
      }
    };
  }

  function handleMessage(msg: WSMessage) {
    switch (msg.type) {
      case "status":
        running.value = msg.running ?? false;
        break;
      case "stopped":
        running.value = false;
        log("遥操作进程已退出");
        break;
      case "teleop_observation":
        controlFrames += 1;
        metrics.value.controlLatency = latency(msg.ts);
        if (msg.leader) leaderJoints.value = msg.leader;
        if (msg.follower) followerJoints.value = msg.follower;
        break;
      case "camera_frame":
        if (msg.data) {
          cameraFrames += 1;
          metrics.value.cameraLatency = latency(msg.ts);
          if (pendingCameraFrame !== null) cameraDropped += 1;
          pendingCameraFrame = msg.data;
          scheduleFrames();
        }
        break;
      case "camera2_frame":
        if (msg.data) {
          camera2Frames += 1;
          metrics.value.camera2Latency = latency(msg.ts);
          if (pendingCamera2Frame !== null) camera2Dropped += 1;
          pendingCamera2Frame = msg.data;
          scheduleFrames();
        }
        break;
    }
  }

  function send(msg: object) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  onMounted(() => {
    connect();
    connectStream();
    metricsTimer = window.setInterval(updateMetrics, 1000);
  });
  onUnmounted(() => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (streamReconnectTimer) clearTimeout(streamReconnectTimer);
    if (frameAnimation !== null) cancelAnimationFrame(frameAnimation);
    if (metricsTimer !== null) clearInterval(metricsTimer);
    if (ws) ws.close();
    if (streamWs) streamWs.close();
  });

  return {
    connected,
    running,
    leaderJoints,
    followerJoints,
    cameraFrame,
    camera2Frame,
    logs,
    metrics,
    log,
    send,
  };
}
