import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execSync, execFile, execFileSync, spawn, ChildProcess } from "child_process";
import { RobotBridge, BridgeMessage } from "./robotBridge";
import { MJPEGStreamManager } from "./streams";
import { RtcGateway } from "./rtcGateway";
import { CameraBridgeMessage, GStreamerCameraBridge } from "./gstreamerCameraBridge";

// 配置
const PORT = parseInt(process.env.PORT || "43127");
const BRIDGE_DIR = process.env.BRIDGE_DIR || path.join(__dirname, "../../bridge");
const TELEOP_SCRIPT = path.join(BRIDGE_DIR, "teleop_robot.py");
const RECORDER_SCRIPT = path.join(BRIDGE_DIR, "dataset_recorder.py");
const DATASET_CATALOG_SCRIPT = path.join(BRIDGE_DIR, "dataset_catalog.py");
const PYTHON_PATH = process.env.PYTHON_PATH || "python3";
const CONTROL_PYTHON_PATH = PYTHON_PATH;
const FRONTEND_DIST = path.join(__dirname, "../../frontend/dist");
const DATASET_ROOT = path.resolve(process.env.DATASET_ROOT || path.join(process.env.HOME || "/tmp", "lerobot_datasets"));
const ENABLE_CAMERA = process.env.ENABLE_CAMERA !== "0" && process.env.ENABLE_CAMERA !== "false";
const CAMERA_FPS = parseInt(process.env.CAMERA_FPS || "30", 10);
const CAMERA_WIDTH = parseInt(process.env.CAMERA_WIDTH || "640", 10);
const CAMERA_HEIGHT = parseInt(process.env.CAMERA_HEIGHT || "360", 10);
const RECORDING_MAX_SENSOR_AGE_MS = parseInt(process.env.RECORDING_MAX_SENSOR_AGE_MS || "250", 10);
const RECORDING_MAX_CAMERA_SKEW_MS = parseInt(process.env.RECORDING_MAX_CAMERA_SKEW_MS || "100", 10);
const DATASET_STREAMING_ENCODING = process.env.DATASET_STREAMING_ENCODING || "auto";
const DATASET_VIDEO_CODEC = process.env.DATASET_VIDEO_CODEC || "auto";
const CONTROL_OBSERVATION_FPS = parseInt(process.env.CONTROL_OBSERVATION_FPS || "30", 10);
const ENABLE_WEBRTC = process.env.ENABLE_WEBRTC !== "0" && process.env.ENABLE_WEBRTC !== "false";
const ENABLE_WEBRTC_VIDEO = process.env.ENABLE_WEBRTC_VIDEO === "1" || process.env.ENABLE_WEBRTC_VIDEO === "true";
const RTC_VIDEO_FPS = parseInt(process.env.RTC_VIDEO_FPS || "15", 10);
const RTC_VIDEO_BITRATE = parseInt(process.env.RTC_VIDEO_BITRATE || "1500000", 10);
const RTC_CONTROL_TIMEOUT_MS = parseInt(process.env.RTC_CONTROL_TIMEOUT_MS || "2000", 10);
const RTC_ICE_SERVERS = [
  ...(process.env.RTC_STUN_URL ? [{ urls: process.env.RTC_STUN_URL }] : []),
  ...(process.env.RTC_TURN_URL ? [{
    urls: process.env.RTC_TURN_URL,
    username: process.env.RTC_TURN_USERNAME,
    credential: process.env.RTC_TURN_CREDENTIAL,
  }] : []),
];
const TRAINING_ROOT = path.join(DATASET_ROOT, ".lerobot-web", "training");
const RUNTIME_LOG_ROOT = path.join(DATASET_ROOT, ".lerobot-web", "logs");
const CONTROL_LATENCY_LOG_ROOT = path.join(RUNTIME_LOG_ROOT, "latency");
const DATASET_TRASH_ROOT = path.join(DATASET_ROOT, ".lerobot-web", "trash");

type RuntimeLogLevel = "info" | "warn" | "error";
type RuntimeLogSource = "teleop" | "recorder" | "system";

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localLogSessionKey(date = new Date()): string {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join("-");
  return `${localDateKey(date)}_${time}_${process.pid}`;
}

const RUNTIME_LOG_SESSION_ID = localLogSessionKey();
const pendingLogWrites = new Map<string, string[]>();
const pendingLogFlushes = new Map<string, NodeJS.Timeout>();

function queueJsonlLog(root: string, filename: string, entry: Record<string, unknown>): void {
  const file = path.join(root, filename);
  const lines = pendingLogWrites.get(file) || [];
  lines.push(`${JSON.stringify(entry)}\n`);
  pendingLogWrites.set(file, lines);
  if (pendingLogFlushes.has(file)) return;

  const timer = setTimeout(() => {
    pendingLogFlushes.delete(file);
    const buffered = pendingLogWrites.get(file);
    pendingLogWrites.delete(file);
    if (!buffered?.length) return;
    fs.mkdir(root, { recursive: true }, (mkdirError) => {
      if (mkdirError) {
        console.error("[Logs] 创建日志目录失败:", mkdirError);
        return;
      }
      fs.appendFile(file, buffered.join(""), "utf-8", (writeError) => {
        if (writeError) console.error("[Logs] 写入本地日志失败:", writeError);
      });
    });
  }, 250);
  timer.unref();
  pendingLogFlushes.set(file, timer);
}

function persistRuntimeLog(source: RuntimeLogSource, level: RuntimeLogLevel, message: string): void {
  queueJsonlLog(RUNTIME_LOG_ROOT, `${RUNTIME_LOG_SESSION_ID}.jsonl`, {
    timestamp: new Date().toISOString(), source, level, message,
  });
}

function persistControlLatency(metrics: Record<string, number | null>): void {
  queueJsonlLog(CONTROL_LATENCY_LOG_ROOT, `${RUNTIME_LOG_SESSION_ID}.jsonl`, {
    timestamp: new Date().toISOString(),
    ...metrics,
  });
}

persistRuntimeLog("system", "info", `Robot Server 启动，会话 ${RUNTIME_LOG_SESSION_ID}`);

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

const httpsCert = process.env.HTTPS_CERT;
const httpsKey = process.env.HTTPS_KEY;
const server = httpsCert && httpsKey
  ? createHttpsServer({ cert: fs.readFileSync(httpsCert), key: fs.readFileSync(httpsKey) }, app)
  : createHttpServer(app);
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
let shuttingDown = false;
let remoteLeaderActive = false;
let latestObservation: BridgeMessage | null = null;
let latestObservationAt = 0;
const clients = new Set<WebSocket>();
const streamClients = new Set<WebSocket>();
let controlDisconnectTimer: NodeJS.Timeout | null = null;

function stopTeleop(): boolean {
  if (!bridge || !bridge.isRunning()) return false;
  requestRecordingSave();
  stopping = true;
  bridge.stop();
  broadcastControl({ type: "status", running: false });
  return true;
}

const rtcGateway = new RtcGateway({
  enabled: ENABLE_WEBRTC,
  videoEnabled: ENABLE_WEBRTC_VIDEO,
  iceServers: RTC_ICE_SERVERS,
  maxVideoFps: RTC_VIDEO_FPS,
  maxVideoBitrate: RTC_VIDEO_BITRATE,
  controlTimeoutMs: RTC_CONTROL_TIMEOUT_MS,
  onControl: (message) => {
    if (bridge?.isRunning() && remoteLeaderActive && !stopping) {
      bridge.send(message as BridgeMessage);
    }
  },
  onSafetyStop: () => { stopTeleop(); },
  onControlLost: (reason, idleMs) => {
    const detail = `${reason}, ${Math.round(idleMs)}ms 未收到控制消息`;
    // The browser keeps a separate control WebSocket open as a transport
    // fallback. A transient RTC failure must not tear down an otherwise healthy
    // teleop session; the Python command timeout already holds position until
    // fresh fallback actions arrive.
    if (remoteLeaderActive && clients.size > 0) {
      console.warn(`[WebRTC] 控制链路异常 (${detail})，已切换到 WebSocket 控制`);
      return;
    }
    if (remoteLeaderActive && stopTeleop()) {
      console.warn(`[WebRTC] 控制链路异常 (${detail}) 且 WebSocket 不可用，已停止遥操作`);
    }
  },
});

// 摄像头是可选资源：关闭时不启动 GStreamer，也不占用 USB 摄像头。
let cameraBridge: GStreamerCameraBridge | null = null;
let activeCameraIndex = -1;
let cameraLastFrameAt = 0;
let cameraError: string | null = null;
let cameraMetrics: Record<string, unknown> = {};
let latestCameraFrame: Buffer | null = null;
let cameraLocalFrameAt = 0;
function startCamera(index: number): void {
  if (!ENABLE_CAMERA || index < 0) return;
  if (cameraBridge) cameraBridge.stop();
  activeCameraIndex = index;
  cameraLastFrameAt = 0;
  cameraError = null;
  cameraMetrics = {};
  cameraBridge = new GStreamerCameraBridge(index, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS);
  cameraBridge.on("message", (msg: CameraBridgeMessage) => {
    if (msg.type === "camera_frame" && msg.data) {
      cameraLastFrameAt = Date.now();
      const jpeg = msg.data;
      latestCameraFrame = jpeg;
      cameraLocalFrameAt = Date.now();
      streamManager.updateFrame("camera", jpeg);
      broadcastBinaryFrame(STREAM_TYPE_CAMERA, typeof msg.ts === "number" ? msg.ts : Date.now() / 1000, jpeg);
    } else if (msg.type === "camera_error") {
      cameraError = String(msg.error || "摄像头不可用");
      console.error(`[Camera] ${cameraError}`);
    } else if (msg.type === "camera_ready") {
      cameraError = null;
      cameraMetrics = { ...cameraMetrics, ...msg };
    } else if (msg.type === "camera_status") {
      cameraMetrics = { ...cameraMetrics, ...msg };
    }
  });
  cameraBridge.start();
  console.log(`[Camera] 已启用 /dev/video${index} (${CAMERA_FPS} FPS)`);
}

// 第二个摄像头（可选）
let cameraBridge2: GStreamerCameraBridge | null = null;
let activeCameraIndex2 = -1;
let camera2LastFrameAt = 0;
let camera2Error: string | null = null;
let camera2Metrics: Record<string, unknown> = {};
let latestCamera2Frame: Buffer | null = null;
let camera2LocalFrameAt = 0;
function startCamera2(index: number): void {
  if (!ENABLE_CAMERA || index < 0) return;
  if (cameraBridge2) cameraBridge2.stop();
  activeCameraIndex2 = index;
  camera2LastFrameAt = 0;
  camera2Error = null;
  camera2Metrics = {};
  cameraBridge2 = new GStreamerCameraBridge(index, CAMERA_WIDTH, CAMERA_HEIGHT, CAMERA_FPS);
  cameraBridge2.on("message", (msg: CameraBridgeMessage) => {
    if (msg.type === "camera_frame" && msg.data) {
      camera2LastFrameAt = Date.now();
      const jpeg = msg.data;
      latestCamera2Frame = jpeg;
      camera2LocalFrameAt = Date.now();
      streamManager.updateFrame("camera2", jpeg);
      broadcastBinaryFrame(STREAM_TYPE_CAMERA2, typeof msg.ts === "number" ? msg.ts : Date.now() / 1000, jpeg);
    } else if (msg.type === "camera_error") {
      camera2Error = String(msg.error || "摄像头不可用");
      console.error(`[Camera2] ${camera2Error}`);
    } else if (msg.type === "camera_ready") {
      camera2Error = null;
      camera2Metrics = { ...camera2Metrics, ...msg };
    } else if (msg.type === "camera_status") {
      camera2Metrics = { ...camera2Metrics, ...msg };
    }
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

type RecordingState = "idle" | "preparing" | "recording" | "saving" | "error";
interface RecordingStatus {
  state: RecordingState;
  dataset: string | null;
  task: string | null;
  fps: number;
  frames: number;
  episode: number | null;
  path: string | null;
  error: string | null;
  plannedEpisodes: number;
  episodeTime: number;
  resetTime: number;
  resume: boolean;
}

let recorder: RobotBridge | null = null;
let recorderFramePending = false;
let nextRecorderFrameAt = 0;
let recordingStatus: RecordingStatus = {
  state: "idle", dataset: null, task: null, fps: 30, frames: 0,
  episode: null, path: null, error: null, plannedEpisodes: 10, episodeTime: 20, resetTime: 5, resume: false,
};

function publishRecordingStatus(): void {
  broadcastControl({ type: "recording_status", ...recordingStatus });
}

function requestRecordingSave(): boolean {
  if (!recorder?.isRunning() || !["preparing", "recording"].includes(recordingStatus.state)) return false;
  recordingStatus = { ...recordingStatus, state: "saving" };
  publishRecordingStatus();
  recorder.send({ type: recordingStatus.frames > 0 ? "save_episode" : "cancel" });
  return true;
}

function recordingIsActive(): boolean {
  return ["preparing", "recording", "saving"].includes(recordingStatus.state);
}

function cleanDatasetName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : null;
}

function datasetPath(name: string): string {
  return path.join(DATASET_ROOT, name);
}

const datasetCatalogCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
const datasetCatalogPending = new Map<string, Promise<Record<string, unknown>>>();

function clearDatasetCatalogCache(dataset?: string): void {
  for (const key of datasetCatalogCache.keys()) {
    if (!dataset || key === "list:" || key.endsWith(`:${dataset}`)) datasetCatalogCache.delete(key);
  }
}

function runDatasetCatalog(command: "list" | "detail" | "quality", dataset?: string, refresh = false): Promise<Record<string, unknown>> {
  const cacheKey = `${command}:${dataset || ""}`;
  const cached = datasetCatalogCache.get(cacheKey);
  if (!refresh && cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  const pending = datasetCatalogPending.get(cacheKey);
  if (!refresh && pending) return pending;
  const args = [DATASET_CATALOG_SCRIPT, command, "--root", DATASET_ROOT];
  if (dataset) args.push("--dataset", dataset);
  const request = new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(PYTHON_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim().split("\n").pop() || error.message));
        return;
      }
      try {
        const value = JSON.parse(stdout) as Record<string, unknown>;
        datasetCatalogCache.set(cacheKey, { expiresAt: Date.now() + (command === "list" ? 10_000 : 30_000), value });
        resolve(value);
      } catch {
        reject(new Error("数据目录返回了无效响应"));
      }
    });
  });
  datasetCatalogPending.set(cacheKey, request);
  void request.then(() => {
    if (datasetCatalogPending.get(cacheKey) === request) datasetCatalogPending.delete(cacheKey);
  }, () => {
    if (datasetCatalogPending.get(cacheKey) === request) datasetCatalogPending.delete(cacheKey);
  });
  return request;
}

interface EpisodeReview {
  status: "unreviewed" | "approved" | "rejected";
  tags: string[];
  notes: string;
  assignee: string;
  reviewer: string;
  qualityFlags: string[];
  createdAt: string;
  updatedAt: string;
}

function readReviews(root: string): { episodes: Record<string, EpisodeReview> } {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, ".lerobot-web", "reviews.json"), "utf-8"));
    return value && typeof value.episodes === "object" ? value : { episodes: {} };
  } catch {
    return { episodes: {} };
  }
}

function writeReviews(root: string, reviews: { episodes: Record<string, EpisodeReview> }): void {
  const directory = path.join(root, ".lerobot-web");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "reviews.json");
  const temporary = path.join(directory, `reviews.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(reviews, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function appendAudit(root: string, entry: Record<string, unknown>): void {
  const directory = path.join(root, ".lerobot-web");
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(path.join(directory, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

interface TrainingCollection {
  schemaVersion: 1;
  id: string;
  name: string;
  dataset: string;
  createdAt: string;
  sourceModifiedAt: string;
  episodes: Array<{ episode: number; tags: string[]; reviewUpdatedAt: string }>;
}

function collectionsDirectory(root: string): string {
  return path.join(root, ".lerobot-web", "collections");
}

function readCollections(root: string): TrainingCollection[] {
  const directory = collectionsDirectory(root);
  try {
    return fs.readdirSync(directory)
      .filter((file) => /^v\d{3}\.json$/.test(file))
      .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf-8")) as TrainingCollection)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function listDatasetFiles(root: string, directory = root): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".lerobot-web") return [];
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? listDatasetFiles(root, absolute) : entry.isFile() ? [path.relative(root, absolute)] : [];
  });
}

function readAudit(root: string): Record<string, unknown>[] {
  try {
    return fs.readFileSync(path.join(root, ".lerobot-web", "audit.jsonl"), "utf-8")
      .split("\n").filter(Boolean).slice(-200).reverse()
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

type TrainingState = "draft" | "running" | "stopping" | "completed" | "failed" | "cancelled";
interface TrainingMetric {
  step: number;
  samples: number | null;
  epochs: number | null;
  loss: number | null;
  gradNorm: number | null;
  learningRate: number | null;
  updateSeconds: number | null;
  dataSeconds: number | null;
}
interface TrainingJob {
  id: string;
  name: string;
  dataset: string;
  collection: string;
  episodes: number[];
  policy: string;
  device: "cuda" | "cpu";
  batchSize: number;
  steps: number;
  logFreq?: number;
  saveFreq?: number;
  numWorkers?: number;
  seed?: number;
  attempts?: number;
  state: TrainingState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outputDir: string;
  command: string[];
  exitCode: number | null;
  error: string | null;
  logs: string[];
  archivedAt?: string | null;
  bestAt?: string | null;
}

type ModelStage = "candidate" | "production" | "archived";
interface RegisteredModel {
  id: string;
  name: string;
  version: number;
  jobId: string;
  checkpoint: string;
  step: number;
  policy: string;
  dataset: string;
  collection: string;
  modelPath: string;
  sizeBytes: number;
  sha256: string;
  stage: ModelStage;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

interface DeploymentRevision {
  id: string;
  targetId: string;
  modelId: string;
  modelName: string;
  modelVersion: number;
  artifactPath: string;
  sha256: string;
  action: "deploy" | "rollback";
  rollbackOf: string | null;
  status: "active" | "superseded";
  deployedAt: string;
  deployedBy: string;
  notes: string;
  releaseGate: ReleaseGateResult | null;
  overrideReason: string;
}
interface DeploymentTarget {
  id: string;
  name: string;
  currentRevisionId: string | null;
  updatedAt: string | null;
  revisions: DeploymentRevision[];
  runtime: DeploymentRuntime;
}
interface InferenceIncident {
  id: string;
  targetId: string;
  revisionId: string | null;
  modelId: string | null;
  severity: "warning" | "error" | "critical";
  category: string;
  description: string;
  status: "open" | "resolved";
  reportedAt: string;
  reportedBy: string;
  resolvedAt: string | null;
  resolution: string;
}
interface DeploymentRuntime {
  status: "offline" | "healthy" | "degraded";
  lastHeartbeat: string | null;
  startedAt: string | null;
  inferenceCount: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  recentLatencies: number[];
  lastError: string;
  processId: string;
  updatedAt: string | null;
}
interface ReleaseGateConfig {
  minEvaluatedEpisodes: number;
  minSuccessRate: number;
  minConfidenceLow: number;
  blockOpenSeverity: "none" | "critical" | "error";
  updatedAt: string | null;
  updatedBy: string;
}
interface ReleaseGateCheck {
  id: "evaluatedEpisodes" | "successRate" | "confidenceLow" | "openIncidents";
  label: string;
  passed: boolean;
  actual: number;
  threshold: number | null;
}
interface ReleaseGateResult {
  ready: boolean;
  checkedAt: string;
  checks: ReleaseGateCheck[];
  config: ReleaseGateConfig;
}
interface DeploymentStore {
  schemaVersion: 2;
  targets: DeploymentTarget[];
  incidents: InferenceIncident[];
  releaseGate: ReleaseGateConfig;
}

type EvaluationState = "draft" | "running" | "stopping" | "completed" | "failed" | "cancelled";
interface EvaluationJob {
  id: string;
  name: string;
  modelId: string;
  modelName: string;
  modelVersion: number;
  evalDataset: string;
  task: string;
  followerPort: string;
  followerId: string;
  leaderPort: string;
  leaderId: string;
  cameraIndices: [number, number];
  device: "cuda" | "cpu";
  numEpisodes: number;
  episodeTime: number;
  resetTime: number;
  state: EvaluationState;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outputDatasetPath: string;
  command: string[];
  exitCode: number | null;
  error: string | null;
  logs: string[];
}

type EvaluationOutcomeStatus = "unreviewed" | "success" | "failure" | "invalid";
interface EvaluationOutcome {
  status: EvaluationOutcomeStatus;
  failureReason: string;
  notes: string;
  reviewer: string;
  createdAt: string;
  updatedAt: string;
}
interface EvaluationResults {
  schemaVersion: 1;
  jobId: string;
  modelId: string;
  episodes: Record<string, EvaluationOutcome>;
}

interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

const trainingProcesses = new Map<string, ChildProcess>();
const evaluationProcesses = new Map<string, ChildProcess>();
const deploymentRuntimeQueues = new Map<string, Promise<void>>();

function enqueueDeploymentRuntime<T>(targetId: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = deploymentRuntimeQueues.get(targetId) || Promise.resolve();
  const result = previous.then(operation, operation);
  deploymentRuntimeQueues.set(targetId, result.then(() => undefined, () => undefined));
  return result;
}

function trainingJobsFile(): string {
  return path.join(TRAINING_ROOT, "jobs.json");
}

function modelRegistryFile(): string {
  return path.join(TRAINING_ROOT, "models.json");
}

function evaluationJobsFile(): string {
  return path.join(TRAINING_ROOT, "evaluations.json");
}

function deploymentsFile(): string {
  return path.join(TRAINING_ROOT, "deployments.json");
}

function defaultReleaseGate(): ReleaseGateConfig {
  return { minEvaluatedEpisodes: 10, minSuccessRate: 0.8, minConfidenceLow: 0.5, blockOpenSeverity: "error", updatedAt: null, updatedBy: "系统默认" };
}

function defaultDeploymentRuntime(): DeploymentRuntime {
  return { status: "offline", lastHeartbeat: null, startedAt: null, inferenceCount: 0, successCount: 0, errorCount: 0, avgLatencyMs: null, p95LatencyMs: null, recentLatencies: [], lastError: "", processId: "", updatedAt: null };
}

function readDeploymentStore(): DeploymentStore {
  try {
    const value = JSON.parse(fs.readFileSync(deploymentsFile(), "utf-8"));
    if (Array.isArray(value.targets) && Array.isArray(value.incidents)) {
      return { schemaVersion: 2, targets: value.targets.map((target: DeploymentTarget) => ({ ...target, runtime: { ...defaultDeploymentRuntime(), ...(target.runtime || {}) } })), incidents: value.incidents, releaseGate: { ...defaultReleaseGate(), ...(value.releaseGate || {}) } };
    }
  } catch { /* initialize below */ }
  return { schemaVersion: 2, targets: [{ id: "local-robot", name: "本机机器人", currentRevisionId: null, updatedAt: null, revisions: [], runtime: defaultDeploymentRuntime() }], incidents: [], releaseGate: defaultReleaseGate() };
}

function writeDeploymentStore(store: DeploymentStore): void {
  fs.mkdirSync(TRAINING_ROOT, { recursive: true });
  const target = deploymentsFile(); const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", "utf-8"); fs.renameSync(temporary, target);
}

function deploymentDirectory(targetId: string): string {
  return path.join(TRAINING_ROOT, "deployments", targetId);
}

function readEvaluationJobs(): EvaluationJob[] {
  try {
    const value = JSON.parse(fs.readFileSync(evaluationJobsFile(), "utf-8"));
    return Array.isArray(value.jobs) ? value.jobs : [];
  } catch {
    return [];
  }
}

function writeEvaluationJobs(jobs: EvaluationJob[]): void {
  fs.mkdirSync(TRAINING_ROOT, { recursive: true });
  const target = evaluationJobsFile();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ jobs }, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function updateEvaluationJob(id: string, update: (job: EvaluationJob) => void): EvaluationJob | null {
  const jobs = readEvaluationJobs();
  const job = jobs.find((item) => item.id === id);
  if (!job) return null;
  update(job); writeEvaluationJobs(jobs); return job;
}

function evaluationResultsFile(job: EvaluationJob): string {
  return path.join(job.outputDatasetPath, ".lerobot-web", "evaluation.json");
}

function readEvaluationResults(job: EvaluationJob): EvaluationResults {
  try {
    const value = JSON.parse(fs.readFileSync(evaluationResultsFile(job), "utf-8"));
    return value && value.jobId === job.id && typeof value.episodes === "object"
      ? value as EvaluationResults
      : { schemaVersion: 1, jobId: job.id, modelId: job.modelId, episodes: {} };
  } catch {
    return { schemaVersion: 1, jobId: job.id, modelId: job.modelId, episodes: {} };
  }
}

function writeEvaluationResults(job: EvaluationJob, results: EvaluationResults): void {
  const directory = path.dirname(evaluationResultsFile(job));
  fs.mkdirSync(directory, { recursive: true });
  const target = evaluationResultsFile(job); const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(results, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function evaluationEpisodeCount(job: EvaluationJob): number {
  try { return Number(JSON.parse(fs.readFileSync(path.join(job.outputDatasetPath, "meta", "info.json"), "utf-8")).total_episodes || 0); }
  catch { return 0; }
}

function wilsonInterval(success: number, failure: number): { confidenceLow: number | null; confidenceHigh: number | null } {
  const evaluated = success + failure;
  if (!evaluated) return { confidenceLow: null, confidenceHigh: null };
  const rate = success / evaluated; const z = 1.96; const denominator = 1 + z * z / evaluated;
  const center = (rate + z * z / (2 * evaluated)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / evaluated + z * z / (4 * evaluated * evaluated)) / denominator;
  return { confidenceLow: Math.max(0, center - margin), confidenceHigh: Math.min(1, center + margin) };
}

function summarizeEvaluation(job: EvaluationJob): Record<string, number | null> {
  const total = evaluationEpisodeCount(job); const results = readEvaluationResults(job);
  let success = 0; let failure = 0; let invalid = 0;
  for (let episode = 0; episode < total; episode += 1) {
    const status = results.episodes[String(episode)]?.status || "unreviewed";
    if (status === "success") success += 1; else if (status === "failure") failure += 1; else if (status === "invalid") invalid += 1;
  }
  const evaluated = success + failure; const successRate = evaluated ? success / evaluated : null;
  const { confidenceLow, confidenceHigh } = wilsonInterval(success, failure);
  return { total, reviewed: success + failure + invalid, success, failure, invalid, pending: total - success - failure - invalid, evaluated, successRate, confidenceLow, confidenceHigh };
}

function aggregateModelEvaluation(modelId: string): { jobs: number; episodes: number; success: number; failure: number; successRate: number | null; confidenceLow: number | null; confidenceHigh: number | null } {
  const summaries = readEvaluationJobs().filter((job) => job.modelId === modelId).map(summarizeEvaluation).filter((summary) => Number(summary.total || 0) > 0);
  const success = summaries.reduce((sum, item) => sum + Number(item.success || 0), 0);
  const failure = summaries.reduce((sum, item) => sum + Number(item.failure || 0), 0);
  const evaluated = success + failure;
  return {
    jobs: summaries.length,
    episodes: summaries.reduce((sum, item) => sum + Number(item.total || 0), 0),
    success,
    failure,
    successRate: evaluated ? success / evaluated : null,
    ...wilsonInterval(success, failure),
  };
}

function evaluateReleaseGate(modelId: string, store: DeploymentStore): ReleaseGateResult {
  const evaluation = aggregateModelEvaluation(modelId); const evaluated = evaluation.success + evaluation.failure; const config = store.releaseGate;
  const severities = config.blockOpenSeverity === "none" ? [] : config.blockOpenSeverity === "critical" ? ["critical"] : ["error", "critical"];
  const openIncidents = store.incidents.filter((incident) => incident.modelId === modelId && incident.status === "open" && severities.includes(incident.severity)).length;
  const checks: ReleaseGateCheck[] = [
    { id: "evaluatedEpisodes", label: "有效评估 Episodes", passed: evaluated >= config.minEvaluatedEpisodes, actual: evaluated, threshold: config.minEvaluatedEpisodes },
    { id: "successRate", label: "评估成功率", passed: evaluation.successRate !== null && evaluation.successRate >= config.minSuccessRate, actual: evaluation.successRate ?? 0, threshold: config.minSuccessRate },
    { id: "confidenceLow", label: "95% 置信区间下界", passed: evaluation.confidenceLow !== null && evaluation.confidenceLow >= config.minConfidenceLow, actual: evaluation.confidenceLow ?? 0, threshold: config.minConfidenceLow },
    { id: "openIncidents", label: "未关闭阻断异常", passed: openIncidents === 0, actual: openIncidents, threshold: 0 },
  ];
  return { ready: checks.every((check) => check.passed), checkedAt: new Date().toISOString(), checks, config: { ...config } };
}

function readRegisteredModels(): RegisteredModel[] {
  try {
    const value = JSON.parse(fs.readFileSync(modelRegistryFile(), "utf-8"));
    return Array.isArray(value.models) ? value.models : [];
  } catch {
    return [];
  }
}

function writeRegisteredModels(models: RegisteredModel[]): void {
  fs.mkdirSync(TRAINING_ROOT, { recursive: true });
  const target = modelRegistryFile();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ models }, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function readTrainingJobs(): TrainingJob[] {
  try {
    const value = JSON.parse(fs.readFileSync(trainingJobsFile(), "utf-8"));
    return Array.isArray(value.jobs) ? value.jobs : [];
  } catch {
    return [];
  }
}

function writeTrainingJobs(jobs: TrainingJob[]): void {
  fs.mkdirSync(TRAINING_ROOT, { recursive: true });
  const target = trainingJobsFile();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ jobs }, null, 2) + "\n", "utf-8");
  fs.renameSync(temporary, target);
}

function updateTrainingJob(id: string, update: (job: TrainingJob) => void): TrainingJob | null {
  const jobs = readTrainingJobs();
  const job = jobs.find((item) => item.id === id);
  if (!job) return null;
  update(job);
  writeTrainingJobs(jobs);
  return job;
}

function parseCompactNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^([\d.]+)([KMB])?$/i);
  if (!match) return null;
  const scale = ({ K: 1e3, M: 1e6, B: 1e9 } as Record<string, number>)[(match[2] || "").toUpperCase()] || 1;
  const parsed = Number(match[1]) * scale;
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMetricValue(line: string, key: string): number | null {
  const match = line.match(new RegExp(`${key}:([+-]?[\\d.]+(?:e[+-]?\\d+)?)`, "i"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function trainingMetrics(job: TrainingJob): TrainingMetric[] {
  const metrics: TrainingMetric[] = [];
  for (const line of job.logs) {
    const stepMatch = line.match(/step:([\d.]+[KMB]?)/i);
    if (!stepMatch) continue;
    const step = parseCompactNumber(stepMatch[1]);
    if (step === null) continue;
    const samplesMatch = line.match(/smpl:([\d.]+[KMB]?)/i);
    metrics.push({
      step,
      samples: parseCompactNumber(samplesMatch?.[1]),
      epochs: parseMetricValue(line, "epch"),
      loss: parseMetricValue(line, "loss"),
      gradNorm: parseMetricValue(line, "grdn"),
      learningRate: parseMetricValue(line, "lr"),
      updateSeconds: parseMetricValue(line, "updt_s"),
      dataSeconds: parseMetricValue(line, "data_s"),
    });
  }
  return metrics;
}

function jobOutputPath(job: TrainingJob): string | null {
  const outputs = path.resolve(TRAINING_ROOT, "outputs");
  const output = path.resolve(job.outputDir);
  return output.startsWith(outputs + path.sep) ? output : null;
}

function directorySize(directory: string): number {
  let size = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) size += directorySize(target);
    else if (entry.isFile()) size += fs.statSync(target).size;
  }
  return size;
}

function trainingCheckpoints(job: TrainingJob): Array<{ step: number; name: string; path: string; configPath: string; modelPath: string | null; sizeBytes: number; modifiedAt: string }> {
  const output = jobOutputPath(job);
  if (!output) return [];
  const directory = path.join(output, "checkpoints");
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => {
        const checkpointPath = path.join(directory, entry.name);
        const configPath = path.join(checkpointPath, "pretrained_model", "train_config.json");
        const modelPath = path.join(checkpointPath, "pretrained_model", "model.safetensors");
        if (!fs.existsSync(configPath)) return null;
        return { step: Number(entry.name), name: entry.name, path: checkpointPath, configPath, modelPath: fs.existsSync(modelPath) ? modelPath : null, sizeBytes: directorySize(checkpointPath), modifiedAt: fs.statSync(checkpointPath).mtime.toISOString() };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => b.step - a.step);
  } catch {
    return [];
  }
}

function runPythonCheck(script: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => execFile(PYTHON_PATH, ["-c", script], { timeout: 15000 }, (error, stdout, stderr) => {
    resolve({ ok: !error, output: (stdout || stderr || error?.message || "").trim() });
  }));
}

function analyzeJpegFrame(frame: Buffer): Promise<{ mean: number; blackRatio: number } | null> {
  const script = "import sys,json,cv2,numpy as np; a=np.frombuffer(sys.stdin.buffer.read(),np.uint8); im=cv2.imdecode(a,cv2.IMREAD_GRAYSCALE); print(json.dumps({'mean':round(float(im.mean()),1),'blackRatio':round(float((im<8).mean()),3)})) if im is not None else sys.exit(2)";
  return new Promise((resolve) => {
    const child = spawn(PYTHON_PATH, ["-c", script], { stdio: ["pipe", "pipe", "ignore"] });
    let output = ""; let settled = false;
    const finish = (value: { mean: number; blackRatio: number } | null) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, 5000); timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf-8"); });
    child.on("exit", (code) => { clearTimeout(timer); if (code !== 0) { finish(null); return; } try { finish(JSON.parse(output)); } catch { finish(null); } });
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.stdin?.end(frame);
  });
}

function estimateTrainingResources(job: TrainingJob): { gpuMemoryGb: number; systemMemoryGb: number; basis: string } {
  const baseGpu: Record<string, number> = { act: 1.8, diffusion: 3.2, tdmpc: 2.4, vqbet: 3, smolvla: 4.5, pi0: 8, "pi0-fast": 6.5, sac: 1.8, reward_classifier: 1.8 };
  const perBatch: Record<string, number> = { act: .12, diffusion: .16, tdmpc: .14, vqbet: .16, smolvla: .2, pi0: .3, "pi0-fast": .25, sac: .1, reward_classifier: .1 };
  const gpuMemoryGb = job.device === "cuda" ? +(baseGpu[job.policy] + perBatch[job.policy] * job.batchSize).toFixed(1) : 0;
  const systemMemoryGb = +(2 + job.batchSize * .06 + (job.numWorkers || 0) * .2).toFixed(1);
  return { gpuMemoryGb, systemMemoryGb, basis: "保守估算：策略基础占用 + batch/workers 增量，实际以启动后监控为准" };
}

async function trainingPreflight(job: TrainingJob): Promise<{ ready: boolean; checks: PreflightCheck[]; checkedAt: string }> {
  const checks: PreflightCheck[] = [];
  const datasetRoot = datasetPath(job.dataset);
  const collectionPath = path.join(collectionsDirectory(datasetRoot), `${job.collection}.json`);
  const datasetReady = fs.existsSync(datasetRoot) && fs.existsSync(collectionPath);
  checks.push({ id: "dataset", label: "训练数据", status: datasetReady ? "pass" : "fail", detail: datasetReady ? `${job.episodes.length} 个已发布 Episode 可用` : "数据集或训练选集已不存在" });
  if (datasetReady) {
    try {
      const quality = await runDatasetCatalog("quality", job.dataset) as { episodes?: Array<{ episode: number; flags?: Array<{ level: string }> }> };
      const selected = (quality.episodes || []).filter((episode) => job.episodes.includes(episode.episode));
      const errors = selected.reduce((sum, episode) => sum + (episode.flags || []).filter((flag) => flag.level === "error").length, 0);
      const warnings = selected.reduce((sum, episode) => sum + (episode.flags || []).filter((flag) => flag.level === "warning").length, 0);
      checks.push({ id: "dataset_quality", label: "数据质量扫描", status: errors ? "fail" : warnings ? "warning" : "pass", detail: errors ? `${errors} 个错误风险，已阻止训练` : warnings ? `${warnings} 个警告风险，请确认后继续` : "黑屏、冻结、轨迹突变和重复风险均未发现" });
    } catch (error) {
      checks.push({ id: "dataset_quality", label: "数据质量扫描", status: "fail", detail: error instanceof Error ? error.message : "质量扫描失败" });
    }
  }

  const python = await runPythonCheck("import lerobot,torch; print(torch.__version__)");
  checks.push({ id: "runtime", label: "LeRobot 运行环境", status: python.ok ? "pass" : "fail", detail: python.ok ? `PyTorch ${python.output}` : python.output || "无法导入 lerobot/torch" });

  const cuda = await runPythonCheck("import torch; print(torch.cuda.is_available())");
  const cudaAvailable = cuda.ok && cuda.output.split(/\s+/).pop() === "True";
  checks.push({ id: "device", label: "计算设备", status: job.device === "cpu" || cudaAvailable ? "pass" : "fail", detail: job.device === "cpu" ? "使用 CPU（适合流程验证）" : cudaAvailable ? "CUDA 可用" : "任务要求 CUDA，但当前 PyTorch 无 CUDA" });

  if (["pi0", "pi0-fast"].includes(job.policy)) {
    const dependency = await runPythonCheck("import transformers,peft; print('lerobot[pi] ready')");
    checks.push({ id: "policy_dependency", label: "Pi0 依赖", status: dependency.ok ? "pass" : "fail", detail: dependency.ok ? dependency.output : "缺少 Pi0 依赖，请安装 lerobot[pi]" });
  } else if (job.policy === "smolvla") {
    const dependency = await runPythonCheck("import transformers; print('SmolVLA ready')");
    checks.push({ id: "policy_dependency", label: "SmolVLA 依赖", status: dependency.ok ? "pass" : "fail", detail: dependency.ok ? dependency.output : "缺少 SmolVLA 依赖，请安装 lerobot[smolvla]" });
  }

  const resources = resourceSample() as { diskFreeGb: number };
  const memoryFreeGb = os.freemem() / 1024 ** 3;
  const estimate = estimateTrainingResources(job);
  checks.push({ id: "disk", label: "磁盘空间", status: resources.diskFreeGb >= 5 ? "pass" : resources.diskFreeGb >= 2 ? "warning" : "fail", detail: `可用 ${resources.diskFreeGb} GB，建议至少保留 5 GB` });
  checks.push({ id: "memory", label: "可用内存", status: memoryFreeGb >= estimate.systemMemoryGb ? "pass" : memoryFreeGb >= estimate.systemMemoryGb * .75 ? "warning" : "fail", detail: `可用 ${memoryFreeGb.toFixed(1)} GB · 预计需要 ${estimate.systemMemoryGb} GB` });
  const profile = await hostProfile(); const gpu = profile.gpu as { available?: boolean; memoryGb?: number | null };
  const gpuCapacity = Number(gpu.memoryGb || 0);
  const gpuStatus = job.device === "cpu" ? "pass" : !gpu.available ? "fail" : estimate.gpuMemoryGb > gpuCapacity ? "fail" : estimate.gpuMemoryGb > gpuCapacity * .85 ? "warning" : "pass";
  checks.push({ id: "resource_estimate", label: "训练资源估算", status: gpuStatus, detail: job.device === "cpu" ? `${estimate.systemMemoryGb} GB 系统内存需求 · ${estimate.basis}` : `预计显存 ${estimate.gpuMemoryGb} GB / 实机 ${gpuCapacity || "未检测到"} GB · ${estimate.basis}` });
  checks.push({ id: "exclusive", label: "设备占用", status: evaluationProcesses.size === 0 ? "pass" : "fail", detail: evaluationProcesses.size === 0 ? "没有评估任务占用设备" : "评估任务正在运行" });
  return { ready: !checks.some((check) => check.status === "fail"), checks, checkedAt: new Date().toISOString() };
}

function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyDeploymentArtifact(model: RegisteredModel): Promise<{ modelFile: string; artifactPath: string }> {
  const outputsRoot = path.resolve(TRAINING_ROOT, "outputs");
  const modelFile = fs.realpathSync(model.modelPath);
  if (!modelFile.startsWith(outputsRoot + path.sep) || path.basename(modelFile) !== "model.safetensors") throw new Error("模型产物不在受管理的训练输出目录中");
  const artifactPath = path.dirname(modelFile);
  if (!fs.existsSync(path.join(artifactPath, "config.json"))) throw new Error("模型目录缺少 config.json");
  const hash = await fileSha256(modelFile);
  if (hash !== model.sha256) throw new Error("模型 SHA-256 与登记记录不一致，已阻止部署");
  return { modelFile, artifactPath };
}

function switchDeploymentLink(targetId: string, artifactPath: string): string {
  const directory = deploymentDirectory(targetId); fs.mkdirSync(directory, { recursive: true });
  const current = path.join(directory, "current"); const temporary = path.join(directory, `.current.${process.pid}.${Date.now()}`);
  fs.symlinkSync(artifactPath, temporary, "dir");
  try { fs.renameSync(temporary, current); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } throw error; }
  return current;
}

async function activateDeployment(targetId: string, model: RegisteredModel, input: { actor: string; notes: string; action: "deploy" | "rollback"; rollbackOf?: string | null; releaseGate?: ReleaseGateResult | null; overrideReason?: string }): Promise<DeploymentRevision> {
  if (targetId !== "local-robot") throw new Error("未知部署目标");
  const { artifactPath } = await verifyDeploymentArtifact(model);
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === targetId);
  if (!target) throw new Error("找不到部署目标");
  const now = new Date().toISOString();
  for (const revision of target.revisions) if (revision.status === "active") revision.status = "superseded";
  const revision: DeploymentRevision = {
    id: `deploy-${Date.now().toString(36)}`, targetId, modelId: model.id, modelName: model.name, modelVersion: model.version,
    artifactPath, sha256: model.sha256, action: input.action, rollbackOf: input.rollbackOf || null, status: "active",
    deployedAt: now, deployedBy: input.actor || "本地用户", notes: input.notes,
    releaseGate: input.releaseGate || null, overrideReason: input.overrideReason || "",
  };
  switchDeploymentLink(targetId, artifactPath);
  target.revisions.unshift(revision); target.currentRevisionId = revision.id; target.updatedAt = now; writeDeploymentStore(store);

  const models = readRegisteredModels();
  for (const item of models) if (item.name === model.name && item.stage === "production") { item.stage = "candidate"; item.updatedAt = now; }
  const deployed = models.find((item) => item.id === model.id); if (deployed) { deployed.stage = "production"; deployed.updatedAt = now; }
  writeRegisteredModels(models);
  return revision;
}

function deploymentRuntimeView(runtime: DeploymentRuntime): DeploymentRuntime {
  const stale = !runtime.lastHeartbeat || Date.now() - Date.parse(runtime.lastHeartbeat) > 30_000;
  return { ...runtime, status: stale ? "offline" : runtime.status, recentLatencies: runtime.recentLatencies.slice(-100) };
}

function enrichDeploymentTarget(target: DeploymentTarget, incidents: InferenceIncident[]): DeploymentTarget & { current: DeploymentRevision | null; linkPath: string; healthy: boolean; openIncidents: number } {
  const current = target.revisions.find((item) => item.id === target.currentRevisionId) || null; const linkPath = path.join(deploymentDirectory(target.id), "current");
  let healthy = false;
  if (current) { try { healthy = fs.realpathSync(linkPath) === fs.realpathSync(current.artifactPath); } catch { healthy = false; } }
  return { ...target, runtime: deploymentRuntimeView(target.runtime), current, linkPath, healthy, openIncidents: incidents.filter((item) => item.targetId === target.id && item.status === "open").length };
}

function enrichTrainingJob(job: TrainingJob): TrainingJob & { metrics: TrainingMetric[]; progress: number; checkpoints: ReturnType<typeof trainingCheckpoints> } {
  const metrics = trainingMetrics(job);
  const checkpoints = trainingCheckpoints(job);
  const latestStep = metrics[metrics.length - 1]?.step || checkpoints[0]?.step || 0;
  return { ...job, metrics, progress: Math.min(100, Math.round(latestStep / Math.max(1, job.steps) * 1000) / 10), checkpoints };
}

function readNumberFile(file: string): number | null {
  try { const value = Number(fs.readFileSync(file, "utf-8").trim()); return Number.isFinite(value) ? value : null; }
  catch { return null; }
}

function resourceSample(): Record<string, unknown> {
  const disk = fs.statfsSync(DATASET_ROOT);
  const gpuLoadRaw = readNumberFile("/sys/devices/platform/bus@0/17000000.gpu/load") ?? readNumberFile("/sys/devices/gpu.0/load");
  const thermalRoot = "/sys/class/thermal";
  let temperatureC: number | null = null;
  try {
    for (const entry of fs.readdirSync(thermalRoot).filter((name) => name.startsWith("thermal_zone"))) {
      const type = fs.readFileSync(path.join(thermalRoot, entry, "type"), "utf-8").trim().toLowerCase();
      if (type.includes("gpu") || type.includes("cpu")) {
        const raw = readNumberFile(path.join(thermalRoot, entry, "temp"));
        if (raw !== null) temperatureC = Math.max(temperatureC || 0, raw > 1000 ? raw / 1000 : raw);
      }
    }
  } catch { /* thermal data unavailable */ }
  return {
    sampledAt: new Date().toISOString(),
    cpuLoadPercent: Math.min(100, Math.round(os.loadavg()[0] / Math.max(1, os.cpus().length) * 1000) / 10),
    memoryUsedGb: +((os.totalmem() - os.freemem()) / 1024 ** 3).toFixed(1),
    memoryPercent: Math.round((os.totalmem() - os.freemem()) / os.totalmem() * 1000) / 10,
    diskFreeGb: +(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1),
    gpuLoadPercent: gpuLoadRaw === null ? null : Math.round((gpuLoadRaw > 100 ? gpuLoadRaw / 10 : gpuLoadRaw) * 10) / 10,
    temperatureC,
  };
}

function startTrainingJob(job: TrainingJob): void {
  if (trainingProcesses.size > 0 || evaluationProcesses.size > 0) throw new Error("已有训练或评估任务正在运行");
  fs.mkdirSync(path.dirname(job.outputDir), { recursive: true });
  job.state = "running";
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.error = null;
  job.attempts = (job.attempts || 0) + 1;
  writeTrainingJobs(readTrainingJobs().map((item) => item.id === job.id ? job : item));
  const child = spawn(PYTHON_PATH, job.command, { cwd: path.join(__dirname, "../.."), env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  trainingProcesses.set(job.id, child);
  let logBuffer = "";
  const consume = (chunk: Buffer) => {
    logBuffer += chunk.toString("utf-8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
    const lines = logBuffer.split(/\r?\n/);
    logBuffer = lines.pop() || "";
    if (!lines.length) return;
    updateTrainingJob(job.id, (current) => { current.logs.push(...lines.map((line) => line.trimEnd()).filter((line) => line && !line.includes("%|") && !line.includes("it/s]"))); current.logs = current.logs.slice(-500); });
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);
  child.on("error", (error) => {
    trainingProcesses.delete(job.id);
    updateTrainingJob(job.id, (current) => { current.state = "failed"; current.error = error.message; current.finishedAt = new Date().toISOString(); });
  });
  child.on("exit", (code, signal) => {
    trainingProcesses.delete(job.id);
    updateTrainingJob(job.id, (current) => {
      if (logBuffer.trim()) current.logs.push(logBuffer.trim());
      current.exitCode = code;
      current.finishedAt = new Date().toISOString();
      const wasStopping = current.state === "stopping";
      current.state = code === 0 ? "completed" : wasStopping ? "cancelled" : "failed";
      if (code !== 0 && !wasStopping && !current.error) current.error = signal ? `训练进程被 ${signal} 终止` : `训练进程退出码 ${code}`;
    });
  });
}

function buildEvaluationCommand(job: EvaluationJob, model: RegisteredModel): string[] {
  const cameras = {
    wrist: { type: "opencv", index_or_path: job.cameraIndices[0], width: CAMERA_WIDTH, height: CAMERA_HEIGHT, fps: CAMERA_FPS },
    front: { type: "opencv", index_or_path: job.cameraIndices[1], width: CAMERA_WIDTH, height: CAMERA_HEIGHT, fps: CAMERA_FPS },
  };
  const command = [
    "-m", "lerobot.scripts.lerobot_record",
    "--robot.type=so101_follower", `--robot.port=${job.followerPort}`, `--robot.id=${job.followerId}`,
    "--robot.disable_torque_on_disconnect=true", `--robot.cameras=${JSON.stringify(cameras)}`,
    "--teleop.type=so101_leader", `--teleop.port=${job.leaderPort}`, `--teleop.id=${job.leaderId}`,
    "--display_data=false", `--dataset.single_task=${job.task}`,
    `--policy.path=${path.dirname(model.modelPath)}`, `--policy.device=${job.device}`,
    `--dataset.repo_id=local/${job.evalDataset}`, `--dataset.root=${job.outputDatasetPath}`,
    "--dataset.push_to_hub=false", `--dataset.num_episodes=${job.numEpisodes}`,
    `--dataset.episode_time_s=${job.episodeTime}`, `--dataset.reset_time_s=${job.resetTime}`,
  ];
  if (job.attempts > 0) command.push("--resume=true");
  return command;
}

async function evaluationPreflight(job: EvaluationJob): Promise<{ ready: boolean; checks: PreflightCheck[]; checkedAt: string }> {
  const checks: PreflightCheck[] = [];
  const model = readRegisteredModels().find((item) => item.id === job.modelId);
  const modelReady = Boolean(model && fs.existsSync(model.modelPath) && fs.existsSync(path.join(path.dirname(model.modelPath), "config.json")));
  checks.push({ id: "model", label: "模型产物", status: modelReady ? "pass" : "fail", detail: modelReady ? `${model!.name} v${model!.version} · ${model!.stage}` : "模型文件或 config.json 不存在" });

  const trainingDatasetConflict = model?.dataset === job.evalDataset;
  const datasetExists = fs.existsSync(path.join(job.outputDatasetPath, "meta", "info.json"));
  const datasetAllowed = !trainingDatasetConflict && (!datasetExists || job.attempts > 0);
  checks.push({ id: "dataset", label: "评估数据集", status: datasetAllowed ? "pass" : "fail", detail: trainingDatasetConflict ? "评估 Dataset 不能与训练 Dataset 同名" : datasetExists && job.attempts === 0 ? "Dataset 已存在，请使用新名称" : `${job.evalDataset} 与训练数据隔离` });

  const portsReady = job.followerPort !== job.leaderPort && fs.existsSync(job.followerPort) && fs.existsSync(job.leaderPort);
  checks.push({ id: "serial", label: "机械臂串口", status: portsReady ? "pass" : "fail", detail: portsReady ? `${job.followerPort} / ${job.leaderPort}` : "Follower、Leader 串口必须存在且不能相同" });

  const now = Date.now();
  const cameraStreamsReady = job.cameraIndices[0] !== job.cameraIndices[1]
    && job.cameraIndices[0] === activeCameraIndex && job.cameraIndices[1] === activeCameraIndex2
    && now - cameraLastFrameAt < 2000 && now - camera2LastFrameAt < 2000;
  let cameraDetail = "两路摄像头必须映射正确并持续产生实时帧";
  let camerasReady = cameraStreamsReady;
  if (cameraStreamsReady && latestCameraFrame && latestCamera2Frame) {
    const [first, second] = await Promise.all([analyzeJpegFrame(latestCameraFrame), analyzeJpegFrame(latestCamera2Frame)]);
    camerasReady = Boolean(first && second && first.mean >= 5 && second.mean >= 5 && first.blackRatio < .98 && second.blackRatio < .98);
    cameraDetail = first && second
      ? `/dev/video${job.cameraIndices[0]} 亮度 ${first.mean} / /dev/video${job.cameraIndices[1]} 亮度 ${second.mean}${camerasReady ? ` · MJPG ${CAMERA_WIDTH}x${CAMERA_HEIGHT}@${CAMERA_FPS}` : " · 检测到黑屏"}`
      : "无法解析摄像头画面";
  }
  checks.push({ id: "cameras", label: "双摄像头画面", status: camerasReady ? "pass" : "fail", detail: cameraDetail });

  const runtime = await runPythonCheck("import lerobot,torch; print(torch.__version__)");
  checks.push({ id: "runtime", label: "推理环境", status: runtime.ok ? "pass" : "fail", detail: runtime.ok ? `PyTorch ${runtime.output}` : runtime.output || "无法导入 lerobot/torch" });
  if (job.device === "cuda") {
    const cuda = await runPythonCheck("import torch; print(torch.cuda.is_available())");
    const available = cuda.ok && cuda.output.split(/\s+/).pop() === "True";
    checks.push({ id: "device", label: "推理设备", status: available ? "pass" : "fail", detail: available ? "CUDA 可用" : "任务要求 CUDA，但当前 PyTorch 无 CUDA" });
  } else {
    checks.push({ id: "device", label: "推理设备", status: "warning", detail: "使用 CPU 推理，动作频率可能不足" });
  }

  const idle = evaluationProcesses.size === 0 && trainingProcesses.size === 0 && !bridge?.isRunning() && !recordingIsActive();
  checks.push({ id: "exclusive", label: "设备独占", status: idle ? "pass" : "fail", detail: idle ? "遥操作、录制和训练均已停止" : "请先停止遥操作、录制、训练或其他评估任务" });
  const resources = resourceSample() as { diskFreeGb: number };
  checks.push({ id: "disk", label: "磁盘空间", status: resources.diskFreeGb >= 2 ? "pass" : "fail", detail: `可用 ${resources.diskFreeGb} GB` });
  return { ready: !checks.some((check) => check.status === "fail"), checks, checkedAt: new Date().toISOString() };
}

function restoreCameraStreams(indices: [number, number]): void {
  setTimeout(() => {
    if (evaluationProcesses.size > 0 || !ENABLE_CAMERA) return;
    startCamera(indices[0]); startCamera2(indices[1]);
  }, 1000).unref();
}

async function startEvaluationJob(job: EvaluationJob): Promise<void> {
  if (evaluationProcesses.size > 0 || trainingProcesses.size > 0) throw new Error("已有训练或评估任务正在运行");
  const model = readRegisteredModels().find((item) => item.id === job.modelId);
  if (!model) throw new Error("已登记模型不存在");
  job.command = buildEvaluationCommand(job, model);
  job.state = "running"; job.startedAt = new Date().toISOString(); job.finishedAt = null; job.error = null; job.attempts += 1;
  writeEvaluationJobs(readEvaluationJobs().map((item) => item.id === job.id ? job : item));

  cameraBridge?.stop(); cameraBridge2?.stop();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const child = spawn(PYTHON_PATH, job.command, { cwd: path.join(__dirname, "../.."), env: { ...process.env, PYTHONUNBUFFERED: "1" } });
  evaluationProcesses.set(job.id, child);
  let logBuffer = "";
  const consume = (chunk: Buffer) => {
    logBuffer += chunk.toString("utf-8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
    const lines = logBuffer.split(/\r?\n/); logBuffer = lines.pop() || "";
    if (lines.length) updateEvaluationJob(job.id, (current) => { current.logs.push(...lines.map((line) => line.trimEnd()).filter(Boolean)); current.logs = current.logs.slice(-500); });
  };
  child.stdout?.on("data", consume); child.stderr?.on("data", consume);
  child.on("error", (error) => {
    evaluationProcesses.delete(job.id); restoreCameraStreams(job.cameraIndices);
    updateEvaluationJob(job.id, (current) => { current.state = "failed"; current.error = error.message; current.finishedAt = new Date().toISOString(); });
  });
  child.on("exit", (code, signal) => {
    evaluationProcesses.delete(job.id); restoreCameraStreams(job.cameraIndices);
    updateEvaluationJob(job.id, (current) => {
      if (logBuffer.trim()) current.logs.push(logBuffer.trim());
      current.exitCode = code; current.finishedAt = new Date().toISOString();
      const wasStopping = current.state === "stopping";
      current.state = code === 0 ? "completed" : wasStopping ? "cancelled" : "failed";
      if (code !== 0 && !wasStopping && !current.error) current.error = signal ? `评估进程被 ${signal} 终止` : `评估进程退出码 ${code}`;
    });
  });
}

function hostProfile(): Promise<Record<string, unknown>> {
  const disk = fs.statfsSync(DATASET_ROOT);
  const base = {
    cpu: { model: os.cpus()[0]?.model || "Unknown", cores: os.cpus().length, load: os.loadavg()[0] },
    memory: { totalGb: +(os.totalmem() / 1024 ** 3).toFixed(1), freeGb: +(os.freemem() / 1024 ** 3).toFixed(1) },
    disk: { totalGb: +(disk.blocks * disk.bsize / 1024 ** 3).toFixed(1), freeGb: +(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1) },
    platform: `${os.platform()} ${os.arch()}`,
  };
  const script = "import json,torch; c=torch.cuda.is_available(); p=torch.cuda.get_device_properties(0) if c else None; print(json.dumps({'available':c,'name':torch.cuda.get_device_name(0) if c else None,'memoryGb':round(p.total_memory/1024**3,1) if p else None,'torch':torch.__version__}))";
  return new Promise((resolve) => execFile(PYTHON_PATH, ["-c", script], { timeout: 15000 }, (error, stdout) => {
    let gpu: Record<string, unknown> = { available: false, name: null, memoryGb: null };
    if (!error) { try { gpu = JSON.parse(stdout); } catch { /* keep fallback */ } }
    if (!gpu.name) {
      try {
        const name = execSync("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null", { encoding: "utf-8" }).trim().split("\n")[0];
        if (name) gpu = { ...gpu, name, hardwareDetected: true, unifiedMemory: name.toLowerCase().includes("nvgpu") };
      } catch { /* no NVIDIA hardware */ }
    } else {
      gpu.hardwareDetected = true;
    }
    const gpuMemory = Number(gpu.memoryGb || 0);
    const recommendation = gpu.available
      ? { device: "cuda", cameraResolution: gpuMemory >= 12 ? "1280x720" : "640x360", actBatchSize: gpuMemory >= 12 ? 64 : gpuMemory >= 8 ? 28 : 8 }
      : { device: "cpu", cameraResolution: "640x360", actBatchSize: 4 };
    resolve({ ...base, gpu, recommendation, checkedAt: new Date().toISOString() });
  }));
}

function cleanShortText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  const result: string[] = [];
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim();
    if (cleaned && cleaned.length <= maxLength && !result.includes(cleaned)) result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

function ensureEpisodeExists(root: string, episode: number): void {
  const info = JSON.parse(fs.readFileSync(path.join(root, "meta", "info.json"), "utf-8"));
  if (episode >= Number(info.total_episodes || 0)) throw new Error(`找不到 Episode ${episode}`);
}

function buildReview(body: Record<string, unknown>, previous?: EpisodeReview): EpisodeReview {
  const status = body.status;
  if (!["unreviewed", "approved", "rejected"].includes(String(status))) throw new Error("审核状态无效");
  const now = new Date().toISOString();
  return {
    status: status as EpisodeReview["status"],
    notes: cleanShortText(body.notes, 2000),
    tags: cleanStringList(body.tags, 20, 40),
    assignee: cleanShortText(body.assignee, 80),
    reviewer: cleanShortText(body.reviewer, 80),
    qualityFlags: cleanStringList(body.qualityFlags, 20, 60),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
}

function recordCaptureSample(message: BridgeMessage): void {
  if (recordingStatus.state !== "recording" || !recorder?.isRunning() || recorderFramePending) return;
  const now = Date.now();
  if (now < nextRecorderFrameAt || !latestCameraFrame || !latestCamera2Frame) return;
  if (
    !message.leader
    || !message.follower
    || Number(message.sensor_skew_ms || 0) > RECORDING_MAX_CAMERA_SKEW_MS
    || now - cameraLastFrameAt > RECORDING_MAX_SENSOR_AGE_MS
    || now - camera2LastFrameAt > RECORDING_MAX_SENSOR_AGE_MS
    || Math.abs(cameraLastFrameAt - camera2LastFrameAt) > RECORDING_MAX_CAMERA_SKEW_MS
  ) return;

  recorderFramePending = true;
  nextRecorderFrameAt = now + 1000 / recordingStatus.fps;
  recorder.send({
    type: "record_frame",
    leader: message.leader,
    follower: message.follower,
    camera: latestCameraFrame.toString("base64"),
    camera2: latestCamera2Frame.toString("base64"),
  });
}

app.get("/api/recording/status", (req, res) => {
  res.json({ ok: true, ...recordingStatus, root: DATASET_ROOT });
});

app.post("/api/logs/latency", (req, res) => {
  const fields = ["controlLatencyMs", "cameraLatencyMs", "camera2LatencyMs", "controlFps", "cameraFps", "camera2Fps"] as const;
  const metrics: Record<string, number | null> = {};
  for (const field of fields) {
    const value = req.body?.[field];
    if (value === null || value === undefined) {
      metrics[field] = null;
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 600000) {
      metrics[field] = Math.round(value * 10) / 10;
    } else {
      res.status(400).json({ ok: false, error: `${field} 必须是有效的非负数或 null` });
      return;
    }
  }
  persistControlLatency(metrics);
  res.status(202).json({ ok: true });
});

app.get("/api/logs", (_req, res) => {
  try {
    fs.mkdirSync(RUNTIME_LOG_ROOT, { recursive: true });
    const files = fs.readdirSync(RUNTIME_LOG_ROOT)
      .filter((name) => /^\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2}_\d+)?\.jsonl$/.test(name))
      .map((name) => {
        const file = path.join(RUNTIME_LOG_ROOT, name);
        const content = fs.readFileSync(file, "utf-8");
        const id = name.slice(0, -".jsonl".length);
        const firstEntry = content.split("\n").find(Boolean);
        let startedAt = fs.statSync(file).birthtime.toISOString();
        try {
          const parsed = firstEntry ? JSON.parse(firstEntry) : null;
          if (typeof parsed?.timestamp === "string") startedAt = parsed.timestamp;
        } catch { /* retain filesystem timestamp for legacy files */ }
        return {
          id,
          date: name.slice(0, 10),
          startedAt,
          current: id === RUNTIME_LOG_SESSION_ID,
          legacy: /^\d{4}-\d{2}-\d{2}$/.test(id),
          lines: content.split("\n").filter(Boolean).length,
          bytes: fs.statSync(file).size,
        };
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    res.json({ ok: true, root: RUNTIME_LOG_ROOT, currentSession: RUNTIME_LOG_SESSION_ID, files });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/logs/:session", (req, res) => {
  const session = String(req.params.session || "");
  if (!/^\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2}_\d+)?$/.test(session)) {
    res.status(400).json({ ok: false, error: "日志会话无效" });
    return;
  }
  const file = path.join(RUNTIME_LOG_ROOT, `${session}.jsonl`);
  if (!fs.existsSync(file)) {
    res.status(404).json({ ok: false, error: "该日期没有日志" });
    return;
  }
  try {
    const entries = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).reverse();
    res.json({ ok: true, session, entries });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/datasets", async (req, res) => {
  try {
    res.json({ ok: true, ...await runDatasetCatalog("list", undefined, req.query.refresh === "1") });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/datasets/:dataset", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const confirmation = cleanShortText(req.body?.confirmation, 120);
  if (!dataset || confirmation !== dataset) {
    res.status(400).json({ ok: false, error: "请输入完整数据集名称确认删除" });
    return;
  }
  if (recordingStatus.dataset === dataset && recordingStatus.state !== "idle" && recordingStatus.state !== "error") {
    res.status(409).json({ ok: false, error: "该数据集正在录制，请先停止录制" });
    return;
  }
  try {
    const source = fs.realpathSync(datasetPath(dataset));
    if (path.dirname(source) !== fs.realpathSync(DATASET_ROOT)) throw new Error("数据集路径无效");
    fs.mkdirSync(DATASET_TRASH_ROOT, { recursive: true });
    const suffix = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(DATASET_TRASH_ROOT, `${dataset}-${suffix}`);
    fs.renameSync(source, destination);
    clearDatasetCatalogCache(dataset);
    persistRuntimeLog("system", "warn", `数据集 ${dataset} 已移入回收目录: ${destination}`);
    res.json({ ok: true, dataset, recoverable: true, trashPath: destination });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes("ENOENT") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.get("/api/datasets/:dataset", async (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) {
    res.status(400).json({ ok: false, error: "无效的数据集名称" });
    return;
  }
  try {
    const detail = await runDatasetCatalog("detail", dataset, req.query.refresh === "1");
    const episodes = Array.isArray(detail.episodes) ? detail.episodes.map((episode) => {
      const item = episode as Record<string, unknown>;
      const videos = item.videos && typeof item.videos === "object" ? Object.fromEntries(
        Object.entries(item.videos as Record<string, string>).map(([key, relative]) => [
          key,
          `/api/datasets/${encodeURIComponent(dataset)}/video?file=${Buffer.from(relative).toString("base64url")}`,
        ]),
      ) : {};
      return { ...item, videos };
    }) : [];
    res.json({ ok: true, ...detail, episodes });
  } catch (error) {
    res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/datasets/:dataset/quality", async (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) { res.status(400).json({ ok: false, error: "无效的数据集名称" }); return; }
  try { res.json({ ok: true, ...(await runDatasetCatalog("quality", dataset)) }); }
  catch (error) { res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/datasets/:dataset/video", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const token = typeof req.query.file === "string" ? req.query.file : "";
  if (!dataset || !token) {
    res.status(400).json({ ok: false, error: "视频参数无效" });
    return;
  }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    const relative = Buffer.from(token, "base64url").toString("utf-8");
    const requested = fs.realpathSync(path.resolve(root, relative));
    if (!requested.startsWith(root + path.sep) || path.extname(requested).toLowerCase() !== ".mp4") {
      throw new Error("视频路径无效");
    }
    res.sendFile(requested);
  } catch (error) {
    res.status(404).json({ ok: false, error: error instanceof Error ? error.message : "找不到视频" });
  }
});

app.patch("/api/datasets/:dataset/episodes/:episode/review", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const episode = Number(req.params.episode);
  if (!dataset || !Number.isInteger(episode) || episode < 0) {
    res.status(400).json({ ok: false, error: "数据集或 episode 无效" });
    return;
  }
  const root = datasetPath(dataset);
  try {
    ensureEpisodeExists(root, episode);
    const reviews = readReviews(root);
    const review = buildReview(req.body, reviews.episodes[String(episode)]);
    reviews.episodes[String(episode)] = review;
    writeReviews(root, reviews);
    clearDatasetCatalogCache(dataset);
    appendAudit(root, { action: "review.update", actor: review.reviewer || "本地用户", dataset, episodes: [episode], status: review.status, tags: review.tags });
    res.json({ ok: true, review });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("找不到") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.patch("/api/datasets/:dataset/reviews/batch", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const episodeIds = Array.isArray(req.body.episodes)
    ? [...new Set((req.body.episodes as unknown[]).filter((value): value is number => Number.isInteger(value) && Number(value) >= 0).map(Number))]
    : [];
  if (!dataset || episodeIds.length === 0 || episodeIds.length > 500) {
    res.status(400).json({ ok: false, error: "请选择 1-500 个有效 Episode" });
    return;
  }
  const root = datasetPath(dataset);
  try {
    episodeIds.forEach((episode) => ensureEpisodeExists(root, episode));
    const reviews = readReviews(root);
    const saved: Record<string, EpisodeReview> = {};
    for (const episode of episodeIds) {
      const previous = reviews.episodes[String(episode)];
      const merged = {
        status: req.body.status,
        notes: req.body.keepExisting ? previous?.notes || "" : req.body.notes,
        tags: req.body.appendTags ? [...(previous?.tags || []), ...cleanStringList(req.body.tags, 20, 40)] : req.body.tags,
        assignee: req.body.assignee ?? previous?.assignee,
        reviewer: req.body.reviewer,
        qualityFlags: previous?.qualityFlags || [],
      };
      saved[String(episode)] = buildReview(merged, previous);
      reviews.episodes[String(episode)] = saved[String(episode)];
    }
    writeReviews(root, reviews);
    clearDatasetCatalogCache(dataset);
    appendAudit(root, { action: "review.batch", actor: cleanShortText(req.body.reviewer, 80) || "本地用户", dataset, episodes: episodeIds, status: req.body.status, tags: cleanStringList(req.body.tags, 20, 40) });
    res.json({ ok: true, count: episodeIds.length, reviews: saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("找不到") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.get("/api/datasets/:dataset/collections", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) { res.status(400).json({ ok: false, error: "无效的数据集名称" }); return; }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    res.json({ ok: true, collections: readCollections(root) });
  } catch {
    res.status(404).json({ ok: false, error: `找不到数据集: ${dataset}` });
  }
});

app.delete("/api/datasets/:dataset/collections/:collection", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const collection = cleanShortText(req.params.collection, 80);
  if (!dataset || !/^[A-Za-z0-9_-]+$/.test(collection)) {
    res.status(400).json({ ok: false, error: "数据集或训练选集无效" });
    return;
  }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    const directory = collectionsDirectory(root);
    const file = fs.realpathSync(path.join(directory, `${collection}.json`));
    if (path.dirname(file) !== fs.realpathSync(directory)) throw new Error("训练选集路径无效");
    fs.unlinkSync(file);
    appendAudit(root, { action: "collection.delete", actor: cleanShortText(req.body?.actor, 80) || "本地用户", dataset, collection });
    res.json({ ok: true, deleted: collection });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.includes("ENOENT") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.post("/api/datasets/:dataset/collections", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const name = cleanShortText(req.body.name, 80);
  const requested = Array.isArray(req.body.episodes)
    ? [...new Set((req.body.episodes as unknown[]).filter((value): value is number => Number.isInteger(value) && Number(value) >= 0).map(Number))]
    : [];
  if (!dataset || !name) { res.status(400).json({ ok: false, error: "数据集与训练选集名称不能为空" }); return; }
  const root = datasetPath(dataset);
  try {
    const reviews = readReviews(root);
    const approved = Object.entries(reviews.episodes)
      .filter(([, review]) => review.status === "approved")
      .map(([episode]) => Number(episode));
    const episodeIds = (requested.length ? requested : approved).sort((a, b) => a - b);
    if (!episodeIds.length) throw new Error("没有已通过审核的 Episode");
    const notApproved = episodeIds.filter((episode) => reviews.episodes[String(episode)]?.status !== "approved");
    if (notApproved.length) throw new Error(`包含未通过审核的 Episode: ${notApproved.join(", ")}`);
    episodeIds.forEach((episode) => ensureEpisodeExists(root, episode));
    const existing = readCollections(root);
    const id = `v${String(existing.length + 1).padStart(3, "0")}`;
    const collection: TrainingCollection = {
      schemaVersion: 1,
      id,
      name,
      dataset,
      createdAt: new Date().toISOString(),
      sourceModifiedAt: fs.statSync(path.join(root, "meta", "info.json")).mtime.toISOString(),
      episodes: episodeIds.map((episode) => {
        const review = reviews.episodes[String(episode)];
        return { episode, tags: review.tags || [], reviewUpdatedAt: review.updatedAt || "" };
      }),
    };
    const directory = collectionsDirectory(root);
    fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(collection, null, 2) + "\n", "utf-8");
    fs.renameSync(temporary, target);
    clearDatasetCatalogCache(dataset);
    appendAudit(root, { action: "collection.publish", actor: cleanShortText(req.body.actor, 80) || "本地用户", dataset, collection: id, episodes: episodeIds });
    res.status(201).json({ ok: true, collection, path: path.relative(root, target) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message.startsWith("没有") || message.startsWith("包含") ? 409 : 400).json({ ok: false, error: message });
  }
});

app.get("/api/datasets/:dataset/collections/:collection/manifest", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const collection = /^v\d{3}$/.test(req.params.collection) ? req.params.collection : null;
  if (!dataset || !collection) { res.status(400).json({ ok: false, error: "训练选集参数无效" }); return; }
  try {
    const file = fs.realpathSync(path.join(collectionsDirectory(fs.realpathSync(datasetPath(dataset))), `${collection}.json`));
    res.setHeader("Content-Disposition", `attachment; filename="${dataset}-${collection}.json"`);
    res.sendFile(file, { dotfiles: "allow" });
  } catch {
    res.status(404).json({ ok: false, error: "找不到训练选集" });
  }
});

app.get("/api/datasets/:dataset/collections/:collection/snapshot", async (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  const collectionId = /^v\d{3}$/.test(req.params.collection) ? req.params.collection : null;
  if (!dataset || !collectionId) { res.status(400).json({ ok: false, error: "训练快照参数无效" }); return; }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    const collection = readCollections(root).find((item) => item.id === collectionId);
    if (!collection) { res.status(404).json({ ok: false, error: "找不到训练选集" }); return; }
    const sourceFiles = await Promise.all(listDatasetFiles(root).sort().map(async (relativePath) => {
      const absolute = path.join(root, relativePath); const stat = fs.statSync(absolute);
      return { relativePath, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), sha256: await fileSha256(absolute) };
    }));
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ dataset, collection, sourceFiles })).digest("hex");
    const snapshot = { schemaVersion: 1, generatedAt: new Date().toISOString(), dataset, collection, sourceFiles, fingerprint };
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/datasets/:dataset/audit", (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) { res.status(400).json({ ok: false, error: "无效的数据集名称" }); return; }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    res.json({ ok: true, entries: readAudit(root) });
  } catch {
    res.status(404).json({ ok: false, error: `找不到数据集: ${dataset}` });
  }
});

app.get("/api/training/host", async (req, res) => {
  try { res.json({ ok: true, ...await hostProfile() }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/training/resources", (req, res) => {
  try { res.json({ ok: true, ...resourceSample() }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/resources/estimate", async (req, res) => {
  const policies = ["act", "diffusion", "tdmpc", "vqbet", "smolvla", "pi0", "pi0-fast", "sac", "reward_classifier"];
  const policy = typeof req.body?.policy === "string" && policies.includes(req.body.policy) ? req.body.policy : null;
  const device = req.body?.device === "cpu" ? "cpu" : req.body?.device === "cuda" ? "cuda" : null;
  const batchSize = Number(req.body?.batchSize); const numWorkers = Number(req.body?.numWorkers ?? 4);
  if (!policy || !device || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1024 || !Number.isInteger(numWorkers) || numWorkers < 0 || numWorkers > 64) {
    res.status(400).json({ ok: false, error: "资源估算参数无效" }); return;
  }
  const job = { policy, device, batchSize, numWorkers } as TrainingJob;
  const estimate = estimateTrainingResources(job); const profile = await hostProfile(); const gpu = profile.gpu as { available?: boolean; memoryGb?: number | null }; const capacity = Number(gpu.memoryGb || 0);
  const ready = device === "cpu" ? Number(profile.memory && (profile.memory as Record<string, unknown>).freeGb || 0) >= estimate.systemMemoryGb * .75 : Boolean(gpu.available) && estimate.gpuMemoryGb <= capacity;
  res.json({ ok: true, ready, estimate, host: { gpuAvailable: Boolean(gpu.available), gpuMemoryGb: capacity || null, memoryFreeGb: (profile.memory as Record<string, unknown>).freeGb || null } });
});

app.get("/api/training/jobs", (req, res) => {
  const jobs = readTrainingJobs();
  let changed = false;
  for (const job of jobs) {
    if ((job.state === "running" || job.state === "stopping") && !trainingProcesses.has(job.id)) {
      job.state = "failed"; job.finishedAt = new Date().toISOString(); job.error = "服务重启，训练进程状态已丢失"; changed = true;
    }
  }
  if (changed) writeTrainingJobs(jobs);
  const includeArchived = req.query.archived === "true";
  res.json({ ok: true, jobs: jobs.filter((job) => includeArchived || !job.archivedAt).map(enrichTrainingJob) });
});

app.get("/api/training/models", (req, res) => {
  const store = readDeploymentStore();
  const models = readRegisteredModels().map((model) => ({ ...model, evaluation: aggregateModelEvaluation(model.id), deploymentGate: evaluateReleaseGate(model.id, store) }));
  res.json({ ok: true, models });
});

app.get("/api/training/deployments", (req, res) => {
  const store = readDeploymentStore();
  res.json({ ok: true, targets: store.targets.map((target) => enrichDeploymentTarget(target, store.incidents)), incidents: store.incidents, releaseGate: store.releaseGate });
});

app.post("/api/training/deployments/:target/heartbeat", async (req, res) => {
  const targetId = req.params.target;
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === targetId);
  const latencyMs = req.body?.latencyMs; const success = req.body?.success; const error = cleanShortText(req.body?.error, 500);
  if (!target || !target.currentRevisionId) { res.status(409).json({ ok: false, error: "部署目标当前没有活动修订" }); return; }
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 600000 || typeof success !== "boolean") {
    res.status(400).json({ ok: false, error: "心跳必须包含有效 latencyMs 和 success" }); return;
  }
  try {
    const runtime = await enqueueDeploymentRuntime(targetId, () => {
      const latestStore = readDeploymentStore(); const latestTarget = latestStore.targets.find((item) => item.id === targetId);
      if (!latestTarget || !latestTarget.currentRevisionId) throw new Error("部署目标当前没有活动修订");
      const next = { ...defaultDeploymentRuntime(), ...(latestTarget.runtime || {}) }; const now = new Date().toISOString();
      next.lastHeartbeat = now; next.updatedAt = now; next.startedAt = next.startedAt || now; next.processId = cleanShortText(req.body?.processId, 120) || next.processId;
      next.inferenceCount += 1; if (success) next.successCount += 1; else { next.errorCount += 1; if (error) next.lastError = error; }
      next.recentLatencies = [...next.recentLatencies, latencyMs].slice(-100);
      const sorted = [...next.recentLatencies].sort((a, b) => a - b); const p95Index = Math.max(0, Math.ceil(sorted.length * .95) - 1);
      next.avgLatencyMs = Math.round(next.recentLatencies.reduce((sum, value) => sum + value, 0) / next.recentLatencies.length * 10) / 10;
      next.p95LatencyMs = Math.round(sorted[p95Index] * 10) / 10;
      const errorRate = next.inferenceCount ? next.errorCount / next.inferenceCount : 0;
      next.status = !success || errorRate >= .1 || (next.p95LatencyMs || 0) > 1000 ? "degraded" : "healthy";
      latestTarget.runtime = next; writeDeploymentStore(latestStore); return deploymentRuntimeView(next);
    });
    res.status(200).json({ ok: true, runtime });
  } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.patch("/api/training/deployment-gate", (req, res) => {
  const minEvaluatedEpisodes = req.body?.minEvaluatedEpisodes;
  const minSuccessRate = req.body?.minSuccessRate;
  const minConfidenceLow = req.body?.minConfidenceLow;
  const blockOpenSeverity = req.body?.blockOpenSeverity;
  const validRate = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (!Number.isInteger(minEvaluatedEpisodes) || minEvaluatedEpisodes < 0 || minEvaluatedEpisodes > 10000 || !validRate(minSuccessRate) || !validRate(minConfidenceLow) || !["none", "critical", "error"].includes(blockOpenSeverity)) {
    res.status(400).json({ ok: false, error: "发布门禁参数无效" }); return;
  }
  const store = readDeploymentStore();
  store.releaseGate = {
    minEvaluatedEpisodes, minSuccessRate, minConfidenceLow, blockOpenSeverity,
    updatedAt: new Date().toISOString(), updatedBy: cleanShortText(req.body?.actor, 80) || "本地用户",
  };
  writeDeploymentStore(store); res.json({ ok: true, releaseGate: store.releaseGate });
});

app.post("/api/training/deployments/:target/deploy", async (req, res) => {
  const model = readRegisteredModels().find((item) => item.id === req.body?.modelId);
  if (!model) { res.status(404).json({ ok: false, error: "找不到已登记模型" }); return; }
  if (model.stage !== "production") { res.status(409).json({ ok: false, error: "只有 production 模型可以部署" }); return; }
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === req.params.target);
  if (!target) { res.status(404).json({ ok: false, error: "找不到部署目标" }); return; }
  const current = target.revisions.find((item) => item.id === target.currentRevisionId);
  if (current?.modelId === model.id) { res.status(409).json({ ok: false, error: "该模型已经是当前部署版本" }); return; }
  const releaseGate = evaluateReleaseGate(model.id, store); const overrideReason = cleanShortText(req.body?.overrideReason, 500);
  if (!releaseGate.ready && overrideReason.length < 10) {
    res.status(412).json({ ok: false, error: "模型未通过发布门禁，受控放行必须填写至少 10 个字符的理由", releaseGate }); return;
  }
  try {
    const revision = await activateDeployment(target.id, model, { actor: cleanShortText(req.body?.actor, 80), notes: cleanShortText(req.body?.notes, 500), action: "deploy", releaseGate, overrideReason });
    res.status(201).json({ ok: true, revision });
  } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/deployments/:target/rollback", async (req, res) => {
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === req.params.target);
  const source = target?.revisions.find((item) => item.id === req.body?.revisionId);
  if (!target || !source) { res.status(404).json({ ok: false, error: "找不到部署目标或历史修订" }); return; }
  if (source.id === target.currentRevisionId) { res.status(409).json({ ok: false, error: "所选修订已经是当前版本" }); return; }
  const model = readRegisteredModels().find((item) => item.id === source.modelId);
  if (!model) { res.status(409).json({ ok: false, error: "历史修订关联的模型已不存在" }); return; }
  try {
    const revision = await activateDeployment(target.id, model, { actor: cleanShortText(req.body?.actor, 80), notes: cleanShortText(req.body?.notes, 500), action: "rollback", rollbackOf: target.currentRevisionId });
    res.status(201).json({ ok: true, revision });
  } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/deployments/:target/incidents", (req, res) => {
  const store = readDeploymentStore(); const target = store.targets.find((item) => item.id === req.params.target);
  const severities: InferenceIncident["severity"][] = ["warning", "error", "critical"];
  const categories = ["jitter", "action_offset", "collision", "camera", "latency", "hardware", "other"];
  const severity = typeof req.body?.severity === "string" && severities.includes(req.body.severity) ? req.body.severity as InferenceIncident["severity"] : null;
  const category = typeof req.body?.category === "string" && categories.includes(req.body.category) ? req.body.category : null;
  const description = cleanShortText(req.body?.description, 1000);
  const current = target?.revisions.find((item) => item.id === target.currentRevisionId) || null;
  if (!target || !current || !severity || !category || !description) { res.status(400).json({ ok: false, error: "部署目标、严重程度、异常类型或描述无效" }); return; }
  const incident: InferenceIncident = {
    id: `incident-${Date.now().toString(36)}`, targetId: target.id, revisionId: current.id, modelId: current.modelId,
    severity, category, description, status: "open", reportedAt: new Date().toISOString(), reportedBy: cleanShortText(req.body?.actor, 80) || "本地用户", resolvedAt: null, resolution: "",
  };
  store.incidents.unshift(incident); writeDeploymentStore(store); res.status(201).json({ ok: true, incident });
});

app.patch("/api/training/incidents/:incident/resolve", (req, res) => {
  const store = readDeploymentStore(); const incident = store.incidents.find((item) => item.id === req.params.incident);
  const resolution = cleanShortText(req.body?.resolution, 1000);
  if (!incident) { res.status(404).json({ ok: false, error: "找不到推理异常" }); return; }
  if (incident.status === "resolved") { res.status(409).json({ ok: false, error: "异常已经关闭" }); return; }
  if (!resolution) { res.status(400).json({ ok: false, error: "关闭异常时必须填写处理结论" }); return; }
  incident.status = "resolved"; incident.resolvedAt = new Date().toISOString(); incident.resolution = resolution; writeDeploymentStore(store);
  res.json({ ok: true, incident });
});

app.get("/api/training/evaluations", (req, res) => {
  const jobs = readEvaluationJobs();
  let changed = false;
  for (const job of jobs) {
    if ((job.state === "running" || job.state === "stopping") && !evaluationProcesses.has(job.id)) {
      job.state = "failed"; job.finishedAt = new Date().toISOString(); job.error = "服务重启，评估进程状态已丢失"; changed = true;
    } else if (job.state === "draft" && evaluationEpisodeCount(job) >= job.numEpisodes) {
      job.state = "completed"; job.attempts = Math.max(1, job.attempts); job.startedAt ||= job.createdAt;
      try { job.finishedAt = fs.statSync(path.join(job.outputDatasetPath, "meta", "info.json")).mtime.toISOString(); } catch { job.finishedAt = new Date().toISOString(); }
      job.error = null; changed = true;
    }
  }
  if (changed) writeEvaluationJobs(jobs);
  res.json({ ok: true, jobs: jobs.map((job) => ({ ...job, summary: summarizeEvaluation(job) })) });
});

app.post("/api/training/evaluations", (req, res) => {
  const model = readRegisteredModels().find((item) => item.id === req.body?.modelId);
  const name = cleanShortText(req.body?.name, 80);
  const evalDataset = cleanDatasetName(req.body?.evalDataset);
  const task = cleanShortText(req.body?.task, 200);
  const followerPort = typeof req.body?.followerPort === "string" && /^\/dev\/[A-Za-z0-9._-]+$/.test(req.body.followerPort) ? req.body.followerPort : null;
  const leaderPort = typeof req.body?.leaderPort === "string" && /^\/dev\/[A-Za-z0-9._-]+$/.test(req.body.leaderPort) ? req.body.leaderPort : null;
  const followerId = typeof req.body?.followerId === "string" && /^[A-Za-z0-9_-]+$/.test(req.body.followerId) ? req.body.followerId : null;
  const leaderId = typeof req.body?.leaderId === "string" && /^[A-Za-z0-9_-]+$/.test(req.body.leaderId) ? req.body.leaderId : null;
  const firstCamera = Number(req.body?.cameraIndices?.[0]); const secondCamera = Number(req.body?.cameraIndices?.[1]);
  const device = req.body?.device === "cuda" ? "cuda" : "cpu";
  const numEpisodes = Number(req.body?.numEpisodes); const episodeTime = Number(req.body?.episodeTime); const resetTime = Number(req.body?.resetTime);
  if (!model || !name || !evalDataset || !task || !followerPort || !leaderPort || !followerId || !leaderId
      || followerPort === leaderPort || model.dataset === evalDataset
      || !Number.isInteger(firstCamera) || !Number.isInteger(secondCamera) || firstCamera < 0 || secondCamera < 0 || firstCamera === secondCamera
      || !Number.isInteger(numEpisodes) || numEpisodes < 1 || numEpisodes > 1000
      || !Number.isInteger(episodeTime) || episodeTime < 1 || episodeTime > 3600
      || !Number.isInteger(resetTime) || resetTime < 0 || resetTime > 3600) {
    res.status(400).json({ ok: false, error: "评估任务参数无效，评估 Dataset 必须与训练 Dataset 不同" }); return;
  }
  const outputDatasetPath = datasetPath(evalDataset);
  if (readEvaluationJobs().some((job) => job.evalDataset === evalDataset)) { res.status(409).json({ ok: false, error: "评估 Dataset 已被其他任务使用，请使用新的名称" }); return; }
  if (fs.existsSync(path.join(outputDatasetPath, "meta", "info.json"))) { res.status(409).json({ ok: false, error: "评估 Dataset 已存在，请使用新的名称" }); return; }
  const id = `eval-${Date.now().toString(36)}`;
  const job: EvaluationJob = {
    id, name, modelId: model.id, modelName: model.name, modelVersion: model.version, evalDataset, task,
    followerPort, followerId, leaderPort, leaderId, cameraIndices: [firstCamera, secondCamera], device,
    numEpisodes, episodeTime, resetTime, state: "draft", attempts: 0, createdAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, outputDatasetPath, command: [], exitCode: null, error: null, logs: [],
  };
  job.command = buildEvaluationCommand(job, model);
  const jobs = readEvaluationJobs(); jobs.unshift(job); writeEvaluationJobs(jobs);
  res.status(201).json({ ok: true, job });
});

app.get("/api/training/evaluations/:job/preflight", async (req, res) => {
  const job = readEvaluationJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到评估任务" }); return; }
  try { res.json({ ok: true, ...await evaluationPreflight(job) }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/evaluations/:job/start", async (req, res) => {
  const job = readEvaluationJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到评估任务" }); return; }
  if (!["draft", "failed", "cancelled"].includes(job.state)) { res.status(409).json({ ok: false, error: "只有草稿、失败或已停止任务可以启动" }); return; }
  try {
    const preflight = await evaluationPreflight(job);
    if (!preflight.ready) { res.status(409).json({ ok: false, error: "评估启动前检查未通过", preflight }); return; }
    await startEvaluationJob(job); res.json({ ok: true, job, preflight });
  } catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/evaluations/:job/stop", (req, res) => {
  const child = evaluationProcesses.get(req.params.job);
  if (!child) { res.status(409).json({ ok: false, error: "评估任务未运行" }); return; }
  const job = updateEvaluationJob(req.params.job, (current) => { current.state = "stopping"; });
  child.kill("SIGTERM"); res.json({ ok: true, job });
});

app.delete("/api/training/evaluations/:job", (req, res) => {
  const jobs = readEvaluationJobs();
  const job = jobs.find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到评估任务" }); return; }
  if (job.state !== "draft" || job.attempts > 0 || fs.existsSync(job.outputDatasetPath)) { res.status(409).json({ ok: false, error: "只能删除从未启动且没有输出数据的草稿" }); return; }
  writeEvaluationJobs(jobs.filter((item) => item.id !== job.id));
  res.json({ ok: true, deleted: job.id });
});

app.get("/api/training/evaluations/:job/results", async (req, res) => {
  const job = readEvaluationJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到评估任务" }); return; }
  if (!fs.existsSync(path.join(job.outputDatasetPath, "meta", "info.json"))) { res.json({ ok: true, available: false, summary: summarizeEvaluation(job), episodes: [] }); return; }
  try {
    const detail = await runDatasetCatalog("detail", job.evalDataset);
    const results = readEvaluationResults(job); const reviews = readReviews(job.outputDatasetPath);
    const episodes = Array.isArray(detail.episodes) ? detail.episodes.map((episode) => {
      const item = episode as Record<string, unknown>; const index = Number(item.episode);
      const videos = item.videos && typeof item.videos === "object" ? Object.fromEntries(
        Object.entries(item.videos as Record<string, string>).map(([key, relative]) => [key, `/api/datasets/${encodeURIComponent(job.evalDataset)}/video?file=${Buffer.from(relative).toString("base64url")}`]),
      ) : {};
      return { ...item, videos, dataReview: reviews.episodes[String(index)] || { status: "unreviewed" }, outcome: results.episodes[String(index)] || { status: "unreviewed", failureReason: "", notes: "", reviewer: "" } };
    }) : [];
    res.json({ ok: true, available: true, summary: summarizeEvaluation(job), episodes });
  } catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.patch("/api/training/evaluations/:job/results/:episode", (req, res) => {
  const job = readEvaluationJobs().find((item) => item.id === req.params.job); const episode = Number(req.params.episode);
  if (!job || !Number.isInteger(episode) || episode < 0) { res.status(404).json({ ok: false, error: "找不到评估任务或 Episode" }); return; }
  const statuses: EvaluationOutcomeStatus[] = ["unreviewed", "success", "failure", "invalid"];
  const status = typeof req.body?.status === "string" && statuses.includes(req.body.status) ? req.body.status as EvaluationOutcomeStatus : null;
  const failureReasons = ["", "object_missed", "grasp_failed", "placement_failed", "collision", "timeout", "unstable", "camera_occlusion", "action_offset", "other"];
  const failureReason = typeof req.body?.failureReason === "string" && failureReasons.includes(req.body.failureReason) ? req.body.failureReason : null;
  if (!status || failureReason === null || (status === "failure" && !failureReason)) { res.status(400).json({ ok: false, error: "评估结果无效；失败结果必须选择失败原因" }); return; }
  try {
    ensureEpisodeExists(job.outputDatasetPath, episode);
    const results = readEvaluationResults(job); const previous = results.episodes[String(episode)]; const now = new Date().toISOString();
    const outcome: EvaluationOutcome = { status, failureReason: status === "failure" || status === "invalid" ? failureReason : "", notes: cleanShortText(req.body?.notes, 2000), reviewer: cleanShortText(req.body?.reviewer, 80), createdAt: previous?.createdAt || now, updatedAt: now };
    results.episodes[String(episode)] = outcome; writeEvaluationResults(job, results);
    appendAudit(job.outputDatasetPath, { action: "evaluation.outcome", actor: outcome.reviewer || "本地用户", dataset: job.evalDataset, episodes: [episode], evaluationJob: job.id, model: job.modelId, outcome: status, failureReason: outcome.failureReason });
    res.json({ ok: true, outcome, summary: summarizeEvaluation(job) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); res.status(message.startsWith("找不到") ? 404 : 400).json({ ok: false, error: message });
  }
});

app.post("/api/training/jobs", (req, res) => {
  const dataset = cleanDatasetName(req.body.dataset);
  const collectionId = typeof req.body.collection === "string" && /^v\d{3}$/.test(req.body.collection) ? req.body.collection : null;
  const policies = ["act", "diffusion", "tdmpc", "vqbet", "smolvla", "pi0", "pi0-fast", "sac", "reward_classifier"];
  const policy = typeof req.body.policy === "string" && policies.includes(req.body.policy) ? req.body.policy : null;
  const device = req.body.device === "cpu" ? "cpu" : "cuda";
  const batchSize = Number(req.body.batchSize);
  const steps = Number(req.body.steps);
  const logFreq = Number(req.body.logFreq ?? 200);
  const saveFreq = Number(req.body.saveFreq ?? Math.min(20000, steps));
  const numWorkers = Number(req.body.numWorkers ?? 4);
  const seed = Number(req.body.seed ?? 1000);
  const name = cleanShortText(req.body.name, 80);
  if (!dataset || !collectionId || !policy || !name || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1024 || !Number.isInteger(steps) || steps < 1 || steps > 10_000_000 || !Number.isInteger(logFreq) || logFreq < 1 || logFreq > steps || !Number.isInteger(saveFreq) || saveFreq < 1 || saveFreq > steps || !Number.isInteger(numWorkers) || numWorkers < 0 || numWorkers > 64 || !Number.isInteger(seed) || seed < 0) {
    res.status(400).json({ ok: false, error: "训练任务参数无效" }); return;
  }
  try {
    const root = fs.realpathSync(datasetPath(dataset));
    const collection = JSON.parse(fs.readFileSync(path.join(collectionsDirectory(root), `${collectionId}.json`), "utf-8")) as TrainingCollection;
    const episodes = collection.episodes.map((item) => item.episode);
    if (!episodes.length) throw new Error("训练选集没有 Episode");
    const id = `train-${Date.now().toString(36)}`;
    const outputDir = path.join(TRAINING_ROOT, "outputs", id);
    const command = [
      "-m", "lerobot.scripts.lerobot_train",
      `--dataset.repo_id=local/${dataset}`,
      `--dataset.root=${root}`,
      `--dataset.episodes=[${episodes.join(",")}]`,
      `--policy.type=${policy}`,
      `--output_dir=${outputDir}`,
      `--job_name=${name}`,
      `--policy.device=${device}`,
      "--policy.push_to_hub=false",
      "--wandb.enable=false",
      `--batch_size=${batchSize}`,
      `--steps=${steps}`,
      `--log_freq=${logFreq}`,
      `--save_freq=${saveFreq}`,
      `--num_workers=${numWorkers}`,
      `--seed=${seed}`,
    ];
    const job: TrainingJob = {
      id, name, dataset, collection: collectionId, episodes, policy, device, batchSize, steps, logFreq, saveFreq, numWorkers, seed, attempts: 0,
      state: "draft", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      outputDir, command, exitCode: null, error: null, logs: [],
    };
    const jobs = readTrainingJobs(); jobs.unshift(job); writeTrainingJobs(jobs);
    res.status(201).json({ ok: true, job });
  } catch (error) {
    res.status(404).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/training/jobs/:job/start", (req, res) => {
  const jobs = readTrainingJobs();
  const job = jobs.find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  if (job.state !== "draft" && job.state !== "failed") { res.status(409).json({ ok: false, error: "只有草稿或失败任务可以启动" }); return; }
  if (job.state === "failed" && fs.existsSync(job.outputDir)) { res.status(409).json({ ok: false, error: "失败任务已有输出，请新建任务或使用 Checkpoint 续训" }); return; }
  void trainingPreflight(job).then((preflight) => {
    if (!preflight.ready) { res.status(409).json({ ok: false, error: "启动前检查未通过", preflight }); return; }
    try { startTrainingJob(job); res.json({ ok: true, job, preflight }); }
    catch (error) { res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error), preflight }); }
  }).catch((error) => res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});

app.get("/api/training/jobs/:job/preflight", async (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  try { res.json({ ok: true, ...await trainingPreflight(job) }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.get("/api/training/jobs/:job/cloud-spec", (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  const remoteRoot = `/data/lerobot/${job.dataset}`;
  const remoteOutput = `outputs/${job.id}`;
  const remoteCommand = job.command.map((argument) => argument.replace(`--dataset.root=${datasetPath(job.dataset)}`, `--dataset.root=${remoteRoot}`).replace(`--output_dir=${job.outputDir}`, `--output_dir=${remoteOutput}`));
  const spec = {
    schemaVersion: 1,
    provider: "generic-ssh",
    generatedAt: new Date().toISOString(),
    job: { id: job.id, name: job.name, policy: job.policy, device: job.device, batchSize: job.batchSize, steps: job.steps, numWorkers: job.numWorkers ?? 4, seed: job.seed ?? 1000 },
    dataset: { name: job.dataset, collection: job.collection, episodes: job.episodes, localRoot: datasetPath(job.dataset), remoteRoot, manifestUrl: `/api/datasets/${encodeURIComponent(job.dataset)}/collections/${encodeURIComponent(job.collection)}/snapshot` },
    resourceEstimate: estimateTrainingResources(job),
    sync: { exclude: [".lerobot-web"], command: ["rsync", "-a", "--exclude=.lerobot-web", `${datasetPath(job.dataset)}/`, `user@cloud-host:${remoteRoot}/`] },
    remote: { workingDirectory: remoteOutput, trainCommand: ["python3", ...remoteCommand], installHint: "在云主机安装与本地一致的 lerobot 版本及策略依赖；默认不上传 Hugging Face/WandB。" },
    notes: ["这是可审计的命令方案，不会连接云主机或上传数据。", "上传前请在云端校验 snapshot manifest fingerprint。"],
  };
  res.json({ ok: true, spec });
});

app.post("/api/training/jobs/:job/clone", (req, res) => {
  const source = readTrainingJobs().find((item) => item.id === req.params.job);
  if (!source) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  const id = `train-${Date.now().toString(36)}`;
  const outputDir = path.join(TRAINING_ROOT, "outputs", id);
  const command = [
    "-m", "lerobot.scripts.lerobot_train",
    `--dataset.repo_id=local/${source.dataset}`,
    `--dataset.root=${datasetPath(source.dataset)}`,
    `--dataset.episodes=[${source.episodes.join(",")}]`,
    `--policy.type=${source.policy}`,
    `--output_dir=${outputDir}`,
    `--job_name=${source.name} copy`,
    `--policy.device=${source.device}`,
    "--policy.push_to_hub=false", "--wandb.enable=false",
    `--batch_size=${source.batchSize}`, `--steps=${source.steps}`,
    `--log_freq=${source.logFreq ?? 200}`, `--save_freq=${source.saveFreq ?? Math.min(20000, source.steps)}`,
    `--num_workers=${source.numWorkers ?? 4}`, `--seed=${source.seed ?? 1000}`,
  ];
  const cloned: TrainingJob = { ...source, id, name: `${source.name} copy`, state: "draft", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, outputDir, command, exitCode: null, error: null, logs: [], attempts: 0, archivedAt: null, bestAt: null };
  const jobs = readTrainingJobs(); jobs.unshift(cloned); writeTrainingJobs(jobs);
  res.status(201).json({ ok: true, job: enrichTrainingJob(cloned) });
});

app.post("/api/training/jobs/:job/archive", (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  if (["running", "stopping"].includes(job.state)) { res.status(409).json({ ok: false, error: "运行中的任务不能归档" }); return; }
  const archived = req.body?.archived !== false;
  const updated = updateTrainingJob(job.id, (current) => { current.archivedAt = archived ? new Date().toISOString() : null; });
  res.json({ ok: true, job: updated ? enrichTrainingJob(updated) : null });
});

app.post("/api/training/jobs/:job/best", (req, res) => {
  const jobs = readTrainingJobs();
  const job = jobs.find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  if (job.state !== "completed") { res.status(409).json({ ok: false, error: "只有已完成任务可以标记为最佳 Run" }); return; }
  const best = req.body?.best !== false;
  const now = new Date().toISOString();
  for (const item of jobs) {
    if (best && item.dataset === job.dataset && item.collection === job.collection && item.policy === job.policy) item.bestAt = null;
  }
  job.bestAt = best ? now : null;
  writeTrainingJobs(jobs);
  res.json({ ok: true, job: enrichTrainingJob(job) });
});

app.get("/api/training/jobs/:job/checkpoints/:checkpoint/integrity", async (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  const checkpoint = job && trainingCheckpoints(job).find((item) => item.name === req.params.checkpoint);
  if (!job || !checkpoint) { res.status(404).json({ ok: false, error: "找不到 Checkpoint" }); return; }
  if (!checkpoint.modelPath) { res.status(404).json({ ok: false, error: "Checkpoint 中没有 model.safetensors" }); return; }
  try { res.json({ ok: true, algorithm: "sha256", hash: await fileSha256(checkpoint.modelPath), file: path.basename(checkpoint.modelPath), sizeBytes: fs.statSync(checkpoint.modelPath).size }); }
  catch (error) { res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/training/jobs/:job/checkpoints/:checkpoint/register", async (req, res) => {
  const job = readTrainingJobs().find((item) => item.id === req.params.job);
  const checkpoint = job && trainingCheckpoints(job).find((item) => item.name === req.params.checkpoint);
  if (!job || !checkpoint) { res.status(404).json({ ok: false, error: "找不到 Checkpoint" }); return; }
  if (!checkpoint.modelPath) { res.status(409).json({ ok: false, error: "Checkpoint 中没有可登记的 model.safetensors" }); return; }
  const models = readRegisteredModels();
  const existing = models.find((model) => model.jobId === job.id && model.checkpoint === checkpoint.name);
  if (existing) { res.status(409).json({ ok: false, error: `该 Checkpoint 已登记为 ${existing.name} v${existing.version}` }); return; }
  const name = cleanShortText(req.body?.name, 80) || job.name;
  const notes = cleanShortText(req.body?.notes, 500);
  const version = Math.max(0, ...models.filter((model) => model.name === name).map((model) => model.version)) + 1;
  try {
    const now = new Date().toISOString();
    const model: RegisteredModel = {
      id: `model-${Date.now().toString(36)}`, name, version, jobId: job.id, checkpoint: checkpoint.name,
      step: checkpoint.step, policy: job.policy, dataset: job.dataset, collection: job.collection,
      modelPath: checkpoint.modelPath, sizeBytes: fs.statSync(checkpoint.modelPath).size,
      sha256: await fileSha256(checkpoint.modelPath), stage: "candidate", notes, createdAt: now, updatedAt: now,
    };
    models.unshift(model); writeRegisteredModels(models);
    res.status(201).json({ ok: true, model });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/api/training/models/:model", (req, res) => {
  const models = readRegisteredModels();
  const model = models.find((item) => item.id === req.params.model);
  if (!model) { res.status(404).json({ ok: false, error: "找不到已登记模型" }); return; }
  const stages: ModelStage[] = ["candidate", "production", "archived"];
  const stage = typeof req.body?.stage === "string" && stages.includes(req.body.stage) ? req.body.stage as ModelStage : null;
  if (!stage) { res.status(400).json({ ok: false, error: "模型阶段无效" }); return; }
  if (stage === "production") {
    for (const item of models) if (item.name === model.name && item.stage === "production") { item.stage = "candidate"; item.updatedAt = new Date().toISOString(); }
  }
  model.stage = stage; model.updatedAt = new Date().toISOString();
  writeRegisteredModels(models);
  res.json({ ok: true, model });
});

app.post("/api/training/jobs/:job/stop", (req, res) => {
  const child = trainingProcesses.get(req.params.job);
  if (!child) { res.status(409).json({ ok: false, error: "训练任务未运行" }); return; }
  const job = updateTrainingJob(req.params.job, (current) => { current.state = "stopping"; });
  child.kill("SIGTERM");
  res.json({ ok: true, job });
});

app.post("/api/training/jobs/:job/resume", (req, res) => {
  const jobs = readTrainingJobs();
  const job = jobs.find((item) => item.id === req.params.job);
  if (!job) { res.status(404).json({ ok: false, error: "找不到训练任务" }); return; }
  if (!["failed", "cancelled"].includes(job.state)) { res.status(409).json({ ok: false, error: "只有失败或已停止的任务可以续训" }); return; }
  const checkpoint = trainingCheckpoints(job)[0];
  if (!checkpoint) { res.status(409).json({ ok: false, error: "没有可用 Checkpoint，无法续训" }); return; }
  void trainingPreflight(job).then((preflight) => {
    if (!preflight.ready) { res.status(409).json({ ok: false, error: "启动前检查未通过", preflight }); return; }
    try {
      job.command = ["-m", "lerobot.scripts.lerobot_train", `--config_path=${checkpoint.configPath}`, "--resume=true"];
      startTrainingJob(job);
      res.json({ ok: true, job: enrichTrainingJob(job), preflight });
    } catch (error) {
      res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error), preflight });
    }
  }).catch((error) => res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});

app.post("/api/recording/start", (req, res) => {
  if (evaluationProcesses.size > 0) {
    res.status(409).json({ ok: false, error: "模型评估正在占用机械臂和摄像头" });
    return;
  }
  if (!bridge?.isRunning() || stopping) {
    res.status(409).json({ ok: false, error: "请先启动遥操作" });
    return;
  }
  if (recordingIsActive() || recorder?.isRunning()) {
    res.status(409).json({ ok: false, error: "录制任务已在运行" });
    return;
  }
  const dataset = cleanDatasetName(req.body.dataset);
  const task = typeof req.body.task === "string" ? req.body.task.trim() : "";
  const fps = req.body.fps ?? 30;
  const plannedEpisodes = Number(req.body.plannedEpisodes ?? 10);
  const episodeTime = Number(req.body.episodeTime ?? 20);
  const resetTime = Number(req.body.resetTime ?? 5);
  const resume = req.body.resume === true;
  if (!dataset) {
    res.status(400).json({ ok: false, error: "数据集名称仅支持字母、数字、点、下划线和连字符（最多 64 字符）" });
    return;
  }
  if (!task || task.length > 200) {
    res.status(400).json({ ok: false, error: "任务描述不能为空且不能超过 200 字符" });
    return;
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > CAMERA_FPS) {
    res.status(400).json({ ok: false, error: `录制 FPS 必须是 1-${CAMERA_FPS} 之间的整数` });
    return;
  }
  if (!Number.isInteger(plannedEpisodes) || plannedEpisodes < 1 || plannedEpisodes > 10000 || !Number.isInteger(episodeTime) || episodeTime < 1 || episodeTime > 3600 || !Number.isInteger(resetTime) || resetTime < 0 || resetTime > 3600) {
    res.status(400).json({ ok: false, error: "计划组数、单轮时长或复位时间无效" });
    return;
  }
  const now = Date.now();
  if (!latestObservation || now - latestObservationAt > RECORDING_MAX_SENSOR_AGE_MS) {
    res.status(409).json({ ok: false, error: "没有收到实时关节状态和动作，无法开始录制" });
    return;
  }
  if (
    !latestCameraFrame
    || !latestCamera2Frame
    || now - cameraLastFrameAt > RECORDING_MAX_SENSOR_AGE_MS
    || now - camera2LastFrameAt > RECORDING_MAX_SENSOR_AGE_MS
    || Math.abs(cameraLastFrameAt - camera2LastFrameAt) > RECORDING_MAX_CAMERA_SKEW_MS
  ) {
    res.status(409).json({ ok: false, error: "录制需要两路实时摄像头画面" });
    return;
  }

  const datasetPath = path.join(DATASET_ROOT, dataset);
  if (fs.existsSync(path.join(datasetPath, "meta", "info.json")) && !resume) {
    res.status(409).json({ ok: false, error: "数据集已存在；请勾选续录或更换数据集名称" });
    return;
  }
  const startedRecorder = new RobotBridge(RECORDER_SCRIPT, [
    "--root", datasetPath,
    "--repo-id", `local/${dataset}`,
    "--fps", String(fps),
    "--task", task,
    "--robot-type", "so101_follower",
    "--streaming-encoding", DATASET_STREAMING_ENCODING,
    ...(DATASET_VIDEO_CODEC ? ["--vcodec", DATASET_VIDEO_CODEC] : []),
  ], PYTHON_PATH);
  startedRecorder.on("log", ({ level, message }) => {
    const normalizedLevel: RuntimeLogLevel = level === "error" || level === "stderr" ? "error" : level === "warn" ? "warn" : "info";
    persistRuntimeLog("recorder", normalizedLevel, message);
    broadcastControl({ type: "bridge_log", source: "recorder", level: normalizedLevel, message });
  });
  recorder = startedRecorder;
  recorderFramePending = false;
  nextRecorderFrameAt = 0;
  recordingStatus = {
    state: "preparing", dataset, task, fps, frames: 0,
    episode: null, path: datasetPath, error: null, plannedEpisodes, episodeTime, resetTime, resume,
  };

  startedRecorder.on("message", (msg: BridgeMessage) => {
    if (recorder !== startedRecorder) return;
    switch (msg.type) {
      case "recorder_ready":
        recordingStatus = { ...recordingStatus, state: "recording" };
        break;
      case "dataset_opened":
        recordingStatus = {
          ...recordingStatus,
          episode: typeof msg.episode === "number" ? msg.episode : recordingStatus.episode,
          path: typeof msg.path === "string" ? msg.path : recordingStatus.path,
        };
        break;
      case "frame_added":
        recorderFramePending = false;
        recordingStatus = {
          ...recordingStatus,
          frames: typeof msg.frames === "number" ? msg.frames : recordingStatus.frames + 1,
        };
        if (recordingStatus.frames >= recordingStatus.fps * recordingStatus.episodeTime) requestRecordingSave();
        break;
      case "episode_saved":
        recorderFramePending = false;
        clearDatasetCatalogCache(dataset);
        recordingStatus = {
          ...recordingStatus,
          state: "idle",
          episode: typeof msg.episode === "number" ? msg.episode : recordingStatus.episode,
          frames: typeof msg.frames === "number" ? msg.frames : recordingStatus.frames,
          path: typeof msg.path === "string" ? msg.path : recordingStatus.path,
        };
        break;
      case "recording_cancelled":
        recorderFramePending = false;
        recordingStatus = { ...recordingStatus, state: "idle", frames: 0 };
        break;
      case "recorder_error":
        recorderFramePending = false;
        recordingStatus = { ...recordingStatus, state: "error", error: String(msg.error || "录制进程异常") };
        break;
      default:
        return;
    }
    publishRecordingStatus();
  });
  startedRecorder.on("exit", (code, errorLine) => {
    if (recorder !== startedRecorder) return;
    recorder = null;
    recorderFramePending = false;
    if (recordingIsActive()) {
      recordingStatus = {
        ...recordingStatus,
        state: "error",
        error: recordingStatus.error || errorLine || `录制进程意外退出 (code=${code})`,
      };
      publishRecordingStatus();
    }
  });
  startedRecorder.on("error", (error) => {
    if (recorder !== startedRecorder) return;
    recordingStatus = { ...recordingStatus, state: "error", error: error.message };
    publishRecordingStatus();
  });
  startedRecorder.start();
  publishRecordingStatus();
  res.json({ ok: true, ...recordingStatus });
});

app.post("/api/recording/stop", (req, res) => {
  if (!requestRecordingSave()) {
    res.status(409).json({ ok: false, error: "当前没有可停止的录制任务" });
    return;
  }
  res.json({ ok: true, ...recordingStatus });
});

app.post("/api/recording/cancel", (req, res) => {
  if (!recorder?.isRunning() || !["preparing", "recording"].includes(recordingStatus.state)) {
    res.status(409).json({ ok: false, error: "当前没有可取消的录制任务" });
    return;
  }
  recordingStatus = { ...recordingStatus, state: "saving" };
  publishRecordingStatus();
  recorder.send({ type: "cancel" });
  res.json({ ok: true, ...recordingStatus });
});

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
    const cameras = fs.readdirSync("/dev").filter((name) => /^video\d+$/.test(name)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
      .map((name) => ({ index: Number(name.slice(5)), path: `/dev/${name}` }));
    res.json({
      cameras,
      active: { camera: activeCameraIndex, camera2: activeCameraIndex2 },
      detected: detectUsbCameraIndices(),
      stream: { width: CAMERA_WIDTH, height: CAMERA_HEIGHT, fps: CAMERA_FPS, codec: "MJPG" },
    });
  } catch {
    res.json({
      cameras: [],
      active: { camera: activeCameraIndex, camera2: activeCameraIndex2 },
      detected: [],
    });
  }
});

app.get("/api/self-check", (req, res) => {
  const followerId = typeof req.query.follower_id === "string" ? req.query.follower_id : "R12253102";
  const now = Date.now();
  const detected = detectUsbCameraIndices();
  let serialPorts: string[] = [];
  try {
    serialPorts = fs.readdirSync("/dev")
      .filter((name) => /^tty(?:ACM|USB)\d+$/.test(name))
      .sort()
      .map((name) => `/dev/${name}`);
  } catch { /* /dev unavailable */ }
  const calibrationPath = /^[A-Za-z0-9_-]+$/.test(followerId)
    ? path.join(process.env.HOME || "/root", ".lerobot", "calibration", "so101_follower", `${followerId}.json`)
    : "";

  let calibrationValid = false;
  if (calibrationPath) {
    try {
      const calibration = JSON.parse(fs.readFileSync(calibrationPath, "utf-8"));
      calibrationValid = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
        .every((name) => Number.isInteger(calibration[name]?.id));
    } catch { /* invalid or missing calibration */ }
  }

  const cameraStatus = (
    index: number,
    child: { isRunning(): boolean } | null,
    lastFrameAt: number,
    error: string | null,
    metrics: Record<string, unknown>,
  ) => ({
    index,
    detected: index >= 0 && detected.includes(index),
    processRunning: Boolean(child?.isRunning()),
    frameFresh: lastFrameAt > 0 && now - lastFrameAt < 2000,
    lastFrameAgeMs: lastFrameAt > 0 ? now - lastFrameAt : null,
    error,
    metrics,
  });

  res.json({
    checkedAt: new Date(now).toISOString(),
    server: { ok: true, running: bridge ? bridge.isRunning() && !stopping : false },
    capture: {
      storage: "lerobot-dataset",
    },
    follower: {
      ports: serialPorts,
      portPresent: serialPorts.length > 0,
      id: followerId,
      calibrationValid,
    },
    camerasDetected: detected,
    cameras: [
      cameraStatus(activeCameraIndex, cameraBridge, cameraLastFrameAt, cameraError, cameraMetrics),
      cameraStatus(activeCameraIndex2, cameraBridge2, camera2LastFrameAt, camera2Error, camera2Metrics),
    ],
  });
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
  if (evaluationProcesses.size > 0) {
    res.status(409).json({ ok: false, error: "模型评估正在占用机械臂和摄像头" });
    return;
  }
  if (bridge && bridge.isRunning()) {
    res.status(400).json({ ok: false, error: stopping ? "正在停止，请稍候" : "已在运行中" });
    return;
  }

  const {
    follower_port = "/dev/ttyACM0",
    follower_id = "",
    leader_port = "/dev/ttyACM1",
    leader_id = "",
    // 控制链路默认 60 FPS；状态观测仍由 CONTROL_OBSERVATION_FPS 独立限频。
    fps = 60,
    remote_leader = false,
    camera_index = -1,
    camera_fps = 15,
  } = req.body;
  const commandSource = remote_leader ? "web" : "leader";
  const requiresFollowerSerial = true;
  const requiresLeaderSerial = commandSource === "leader";

  if (requiresFollowerSerial && (typeof follower_port !== "string" || !follower_port.startsWith("/dev/tty"))) {
    res.status(400).json({ ok: false, error: "Follower 串口无效" });
    return;
  }
  if (requiresFollowerSerial && (typeof follower_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(follower_id))) {
    res.status(400).json({ ok: false, error: "Follower ID 无效" });
    return;
  }
  if (requiresLeaderSerial && (typeof leader_port !== "string" || !leader_port.startsWith("/dev/tty"))) {
    res.status(400).json({ ok: false, error: "Leader 串口无效" });
    return;
  }
  if (requiresLeaderSerial && (typeof leader_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(leader_id))) {
    res.status(400).json({ ok: false, error: "Leader ID 无效" });
    return;
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) {
    res.status(400).json({ ok: false, error: "FPS 必须是 1-60 之间的整数" });
    return;
  }

  if (ENABLE_CAMERA && Number.isInteger(camera_index) && camera_index >= 0 && camera_index !== activeCameraIndex) {
    startCamera(camera_index);
  }

  const args = [
    "--follower-port", follower_port,
    "--follower-id", follower_id,
    "--leader-port", leader_port,
    "--leader-id", leader_id,
    "--fps", String(fps),
    "--observation-fps", String(Math.max(1, Math.min(fps, CONTROL_OBSERVATION_FPS))),
  ];
  if (remote_leader) args.push("--remote-leader");

  console.log(`[Server] 启动串口控制桥: ${CONTROL_PYTHON_PATH} ${TELEOP_SCRIPT} ${args.join(" ")}`);

  const startedBridge = new RobotBridge(TELEOP_SCRIPT, args, CONTROL_PYTHON_PATH);
  startedBridge.on("log", ({ level, message }) => {
    const normalizedLevel: RuntimeLogLevel = level === "error" || level === "stderr" ? "error" : level === "warn" ? "warn" : "info";
    persistRuntimeLog("teleop", normalizedLevel, message);
    broadcastControl({ type: "bridge_log", source: "teleop", level: normalizedLevel, message });
  });
  bridge = startedBridge;
  stopping = false;
  remoteLeaderActive = commandSource === "web";
  latestObservation = null;
  latestObservationAt = 0;

  startedBridge.on("message", (msg: BridgeMessage) => {
    switch (msg.type) {
      case "teleop_observation":
        latestObservation = msg;
        latestObservationAt = Date.now();
        broadcastControl(msg);
        break;

      case "capture_sample":
        recordCaptureSample(msg);
        break;

      default:
        console.log(`[Server] 未知消息类型: ${msg.type}`);
    }
  });

  startedBridge.on("exit", (code, errorLine) => {
    console.log(`[Server] 遥操作进程退出 (code=${code})`);
    // 旧进程的退出不能影响之后启动的新进程。
    if (bridge === startedBridge) {
      const wasRequested = stopping;
      if (!wasRequested) requestRecordingSave();
      bridge = null;
      stopping = false;
      remoteLeaderActive = false;
      // 非用户主动停止且带非零退出码，说明 Python 侧崩溃；把报错原因推给前端弹窗提示。
      const crashError = !wasRequested && code !== 0 ? errorLine || `进程异常退出 (code=${code})` : null;
      broadcastControl({ type: "stopped", error: crashError });
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
  if (!stopTeleop()) {
    res.json({ ok: true, alreadyStopped: true });
    return;
  }
  res.json({ ok: true });
});

// 状态查询
app.get("/api/status", (req, res) => {
  res.json({
    running: bridge ? bridge.isRunning() && !stopping : false,
    clients: clients.size,
    controlBackend: "serial",
    commandSource: remoteLeaderActive ? "web" : "leader",
    rtc: { enabled: rtcGateway.isEnabled(), peers: rtcGateway.peerCount() },
  });
});

app.get("/api/rtc/config", (_req, res) => {
  res.json({
    enabled: rtcGateway.isEnabled(),
    videoEnabled: rtcGateway.isVideoEnabled(),
    iceServers: RTC_ICE_SERVERS,
    channels: {
      control: "robot-control-v1",
      state: "robot-state-v1",
      video: "robot-video-v1",
      safety: "robot-safety-v1",
    },
  });
});

app.post("/api/rtc/offer", async (req, res) => {
  try {
    const answer = await rtcGateway.acceptOffer(req.body);
    res.json(answer);
  } catch (error) {
    res.status(rtcGateway.isEnabled() ? 400 : 503).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// 切换摄像头
app.post("/api/camera/switch", (req, res) => {
  if (evaluationProcesses.size > 0) {
    res.status(409).json({ ok: false, error: "模型评估期间不能切换摄像头" });
    return;
  }
  if (recordingIsActive()) {
    res.status(409).json({ ok: false, error: "录制期间不能切换摄像头" });
    return;
  }
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

// 未知 API 必须返回 JSON 404，不能落入 SPA fallback 后返回 index.html。
app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: `API 不存在: ${req.method} ${req.originalUrl}` });
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
  if (controlDisconnectTimer) {
    clearTimeout(controlDisconnectTimer);
    controlDisconnectTimer = null;
  }

  // 发送当前状态
  ws.send(JSON.stringify({ type: "status", running: bridge ? bridge.isRunning() && !stopping : false }));
  ws.send(JSON.stringify({ type: "recording_status", ...recordingStatus }));

  // 发送最新 observation
  if (latestObservation) {
    ws.send(JSON.stringify(latestObservation));
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "action" && bridge?.isRunning() && remoteLeaderActive && !stopping) {
        bridge.send(msg);
      } else if (msg.type === "ping") {
        // 用于前端估算浏览器与本机时钟偏差，从而修正跨进程时间戳算出的延迟显示。
        ws.send(JSON.stringify({ type: "pong", clientTs: msg.ts, serverTs: Date.now() }));
      }
    } catch (err) {
      console.error("[Server] 解析客户端消息失败:", err);
    }
  });

  ws.on("close", () => {
    console.log("[Server] 控制客户端断开");
    clients.delete(ws);
    if (remoteLeaderActive && clients.size === 0 && rtcGateway.peerCount() === 0 && !controlDisconnectTimer) {
      // 页面刷新和 Wi-Fi 瞬断会很快重连；给短暂宽限期，持续断开才安全停机。
      controlDisconnectTimer = setTimeout(() => {
        controlDisconnectTimer = null;
        if (remoteLeaderActive && clients.size === 0 && rtcGateway.peerCount() === 0 && stopTeleop()) {
          console.warn("[Server] 远程 Leader 控制连接持续断开，已自动停止遥操作");
        }
      }, 3000);
      controlDisconnectTimer.unref();
    }
  });
});

streamWss.on("connection", (ws) => {
  console.log("[Server] 新推流客户端连接");
  streamClients.add(ws);
  ws.on("close", () => streamClients.delete(ws));
});

function broadcastControl(msg: BridgeMessage | object): void {
  const data = JSON.stringify(msg);
  rtcGateway.broadcastControl(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// 二进制推流帧格式: [1 字节类型][8 字节 timestamp(float64, 秒)][JPEG 字节]。
// 避免 base64 + JSON 包装：既减少 ~33% 体积，也省去客户端 JSON.parse/base64 解码开销。
const STREAM_TYPE_CAMERA = 1;
const STREAM_TYPE_CAMERA2 = 2;

function broadcastBinaryFrame(streamType: number, ts: number, jpeg: Buffer): void {
  const header = Buffer.alloc(9);
  header.writeUInt8(streamType, 0);
  header.writeDoubleLE(ts, 1);
  const frame = Buffer.concat([header, jpeg]);
  rtcGateway.broadcastFrame(frame);
  for (const client of streamClients) {
    if (client.readyState === WebSocket.OPEN) {
      // 推流只保留最新帧；慢客户端直接丢弃，绝不形成积压。
      if (client.bufferedAmount > 128 * 1024) continue;
      client.send(frame);
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

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[Robot Server] 退出中...");
  if (bridge) bridge.stop();
  void rtcGateway.close();
  if (cameraBridge) cameraBridge.stop();
  if (cameraBridge2) cameraBridge2.stop();
  if (recorder) recorder.stop();
  for (const child of trainingProcesses.values()) child.kill("SIGTERM");
  for (const child of evaluationProcesses.values()) child.kill("SIGTERM");
  if (controlDisconnectTimer) clearTimeout(controlDisconnectTimer);
  for (const client of clients) client.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
