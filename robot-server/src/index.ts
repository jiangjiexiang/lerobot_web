import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import cors from "cors";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { execSync, execFile, spawn, ChildProcess } from "child_process";
import { RobotBridge, BridgeMessage } from "./robotBridge";
import { MJPEGStreamManager } from "./streams";

// 配置
const PORT = parseInt(process.env.PORT || "43127");
const BRIDGE_DIR = process.env.BRIDGE_DIR || path.join(__dirname, "../../bridge");
const TELEOP_SCRIPT = path.join(BRIDGE_DIR, "teleop_mujoco.py");
const CAMERA_SCRIPT = path.join(BRIDGE_DIR, "camera_stream.py");
const RECORDER_SCRIPT = path.join(BRIDGE_DIR, "dataset_recorder.py");
const DATASET_CATALOG_SCRIPT = path.join(BRIDGE_DIR, "dataset_catalog.py");
const PYTHON_PATH = process.env.PYTHON_PATH || "python3";
const FRONTEND_DIST = path.join(__dirname, "../../frontend/dist");
const DATASET_ROOT = path.resolve(process.env.DATASET_ROOT || path.join(process.env.HOME || "/tmp", "lerobot_datasets"));
const ENABLE_CAMERA = process.env.ENABLE_CAMERA !== "0" && process.env.ENABLE_CAMERA !== "false";
const CAMERA_FPS = parseInt(process.env.CAMERA_FPS || "30", 10);
const CAMERA_WIDTH = parseInt(process.env.CAMERA_WIDTH || "640", 10);
const CAMERA_HEIGHT = parseInt(process.env.CAMERA_HEIGHT || "360", 10);
const DEFAULT_STREAM_FPS = parseInt(process.env.STREAM_FPS || "0", 10);
const TRAINING_ROOT = path.join(DATASET_ROOT, ".lerobot-web", "training");

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
let controlDisconnectTimer: NodeJS.Timeout | null = null;

function stopTeleop(): boolean {
  if (!bridge || !bridge.isRunning()) return false;
  requestRecordingSave();
  stopping = true;
  bridge.stop();
  broadcastControl({ type: "status", running: false });
  return true;
}

// 摄像头是可选资源：默认关闭，避免服务启动时常驻 OpenCV 进程并占用 USB 摄像头。
let cameraBridge: RobotBridge | null = null;
let activeCameraIndex = -1;
let cameraLastFrameAt = 0;
let cameraError: string | null = null;
let latestCameraFrame: Buffer | null = null;
function startCamera(index: number): void {
  if (!ENABLE_CAMERA || index < 0) return;
  if (cameraBridge) cameraBridge.stop();
  activeCameraIndex = index;
  cameraLastFrameAt = 0;
  cameraError = null;
  cameraBridge = new RobotBridge(CAMERA_SCRIPT, ["--camera-index", String(index), "--fps", String(CAMERA_FPS), "--width", String(CAMERA_WIDTH), "--height", String(CAMERA_HEIGHT)], PYTHON_PATH);
  cameraBridge.on("message", (msg: BridgeMessage) => {
    if (msg.type === "camera_frame" && msg.data) {
      cameraLastFrameAt = Date.now();
      const jpeg = Buffer.from(msg.data, "base64");
      latestCameraFrame = jpeg;
      streamManager.updateFrame("camera", jpeg);
      broadcastBinaryFrame(STREAM_TYPE_CAMERA, typeof msg.ts === "number" ? msg.ts : Date.now() / 1000, jpeg);
    } else if (msg.type === "camera_error") {
      cameraError = String(msg.error || "摄像头不可用");
      console.error(`[Camera] ${cameraError}`);
    }
  });
  cameraBridge.start();
  console.log(`[Camera] 已启用 /dev/video${index} (${CAMERA_FPS} FPS)`);
}

// 第二个摄像头（可选）
let cameraBridge2: RobotBridge | null = null;
let activeCameraIndex2 = -1;
let camera2LastFrameAt = 0;
let camera2Error: string | null = null;
let latestCamera2Frame: Buffer | null = null;
function startCamera2(index: number): void {
  if (!ENABLE_CAMERA || index < 0) return;
  if (cameraBridge2) cameraBridge2.stop();
  activeCameraIndex2 = index;
  camera2LastFrameAt = 0;
  camera2Error = null;
  cameraBridge2 = new RobotBridge(CAMERA_SCRIPT, ["--camera-index", String(index), "--fps", String(CAMERA_FPS), "--width", String(CAMERA_WIDTH), "--height", String(CAMERA_HEIGHT)], PYTHON_PATH);
  cameraBridge2.on("message", (msg: BridgeMessage) => {
    if (msg.type === "camera_frame" && msg.data) {
      camera2LastFrameAt = Date.now();
      const jpeg = Buffer.from(msg.data, "base64");
      latestCamera2Frame = jpeg;
      streamManager.updateFrame("camera2", jpeg);
      broadcastBinaryFrame(STREAM_TYPE_CAMERA2, typeof msg.ts === "number" ? msg.ts : Date.now() / 1000, jpeg);
    } else if (msg.type === "camera_error") {
      camera2Error = String(msg.error || "摄像头不可用");
      console.error(`[Camera2] ${camera2Error}`);
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

function runDatasetCatalog(command: "list" | "detail", dataset?: string): Promise<Record<string, unknown>> {
  const args = [DATASET_CATALOG_SCRIPT, command, "--root", DATASET_ROOT];
  if (dataset) args.push("--dataset", dataset);
  return new Promise((resolve, reject) => {
    execFile(PYTHON_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim().split("\n").pop() || error.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("数据目录返回了无效响应"));
      }
    });
  });
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

interface PreflightCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

const trainingProcesses = new Map<string, ChildProcess>();

function trainingJobsFile(): string {
  return path.join(TRAINING_ROOT, "jobs.json");
}

function modelRegistryFile(): string {
  return path.join(TRAINING_ROOT, "models.json");
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

async function trainingPreflight(job: TrainingJob): Promise<{ ready: boolean; checks: PreflightCheck[]; checkedAt: string }> {
  const checks: PreflightCheck[] = [];
  const datasetRoot = datasetPath(job.dataset);
  const collectionPath = path.join(collectionsDirectory(datasetRoot), `${job.collection}.json`);
  const datasetReady = fs.existsSync(datasetRoot) && fs.existsSync(collectionPath);
  checks.push({ id: "dataset", label: "训练数据", status: datasetReady ? "pass" : "fail", detail: datasetReady ? `${job.episodes.length} 个已发布 Episode 可用` : "数据集或训练选集已不存在" });

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

  const resources = resourceSample() as { diskFreeGb: number; memoryUsedGb: number };
  const memoryFreeGb = (os.totalmem() - os.freemem()) / 1024 ** 3;
  checks.push({ id: "disk", label: "磁盘空间", status: resources.diskFreeGb >= 5 ? "pass" : resources.diskFreeGb >= 2 ? "warning" : "fail", detail: `可用 ${resources.diskFreeGb} GB，建议至少保留 5 GB` });
  checks.push({ id: "memory", label: "可用内存", status: memoryFreeGb >= 2 ? "pass" : memoryFreeGb >= 1 ? "warning" : "fail", detail: `可用 ${memoryFreeGb.toFixed(1)} GB` });
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
  if (trainingProcesses.size > 0) throw new Error("已有训练任务正在运行");
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

function recordObservation(message: BridgeMessage): void {
  if (recordingStatus.state !== "recording" || !recorder?.isRunning() || recorderFramePending) return;
  const now = Date.now();
  if (now < nextRecorderFrameAt || !latestCameraFrame || !latestCamera2Frame) return;
  if (now - cameraLastFrameAt > 1500 || now - camera2LastFrameAt > 1500) return;
  if (!message.leader || !message.follower) return;

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

app.get("/api/datasets", async (req, res) => {
  try {
    res.json({ ok: true, ...await runDatasetCatalog("list") });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/datasets/:dataset", async (req, res) => {
  const dataset = cleanDatasetName(req.params.dataset);
  if (!dataset) {
    res.status(400).json({ ok: false, error: "无效的数据集名称" });
    return;
  }
  try {
    const detail = await runDatasetCatalog("detail", dataset);
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
  res.json({ ok: true, models: readRegisteredModels() });
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
  if (!latestCameraFrame || !latestCamera2Frame || now - cameraLastFrameAt > 1500 || now - camera2LastFrameAt > 1500) {
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
  ], PYTHON_PATH);
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
  let acmPorts: string[] = [];
  try {
    acmPorts = fs.readdirSync("/dev")
      .filter((name) => /^ttyACM\d+$/.test(name))
      .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
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

  const cameraStatus = (index: number, child: RobotBridge | null, lastFrameAt: number, error: string | null) => ({
    index,
    detected: index >= 0 && detected.includes(index),
    processRunning: Boolean(child?.isRunning()),
    frameFresh: lastFrameAt > 0 && now - lastFrameAt < 2000,
    lastFrameAgeMs: lastFrameAt > 0 ? now - lastFrameAt : null,
    error,
  });

  res.json({
    checkedAt: new Date(now).toISOString(),
    server: { ok: true, running: bridge ? bridge.isRunning() && !stopping : false },
    follower: {
      ports: acmPorts,
      portPresent: acmPorts.length > 0,
      id: followerId,
      calibrationValid,
    },
    camerasDetected: detected,
    cameras: [
      cameraStatus(activeCameraIndex, cameraBridge, cameraLastFrameAt, cameraError),
      cameraStatus(activeCameraIndex2, cameraBridge2, camera2LastFrameAt, camera2Error),
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

  if (typeof follower_port !== "string" || !follower_port.startsWith("/dev/tty")) {
    res.status(400).json({ ok: false, error: "Follower 串口无效" });
    return;
  }
  if (typeof follower_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(follower_id)) {
    res.status(400).json({ ok: false, error: "Follower ID 无效" });
    return;
  }
  if (!remote_leader && (typeof leader_port !== "string" || !leader_port.startsWith("/dev/tty"))) {
    res.status(400).json({ ok: false, error: "Leader 串口无效" });
    return;
  }
  if (!remote_leader && (typeof leader_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(leader_id))) {
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
    "--stream-fps", String(stream_fps),
  ];
  if (viewer) args.push("--viewer");
  if (remote_leader) args.push("--remote-leader");

  console.log(`[Server] 启动遥操作: ${PYTHON_PATH} ${TELEOP_SCRIPT} ${args.join(" ")}`);

  const startedBridge = new RobotBridge(TELEOP_SCRIPT, args, PYTHON_PATH);
  bridge = startedBridge;
  stopping = false;
  remoteLeaderActive = Boolean(remote_leader);
  latestObservation = null;

  startedBridge.on("message", (msg: BridgeMessage) => {
    switch (msg.type) {
      case "teleop_observation":
        latestObservation = msg;
        recordObservation(msg);
        broadcastControl(msg);
        break;

      case "camera_frame":
        if (msg.data) {
          const jpeg = Buffer.from(msg.data, "base64");
          streamManager.updateFrame("camera", jpeg);
          broadcastBinaryFrame(STREAM_TYPE_CAMERA, typeof msg.ts === "number" ? msg.ts : Date.now() / 1000, jpeg);
        }
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
  });
});

// 切换摄像头
app.post("/api/camera/switch", (req, res) => {
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
    if (remoteLeaderActive && clients.size === 0 && !controlDisconnectTimer) {
      // 页面刷新和 Wi-Fi 瞬断会很快重连；给短暂宽限期，持续断开才安全停机。
      controlDisconnectTimer = setTimeout(() => {
        controlDisconnectTimer = null;
        if (remoteLeaderActive && clients.size === 0 && stopTeleop()) {
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

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[Robot Server] 退出中...");
  if (bridge) bridge.stop();
  if (cameraBridge) cameraBridge.stop();
  if (cameraBridge2) cameraBridge2.stop();
  if (recorder) recorder.stop();
  if (controlDisconnectTimer) clearTimeout(controlDisconnectTimer);
  for (const client of clients) client.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
