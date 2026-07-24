import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import fs from "fs";
import { execSync, exec } from "child_process";
import { RobotBridge, BridgeMessage } from "./robotBridge";
import { MJPEGStreamManager } from "./streams";

// 配置
const PORT = parseInt(process.env.PORT || "4000");
const BRIDGE_DIR = process.env.BRIDGE_DIR || path.join(__dirname, "../../bridge");
const TELEOP_SCRIPT = path.join(BRIDGE_DIR, "teleop_mujoco.py");
const CAMERA_SCRIPT = path.join(BRIDGE_DIR, "camera_stream.py");
const PYTHON_PATH = process.env.PYTHON_PATH || "python3";
const FRONTEND_DIST = path.join(__dirname, "../../frontend/dist");
const ENABLE_CAMERA = process.env.ENABLE_CAMERA !== "0" && process.env.ENABLE_CAMERA !== "false";
const CAMERA_FPS = parseInt(process.env.CAMERA_FPS || "15", 10);
const DEFAULT_STREAM_FPS = parseInt(process.env.STREAM_FPS || "0", 10);

function detectUsbCameraIndices(): number[] {
  try {
    const out = execSync("v4l2-ctl --list-devices 2>/dev/null", { encoding: "utf-8" });
    const indices: number[] = [];
    const blocks = out.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) continue;
      const name = lines[0].toLowerCase();
      if (name.includes("tegra") || name.includes("vi-output")) continue;
      // 每个 USB 摄像头设备块中有多个 video 节点，只取第一个
      for (let i = 1; i < lines.length; i++) {
        const m = lines[i].trim().match(/\/dev\/video(\d+)/);
        if (m) {
          indices.push(parseInt(m[1], 10));
          break;
        }
      }
    }
    indices.sort((a, b) => a - b);
    return indices;
  } catch {
    return [];
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
// 控制和视频必须使用不同连接；视频拥塞时不能阻塞 30/60Hz 控制链路。
const controlWss = new WebSocketServer({ noServer: true });
const streamWss = new WebSocketServer({ noServer: true });

// 显式路由 WebSocket Upgrade，避免多个 WebSocketServer 监听同一 HTTP Server
// 时请求被错误当成普通 HTTP/SPA 请求，导致浏览器出现 Invalid frame header。
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname;
  if (pathname === "/ws/control") {
    controlWss.handleUpgrade(request, socket, head, (ws) => controlWss.emit("connection", ws, request));
  } else if (pathname === "/ws/stream") {
    streamWss.handleUpgrade(request, socket, head, (ws) => streamWss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

const streamManager = new MJPEGStreamManager();

// 桥接状态
let bridge: RobotBridge | null = null;
let stopping = false;
let remoteLeaderActive = false;
let latestObservation: BridgeMessage | null = null;
const clients = new Set<WebSocket>();
const streamClients = new Set<WebSocket>();

// 摄像头是可选资源：默认关闭，避免服务启动时常驻 OpenCV 进程并占用 USB 摄像头。
let cameraBridge: RobotBridge | null = null;
let activeCameraIndex = -1;
function startCamera(index: number): void {
  if (!ENABLE_CAMERA || index < 0) return;
  if (cameraBridge) cameraBridge.stop();
  activeCameraIndex = index;
  cameraBridge = new RobotBridge(CAMERA_SCRIPT, ["--camera-index", String(index), "--fps", String(CAMERA_FPS)], PYTHON_PATH);
  cameraBridge.on("message", (msg: BridgeMessage) => {
    if (msg.type === "camera_frame" && msg.data) {
      streamManager.updateFrameFromBase64("camera", msg.data);
      broadcastStream(msg);
    } else if (msg.type === "camera_error") console.error(`[Camera] ${String(msg.error || "摄像头不可用")}`);
  });
  cameraBridge.start();
  console.log(`[Camera] 已启用 /dev/video${index} (${CAMERA_FPS} FPS)`);
}

// 第二个摄像头（可选）
let cameraBridge2: RobotBridge | null = null;
let activeCameraIndex2 = -1;
function startCamera2(index: number): void {
  if (!ENABLE_CAMERA || index < 0) return;
  if (cameraBridge2) cameraBridge2.stop();
  activeCameraIndex2 = index;
  cameraBridge2 = new RobotBridge(CAMERA_SCRIPT, ["--camera-index", String(index), "--fps", String(CAMERA_FPS)], PYTHON_PATH);
  cameraBridge2.on("message", (msg: BridgeMessage) => {
    if (msg.type === "camera_frame" && msg.data) {
      streamManager.updateFrameFromBase64("camera2", msg.data);
      broadcastStream({ type: "camera2_frame", data: msg.data, ts: msg.ts });
    } else if (msg.type === "camera_error") console.error(`[Camera2] ${String(msg.error || "摄像头不可用")}`);
  });
  cameraBridge2.start();
  console.log(`[Camera2] 已启用 /dev/video${index} (${CAMERA_FPS} FPS)`);
}

if (ENABLE_CAMERA) {
  const cameraIndices = detectUsbCameraIndices();
  if (cameraIndices.length > 0) {
    console.log(`[Camera] 检测到 ${cameraIndices.length} 个 USB 摄像头: ${cameraIndices.map(i => `/dev/video${i}`).join(", ")}`);
    startCamera(cameraIndices[0]);
    if (cameraIndices.length > 1) startCamera2(cameraIndices[1]);
  } else {
    console.log("[Camera] 未检测到 USB 摄像头");
  }
} else {
  console.log("[Camera] 默认关闭；需要摄像头时设置 ENABLE_CAMERA=1");
}

// ===================== API =====================

// 串口检测
app.get("/api/ports", (req, res) => {
  try {
    // 分别检测 ACM 和 USB，避免某个 glob 无匹配导致 ls 返回非零
    const ports: string[] = [];
    try {
      const acm = execSync("ls -1 /dev/ttyACM* 2>/dev/null", { encoding: "utf-8" }).trim();
      if (acm) ports.push(...acm.split("\n").filter((p) => p.trim() !== ""));
    } catch { /* no ACM */ }
    try {
      const usb = execSync("ls -1 /dev/ttyUSB* 2>/dev/null", { encoding: "utf-8" }).trim();
      if (usb) ports.push(...usb.split("\n").filter((p) => p.trim() !== ""));
    } catch { /* no USB */ }
    ports.sort();
    res.json({ ports });
  } catch {
    res.json({ ports: [] });
  }
});

app.get("/api/cameras", (req, res) => {
  try {
    const cameras = fs.readdirSync("/dev").filter((name) => /^video\\d+$/.test(name)).sort()
      .map((name) => ({ index: Number(name.slice(5)), path: `/dev/${name}` }));
    res.json({
      cameras,
      active: { camera: activeCameraIndex, camera2: activeCameraIndex2 },
      detected: detectUsbCameraIndices(),
    });
  } catch {
    res.json({
      cameras: [],
      active: { camera: activeCameraIndex, camera2: activeCameraIndex2 },
      detected: [],
    });
  }
});

// 仅向已打开控制台的浏览器提供指定 Leader 的公开标定数据；ID 限制防止路径穿越。
app.get("/api/calibration/leader/:id", (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    res.status(400).json({ ok: false, error: "无效的 Leader ID" });
    return;
  }
  const file = path.join(process.env.HOME || "/root", ".lerobot", "calibration", "so101_leader", `${id}.json`);
  try {
    res.json({ ok: true, calibration: JSON.parse(fs.readFileSync(file, "utf-8")) });
  } catch {
    res.status(404).json({ ok: false, error: `找不到 Leader 标定文件: ${id}` });
  }
});

// 启动遥操作
app.post("/api/start", (req, res) => {
  if (bridge && bridge.isRunning()) {
    res.status(400).json({ ok: false, error: stopping ? "正在停止，请稍候" : "已在运行中" });
    return;
  }

  const {
    follower_port = "/dev/ttyACM0",
    follower_id = "",
    leader_port = "/dev/ttyACM1",
    leader_id = "",
    fps = 30,
    stream_fps = DEFAULT_STREAM_FPS,
    viewer = false,
    remote_leader = false,
    camera_index = -1,
    camera_fps = 15,
  } = req.body;

  if (ENABLE_CAMERA && Number.isInteger(camera_index) && camera_index >= 0 && camera_index !== activeCameraIndex) {
    startCamera(camera_index);
  }

  const args = [
    "--follower-port", follower_port,
    "--follower-id", follower_id,
    "--leader-port", leader_port,
    "--leader-id", leader_id,
    "--fps", String(fps),
    "--stream-fps", String(stream_fps),
  ];
  if (viewer) args.push("--viewer");
  if (remote_leader) args.push("--remote-leader");
  if (Number.isInteger(camera_index) && camera_index >= 0) {
    args.push("--camera-index", String(camera_index), "--camera-fps", String(camera_fps));
  }

  console.log(`[Server] 启动遥操作: ${PYTHON_PATH} ${TELEOP_SCRIPT} ${args.join(" ")}`);

  const startedBridge = new RobotBridge(TELEOP_SCRIPT, args, PYTHON_PATH);
  bridge = startedBridge;
  stopping = false;
  remoteLeaderActive = Boolean(remote_leader);

  startedBridge.on("message", (msg: BridgeMessage) => {
    switch (msg.type) {
      case "teleop_observation":
        latestObservation = msg;
        broadcastControl(msg);
        break;

      case "camera_frame":
        if (msg.data) {
          streamManager.updateFrameFromBase64("camera", msg.data);
          broadcastStream(msg);
        }
        break;

      default:
        console.log(`[Server] 未知消息类型: ${msg.type}`);
    }
  });

  startedBridge.on("exit", (code) => {
    console.log(`[Server] 遥操作进程退出 (code=${code})`);
    // 旧进程的退出不能影响之后启动的新进程。
    if (bridge === startedBridge) {
      bridge = null;
      stopping = false;
      remoteLeaderActive = false;
      broadcastControl({ type: "stopped" });
    }
  });

  startedBridge.on("error", (err) => {
    console.error(`[Server] 桥接错误:`, err);
  });

  startedBridge.start();
  broadcastControl({ type: "status", running: true });
  res.json({ ok: true, msg: "遥操作已启动" });
});

// 停止遥操作
app.post("/api/stop", (req, res) => {
  if (!bridge || !bridge.isRunning()) {
    res.status(400).json({ ok: false, error: "未在运行" });
    return;
  }
  const activeBridge = bridge;
  stopping = true;
  activeBridge.stop();
  // 不等待 Python 清理完成才更新界面，避免停止按钮看起来没有反应。
  broadcastControl({ type: "status", running: false });
  res.json({ ok: true });
});

// 状态查询
app.get("/api/status", (req, res) => {
  res.json({
    running: bridge ? bridge.isRunning() && !stopping : false,
    clients: clients.size,
  });
});

// 切换摄像头
app.post("/api/camera/switch", (req, res) => {
  const { view, index } = req.body;
  if (view !== "camera" && view !== "camera2") {
    res.status(400).json({ ok: false, error: "view 必须是 camera 或 camera2" });
    return;
  }
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ ok: false, error: "index 必须是正整数" });
    return;
  }
  if (view === "camera") {
    startCamera(index);
  } else {
    startCamera2(index);
  }
  res.json({ ok: true, view, index, active: view === "camera" ? activeCameraIndex : activeCameraIndex2 });
});

// MJPEG 流端点
app.get("/video/camera", (req, res) => {
  streamManager.handleStream("camera", req, res);
});

app.get("/video/camera2", (req, res) => {
  streamManager.handleStream("camera2", req, res);
});

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    bridge_running: bridge ? bridge.isRunning() && !stopping : false,
    clients_connected: clients.size,
    has_observation: latestObservation !== null,
  });
});

// serve 前端静态文件 (生产模式)
app.use(express.static(FRONTEND_DIST));

// SPA fallback (前端未构建时返回提示，不报 404)
app.use((req, res) => {
  const indexFile = path.join(FRONTEND_DIST, "index.html");
  if (require("fs").existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    res.json({
      status: "ok",
      message: "前端未构建，开发模式请访问 http://localhost:5173",
      api: ["/api/ports", "/api/start", "/api/stop", "/api/status", "/health", "/ws/control", "/ws/stream"],
    });
  }
});

// ===================== WebSocket =====================

controlWss.on("connection", (ws) => {
  console.log("[Server] 新控制客户端连接");
  clients.add(ws);

  // 发送当前状态
  ws.send(JSON.stringify({ type: "status", running: bridge ? bridge.isRunning() && !stopping : false }));

  // 发送最新 observation
  if (latestObservation) {
    ws.send(JSON.stringify(latestObservation));
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "action" && bridge && remoteLeaderActive) {
        bridge.send(msg);
      }
    } catch (err) {
      console.error("[Server] 解析客户端消息失败:", err);
    }
  });

  ws.on("close", () => {
    console.log("[Server] 控制客户端断开");
    clients.delete(ws);
  });
});

streamWss.on("connection", (ws) => {
  console.log("[Server] 新推流客户端连接");
  streamClients.add(ws);
  ws.on("close", () => streamClients.delete(ws));
});

function broadcastControl(msg: BridgeMessage | object): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function broadcastStream(msg: BridgeMessage | object): void {
  const data = JSON.stringify(msg);
  for (const client of streamClients) {
    if (client.readyState === WebSocket.OPEN) {
      // 推流只保留最新帧；慢客户端直接丢弃，绝不形成积压。
      if (client.bufferedAmount > 512 * 1024) continue;
      client.send(data);
    }
  }
}

// ===================== 启动 =====================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Robot Server] 监听在 http://0.0.0.0:${PORT}`);
  console.log(`[Robot Server] 控制 WebSocket: ws://0.0.0.0:${PORT}/ws/control`);
  console.log(`[Robot Server] 推流 WebSocket: ws://0.0.0.0:${PORT}/ws/stream`);
  console.log(`[Robot Server] 摄像头1: http://0.0.0.0:${PORT}/video/camera`);
  console.log(`[Robot Server] 摄像头2: http://0.0.0.0:${PORT}/video/camera2`);
  console.log(`[Robot Server] API: /api/ports /api/start /api/stop /api/status`);
});

process.on("SIGINT", () => {
  console.log("[Robot Server] 退出中...");
  if (bridge) bridge.stop();
  if (cameraBridge) cameraBridge.stop();
  if (cameraBridge2) cameraBridge2.stop();
  for (const client of clients) client.close();
  server.close();
  process.exit(0);
});
