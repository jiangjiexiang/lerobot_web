import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import { LeaderBridge, LeaderMessage } from "./leaderBridge";
import { RemoteClient, RemoteMessage } from "./remoteClient";

// 配置
const PORT = parseInt(process.env.PORT || "3001");
const REMOTE_HOST = process.env.REMOTE_HOST || "localhost";
const REMOTE_PORT = parseInt(process.env.REMOTE_PORT || "3000");
const BRIDGE_PATH = process.env.BRIDGE_PATH || path.join(__dirname, "../../bridge/leader_bridge.py");
const LEADER_PORT = process.env.LEADER_PORT || "/dev/ttyACM1";
const LEADER_ID = process.env.LEADER_ID || "";
const FPS = parseInt(process.env.FPS || "30");
const PYTHON_PATH = process.env.PYTHON_PATH || "python3";

const app = express();
app.use(cors());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// 存储最新数据
let latestFollowerObservation: RemoteMessage | null = null;
let latestLeaderObservation: LeaderMessage | null = null;

// 启动本地 leader Python 桥接
const leaderArgs = [
  "--port", LEADER_PORT,
  "--teleop-id", LEADER_ID,
  "--fps", FPS.toString(),
];

const leaderBridge = new LeaderBridge(BRIDGE_PATH, leaderArgs, PYTHON_PATH);

leaderBridge.on("message", (msg: LeaderMessage) => {
  if (msg.type === "leader_observation") {
    latestLeaderObservation = msg;
    // 广播 leader 数据给前端
    broadcastToLocal({ type: "leader_observation", joints: msg.joints, ts: msg.ts });
    // 发送 leader 动作到机器人电脑
    if (msg.joints) {
      remoteClient.sendAction(msg.joints);
    }
  }
});

leaderBridge.on("exit", (code) => {
  console.log(`[Operator] Leader 桥接退出 (code=${code})，5秒后重启...`);
  setTimeout(() => {
    leaderBridge.start();
  }, 5000);
});

leaderBridge.start();

// 连接远程机器人电脑
const remoteClient = new RemoteClient(REMOTE_HOST, REMOTE_PORT);

remoteClient.on("message", (msg: RemoteMessage) => {
  if (msg.type === "observation") {
    latestFollowerObservation = msg;
    // 转发给前端
    broadcastToLocal(msg);
  }
});

remoteClient.on("connected", () => {
  broadcastToLocal({ type: "status", status: "remote_connected" });
});

remoteClient.on("disconnected", () => {
  broadcastToLocal({ type: "status", status: "remote_disconnected" });
});

remoteClient.connect();

// 本地 WebSocket 客户端连接
const localClients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  console.log("[Operator] 本地前端客户端连接");
  localClients.add(ws);

  // 发送最新数据给新客户端
  if (latestFollowerObservation) {
    ws.send(JSON.stringify(latestFollowerObservation));
  }
  if (latestLeaderObservation) {
    ws.send(JSON.stringify({ type: "leader_observation", joints: latestLeaderObservation.joints, ts: latestLeaderObservation.ts }));
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // 前端可以发送控制指令
      if (msg.type === "action" && msg.joints) {
        remoteClient.sendAction(msg.joints);
      }
    } catch (err) {
      console.error("[Operator] 解析前端消息失败:", err);
    }
  });

  ws.on("close", () => {
    console.log("[Operator] 本地前端客户端断开");
    localClients.delete(ws);
  });
});

function broadcastToLocal(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const client of localClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// 代理 MJPEG 视频流（从机器人电脑转发）
app.get("/video/camera", (req, res) => {
  const proxyUrl = `http://${REMOTE_HOST}:${REMOTE_PORT}/video/camera`;
  res.redirect(proxyUrl);
});

app.get("/video/mujoco", (req, res) => {
  const proxyUrl = `http://${REMOTE_HOST}:${REMOTE_PORT}/video/mujoco`;
  res.redirect(proxyUrl);
});

// 健康检查
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    leader_bridge_running: leaderBridge.isRunning(),
    remote_connected: remoteClient.isConnected(),
    local_clients: localClients.size,
  });
});

// 启动服务器
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Operator Server] 监听在 http://0.0.0.0:${PORT}`);
  console.log(`[Operator Server] WebSocket: ws://0.0.0.0:${PORT}/ws`);
  console.log(`[Operator Server] 远程机器人电脑: ${REMOTE_HOST}:${REMOTE_PORT}`);
});

// 优雅退出
process.on("SIGINT", () => {
  console.log("[Operator Server] 收到 SIGINT，正在退出...");
  leaderBridge.stop();
  remoteClient.disconnect();
  for (const client of localClients) {
    client.close();
  }
  server.close();
  process.exit(0);
});
