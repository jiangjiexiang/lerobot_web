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
  private stderrTail: string[] = [];
  private stderrBuffer = "";
  private readonly maxLogLength = 1000;

  constructor(bridgePath: string, args: string[], pythonPath: string = "python3") {
    super();
    this.bridgePath = bridgePath;
    this.args = args;
    this.pythonPath = pythonPath;
  }

  start(): void {
    this.writeLog("info", `启动 Python 桥接: ${this.pythonPath} ${this.bridgePath} ${this.args.join(" ")}`);

    this.process = spawn(this.pythonPath, [this.bridgePath, ...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Python 初始化失败或退出后，网页仍可能短暂发送动作。监听 stdin 错误，
    // 防止 EPIPE 作为未处理错误杀死整个 robot-server。
    this.process.stdin?.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
        console.error(`[RobotBridge] stdin 错误:`, err.message);
      }
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
            this.writeLog("warn", `忽略无法解析的 Python 输出: ${this.sanitizeLog(line)}`);
          }
        }
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.stderrBuffer += data.toString();
      const lines = this.stderrBuffer.split(/\r?\n/);
      this.stderrBuffer = lines.pop() || "";
      for (const line of lines) this.handleStderrLine(line);
    });

    this.process.on("exit", (code) => {
      if (this.stderrBuffer.trim()) this.handleStderrLine(this.stderrBuffer);
      this.stderrBuffer = "";
      this.writeLog(code === 0 ? "info" : "error", `Python 进程退出 (code=${code})`);
      this.emit("exit", code, code && code !== 0 ? this.lastErrorLine() : null);
    });

    this.process.on("error", (err) => {
      console.error(`[RobotBridge] Python 进程错误:`, err);
      this.emit("error", err);
    });
  }

  send(msg: BridgeMessage): void {
    const child = this.process;
    const stdin = child?.stdin;
    if (!child || child.exitCode !== null || !stdin?.writable || stdin.destroyed) return;
    try {
      stdin.write(JSON.stringify(msg) + "\n", (err) => {
        if (err && (err as NodeJS.ErrnoException).code !== "EPIPE") {
          console.error(`[RobotBridge] 动作写入失败:`, err.message);
        }
      });
    } catch (err) {
      // 子进程退出和网页动作之间存在竞争条件；忽略该动作，等待状态广播。
      if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
        console.error(`[RobotBridge] 动作写入异常:`, err);
      }
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

  // Python Traceback 的最后一行通常是 "XxxError: 具体原因"，优先取这一行；
  // 找不到则退化为 stderr 最后一行非空文本。
  private lastErrorLine(): string | null {
    const errorLine = [...this.stderrTail].reverse().find((line) => /Error[:\s]/.test(line));
    if (errorLine) return errorLine.trim();
    return this.stderrTail.length > 0 ? this.stderrTail[this.stderrTail.length - 1].trim() : null;
  }

  private sanitizeLog(value: string): string {
    const text = value.trim();
    if (text.length <= this.maxLogLength) return text;
    return `${text.slice(0, this.maxLogLength)}… [已截断 ${text.length - this.maxLogLength} 字符]`;
  }

  private handleStderrLine(line: string): void {
    const message = this.sanitizeLog(line);
    if (!message) return;
    // 保留最后若干行，用于进程异常退出时向前端展示 Python 报错原因。
    this.stderrTail.push(message);
    if (this.stderrTail.length > 20) this.stderrTail = this.stderrTail.slice(-20);
    if (!this.shouldSuppressStderr(message)) {
      this.writeLog(this.classifyStderr(message), message);
    }
  }

  private shouldSuppressStderr(message: string): boolean {
    return (
      /^\[libx264\b/.test(message)
      || /^\[Teleop\] 已运行 \d+ 帧$/.test(message)
      || /^frame=\s*\d+/.test(message)
    );
  }

  private classifyStderr(message: string): "info" | "warn" | "error" {
    if (
      /^\[Teleop\] 收到信号 \d+/.test(message)
      || /^\[Teleop\]/.test(message)
      || /^\[(?:INFO|DEBUG)\]/i.test(message)
    ) return "info";
    if (/warning|warn|警告/i.test(message)) return "warn";
    if (/traceback|exception|\berror\b|failed|失败|异常/i.test(message)) return "error";
    return "info";
  }

  private writeLog(level: "info" | "warn" | "error", message: string): void {
    const prefix = "[RobotBridge]";
    const output = `${prefix} ${message}`;
    if (level === "error") console.error(output);
    else if (level === "warn") console.warn(output);
    else console.log(output);
    this.emit("log", { level, message });
  }
}
