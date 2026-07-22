import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

export interface BridgeMessage {
  type: string;
  joints?: Record<string, number>;
  data?: string;
  ts?: number;
  [key: string]: unknown;
}

/**
 * RobotBridge - 管理 Python 桥接子进程
 * 通过 stdio JSON 与 Python 进程通信
 */
export class RobotBridge extends EventEmitter {
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
    console.log(`[RobotBridge] 启动 Python 桥接: ${this.pythonPath} ${this.bridgePath} ${this.args.join(" ")}`);

    this.process = spawn(this.pythonPath, [this.bridgePath, ...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      // 最后一个元素可能是不完整的行，保留在 buffer 中
      this.buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg: BridgeMessage = JSON.parse(line);
            this.emit("message", msg);
          } catch {
            // 非 JSON 行，当作日志输出
            console.log(`[Python] ${line.trim()}`);
          }
        }
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      console.log(`[Python stderr] ${data.toString().trim()}`);
    });

    this.process.on("exit", (code) => {
      console.log(`[RobotBridge] Python 进程退出, code=${code}`);
      this.emit("exit", code);
    });

    this.process.on("error", (err) => {
      console.error(`[RobotBridge] Python 进程错误:`, err);
      this.emit("error", err);
    });
  }

  send(msg: BridgeMessage): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(msg) + "\n");
    }
  }

  stop(): void {
    const child = this.process;
    if (!child || child.exitCode !== null) return;

    child.kill("SIGTERM");
    // MuJoCo/串口驱动偶尔会阻塞在原生调用中；超过 2 秒仍未退出则强制回收。
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2000).unref();
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }
}
