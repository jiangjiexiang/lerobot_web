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

export function useWebSocket() {
  const connected = ref(false);
  const running = ref(false);
  const leaderJoints = ref<JointData | null>(null);
  const followerJoints = ref<JointData | null>(null);
  const cameraFrame = ref<string | null>(null);
  const camera2Frame = ref<string | null>(null);
  const logs = ref<string[]>([]);

  let ws: WebSocket | null = null;
  let streamWs: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let streamReconnectTimer: number | null = null;
  let disposed = false;

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
      connected.value = false;
      running.value = false;
      log("WebSocket 断开，3秒后重连...");
      if (!disposed) reconnectTimer = window.setTimeout(connect, 3000);
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
    streamWs.onmessage = (ev) => {
      try { handleMessage(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
    };
    streamWs.onclose = () => {
      if (!disposed) streamReconnectTimer = window.setTimeout(connectStream, 3000);
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
        if (msg.leader) leaderJoints.value = msg.leader;
        if (msg.follower) followerJoints.value = msg.follower;
        break;
      case "camera_frame":
        if (msg.data) cameraFrame.value = msg.data;
        break;
      case "camera2_frame":
        if (msg.data) camera2Frame.value = msg.data;
        break;
    }
  }

  function send(msg: object) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  onMounted(() => { connect(); connectStream(); });
  onUnmounted(() => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (streamReconnectTimer) clearTimeout(streamReconnectTimer);
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
    log,
    send,
  };
}
