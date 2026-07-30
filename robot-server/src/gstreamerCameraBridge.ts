import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";

const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

export class JpegStreamParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (true) {
      const start = this.buffer.indexOf(JPEG_START);
      if (start < 0) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1));
        break;
      }
      const end = this.buffer.indexOf(JPEG_END, start + JPEG_START.length);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        break;
      }
      const frameEnd = end + JPEG_END.length;
      frames.push(this.buffer.subarray(start, frameEnd));
      this.buffer = this.buffer.subarray(frameEnd);
    }
    return frames;
  }
}

export interface CameraBridgeMessage {
  type: "camera_frame" | "camera_ready" | "camera_status" | "camera_error";
  data?: Buffer;
  ts?: number;
  camera_index?: number;
  width?: number;
  height?: number;
  fps?: number;
  measured_fps?: number;
  frames_dropped?: number;
  reconnects?: number;
  error?: string;
  recovering?: boolean;
  fourcc?: string;
}

export class GStreamerCameraBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private parser = new JpegStreamParser();
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private framesSinceStatus = 0;
  private statusStartedAt = 0;
  private reconnects = 0;
  private ready = false;
  private lastError = "";

  constructor(
    private readonly cameraIndex: number,
    private readonly width: number,
    private readonly height: number,
    private readonly fps: number,
  ) {
    super();
  }

  start(): void {
    if (this.process || this.reconnectTimer) return;
    this.stopping = false;
    this.startPipeline();
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.reconnectTimer = null;
    this.statusTimer = null;
    const child = this.process;
    this.process = null;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  private startPipeline(): void {
    this.parser = new JpegStreamParser();
    this.ready = false;
    this.framesSinceStatus = 0;
    this.statusStartedAt = Date.now();
    const device = `/dev/video${this.cameraIndex}`;
    const args = [
      "-q",
      "v4l2src", `device=${device}`, "io-mode=mmap", "do-timestamp=true",
      "!", `image/jpeg,width=${this.width},height=${this.height},framerate=${this.fps}/1`,
      "!", "queue", "leaky=downstream", "max-size-buffers=1", "max-size-bytes=0", "max-size-time=0",
      "!", "fdsink", "fd=1", "sync=false",
    ];
    const child = spawn("gst-launch-1.0", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.process = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      for (const frame of this.parser.push(chunk)) {
        const now = Date.now();
        this.framesSinceStatus += 1;
        if (!this.ready) {
          this.ready = true;
          this.lastError = "";
          this.emitMessage({
            type: "camera_ready",
            camera_index: this.cameraIndex,
            width: this.width,
            height: this.height,
            fps: this.fps,
            fourcc: "MJPG-direct",
            reconnects: this.reconnects,
          });
        }
        this.emitMessage({ type: "camera_frame", data: frame, ts: now / 1000 });
      }
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.on("error", (error) => this.handleExit(child, error.message));
    child.on("exit", (code) => this.handleExit(child, stderr.trim() || `GStreamer exited with code ${code}`));

    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => {
      const elapsedSeconds = Math.max(0.001, (Date.now() - this.statusStartedAt) / 1000);
      this.emitMessage({
        type: "camera_status",
        camera_index: this.cameraIndex,
        measured_fps: this.framesSinceStatus / elapsedSeconds,
        frames_dropped: 0,
        reconnects: this.reconnects,
      });
      this.framesSinceStatus = 0;
      this.statusStartedAt = Date.now();
    }, 2000);
    this.statusTimer.unref();
  }

  private handleExit(child: ChildProcess, reason: string): void {
    if (this.process !== child) return;
    this.process = null;
    if (this.stopping || this.reconnectTimer) return;
    this.reconnects += 1;
    const error = `${reason || "摄像头管线退出"}，1 秒后重连`;
    if (error !== this.lastError) {
      this.lastError = error;
      this.emitMessage({
        type: "camera_error",
        camera_index: this.cameraIndex,
        error,
        recovering: true,
      });
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) this.startPipeline();
    }, 1000);
  }

  private emitMessage(message: CameraBridgeMessage): void {
    this.emit("message", message);
  }
}
