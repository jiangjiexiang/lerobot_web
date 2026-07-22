import WebSocket from "ws";
import { EventEmitter } from "events";

export interface RemoteMessage {
  type: string;
  joints?: Record<string, number>;
  ts?: number;
  [key: string]: unknown;
}

/**
 * RemoteClient - WebSocket 客户端，连接机器人电脑
 * 接收 follower 状态，发送 leader 控制指令
 */
export class RemoteClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectInterval = 3000;

  constructor(remoteHost: string, remotePort: number = 3000) {
    super();
    this.url = `ws://${remoteHost}:${remotePort}/ws`;
  }

  connect(): void {
    console.log(`[RemoteClient] 连接机器人电脑: ${this.url}`);

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on("open", () => {
        console.log("[RemoteClient] 已连接到机器人电脑");
        this.emit("connected");
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      });

      this.ws.on("message", (data) => {
        try {
          const msg: RemoteMessage = JSON.parse(data.toString());
          this.emit("message", msg);
        } catch (err) {
          console.error("[RemoteClient] 解析消息失败:", err);
        }
      });

      this.ws.on("close", () => {
        console.log("[RemoteClient] 与机器人电脑断开连接");
        this.emit("disconnected");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        console.error("[RemoteClient] WebSocket 错误:", err.message);
        this.emit("error", err);
      });
    } catch (err) {
      console.error("[RemoteClient] 连接失败:", err);
      this.scheduleReconnect();
    }
  }

  /**
   * 发送 leader 控制指令到机器人电脑
   */
  sendAction(joints: Record<string, number>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({ type: "action", joints });
      this.ws.send(msg);
    }
  }

  private scheduleReconnect(): void {
    if (!this.reconnectTimer) {
      console.log(`[RemoteClient] ${this.reconnectInterval / 1000}秒后尝试重连...`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectInterval);
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
