import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import { execSync } from "child_process";
import { RobotBridge, BridgeMessage } from "./robotBridge";
import { MJPEGStreamManager } from "./streams";

// 配置
const PORT = parseInt(process.env.PORT || "3000");
const BRIDGE_DIR = process.env.BRIDGE_DIR || path.join(__dirname, "../../bridge");
const TELEOP_SCRIPT = path.join(BRIDGE_DIR, "teleop_mujoco.py");
const PYTHON_PATH = process.env.PYTHON_PATH || "/home/jiang/miniconda3/envs/lerobot/bin/python";
const FRONTEND_DIST = path.join(__dirname, "../../frontend/dist");

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const streamManager = new MJPEGStreamManager();

// 桥接状态
let bridge: RobotBridge | null = null;
let latestObservation: BridgeMessage | null = null;
const clients = new Set<WebSocket>();

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

// 启动遥操作
app.post("/api/start", (req, res) => {
  if (bridge && bridge.isRunning()) {
    res.status(400).json({ ok: false, error: "已在运行中" });
    return;
  }

  const {
    follower_port = "/dev/ttyACM0",
    follower_id = "",
    leader_port = "/dev/ttyACM1",
    leader_id = "",
    fps = 30,
    viewer = false,
  } = req.body;

  const args = [
    "--follower-port", follower_port,
    "--follower-id", follower_id,
    "--leader-port", leader_port,
    "--leader-id", leader_id,
    "--fps", String(fps),
  ];
  if (viewer) args.push("--viewer");

  console.log(`[Server] 启动遥操作: ${PYTHON_PATH} ${TELEOP_SCRIPT} ${args.join(" ")}`);

  bridge = new RobotBridge(TELEOP_SCRIPT, args, PYTHON_PATH);

  bridge.on("message", (msg: BridgeMessage) => {
    switch (msg.type) {
      case "teleop_observation":
        latestObservation = msg;
        broadcast(msg);
        break;

      case "mujoco_frame":
        if (msg.data) {
          streamManager.updateFrameFromBase64("mujoco", msg.data);
          // 网页端通过 WebSocket 接收实时帧；MJPEG 端点则供外部客户端使用。
          broadcast(msg);
        }
        break;

      case "camera_frame":
        if (msg.data) {
          streamManager.updateFrameFromBase64("camera", msg.data);
        }
        break;

      default:
        console.log(`[Server] 未知消息类型: ${msg.type}`);
    }
  });

  bridge.on("exit", (code) => {
    console.log(`[Server] 遥操作进程退出 (code=${code})`);
    bridge = null;
    broadcast({ type: "stopped" });
  });

  bridge.on("error", (err) => {
    console.error(`[Server] 桥接错误:`, err);
  });

  bridge.start();
  broadcast({ type: "status", running: true });
  res.json({ ok: true, msg: "遥操作已启动" });
});

// 停止遥操作
app.post("/api/stop", (req, res) => {
  if (!bridge || !bridge.isRunning()) {
    res.status(400).json({ ok: false, error: "未在运行" });
    return;
  }
  const activeBridge = bridge;
  bridge = null;
  activeBridge.stop();
  // 不等待 Python 清理完成才更新界面，避免停止按钮看起来没有反应。
  broadcast({ type: "status", running: false });
  res.json({ ok: true });
});

// 状态查询
app.get("/api/status", (req, res) => {
  res.json({
    running: bridge ? bridge.isRunning() : false,
    clients: clients.size,
  });
});

// MJPEG 流端点
app.get("/video/mujoco", (req, res) => {
  streamManager.handleStream("mujoco", req, res);
});

app.get("/video/camera", (req, res) => {
  streamManager.handleStream("camera", req, res);
});

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    bridge_running: bridge ? bridge.isRunning() : false,
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
      api: ["/api/ports", "/api/start", "/api/stop", "/api/status", "/health", "/ws"],
    });
  }
});

// ===================== WebSocket =====================

wss.on("connection", (ws) => {
  console.log("[Server] 新客户端连接");
  clients.add(ws);

  // 发送当前状态
  ws.send(JSON.stringify({ type: "status", running: bridge ? bridge.isRunning() : false }));

  // 发送最新 observation
  if (latestObservation) {
    ws.send(JSON.stringify(latestObservation));
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "action" && bridge) {
        bridge.send(msg);
      }
    } catch (err) {
      console.error("[Server] 解析客户端消息失败:", err);
    }
  });

  ws.on("close", () => {
    console.log("[Server] 客户端断开");
    clients.delete(ws);
  });
});

function broadcast(msg: BridgeMessage): void {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ===================== 启动 =====================

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Robot Server] 监听在 http://0.0.0.0:${PORT}`);
  console.log(`[Robot Server] WebSocket: ws://0.0.0.0:${PORT}/ws`);
  console.log(`[Robot Server] MuJoCo流: http://0.0.0.0:${PORT}/video/mujoco`);
  console.log(`[Robot Server] API: /api/ports /api/start /api/stop /api/status`);
});

process.on("SIGINT", () => {
  console.log("[Robot Server] 退出中...");
  if (bridge) bridge.stop();
  for (const client of clients) client.close();
  server.close();
  process.exit(0);
});
