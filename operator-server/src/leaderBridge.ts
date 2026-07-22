import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

export interface LeaderMessage {
  type: string;
  joints?: Record<string, number>;
  ts?: number;
  [key: string]: unknown;
}

/**
 * LeaderBridge - 管理本地 leader Python 桥接子进程
 * 通过 stdio JSON 读取 leader 关节角度
 */
export class LeaderBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private bridgePath: string;
  private args: string[];
  private pythonPath: string;

  constructor(bridgePath: string, args: string[], pythonPath: string = "python3") {
    super();
    this.bridgePath = bridgePath;
    this.args = args;
    this.pythonPath = pythonPath;
  }

  start(): void {
    console.log(`[LeaderBridge] 启动 Python 桥接: ${this.pythonPath} ${this.bridgePath} ${this.args.join(" ")}`);

    this.process = spawn(this.pythonPath, [this.bridgePath, ...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg: LeaderMessage = JSON.parse(line);
            this.emit("message", msg);
          } catch {
            console.log(`[Leader Python] ${line.trim()}`);
          }
        }
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      console.log(`[Leader Python stderr] ${data.toString().trim()}`);
    });

    this.process.on("exit", (code) => {
      console.log(`[LeaderBridge] Python 进程退出, code=${code}`);
      this.emit("exit", code);
    });

    this.process.on("error", (err) => {
      console.error(`[LeaderBridge] Python 进程错误:`, err);
      this.emit("error", err);
    });
  }

  stop(): void {
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }
}
