import crypto from "crypto";
import { RTCPeerConnection, RTCDataChannel } from "@roamhq/wrtc";

interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

interface RtcPeer {
  id: string;
  pc: RTCPeerConnection;
  channels: Map<string, RTCDataChannel>;
  lastSequence: number;
  lastControlAt: number;
  closed: boolean;
}

export interface RtcGatewayOptions {
  enabled: boolean;
  iceServers?: IceServer[];
  controlTimeoutMs?: number;
  onControl: (message: Record<string, unknown>) => void;
  onSafetyStop: () => void;
  onControlLost: () => void;
}

/**
 * WebRTC transport for low-latency control/state/JPEG delivery.
 *
 * Media remains transport-independent: the binary video channel carries the
 * same latest-frame-only payload as the WebSocket fallback. A future RTP/H264
 * gateway can replace that channel without touching the ROS control boundary.
 */
export class RtcGateway {
  private readonly peers = new Map<string, RtcPeer>();
  private readonly enabled: boolean;
  private readonly iceServers: IceServer[];
  private readonly controlTimeoutMs: number;
  private readonly onControl: RtcGatewayOptions["onControl"];
  private readonly onSafetyStop: RtcGatewayOptions["onSafetyStop"];
  private readonly onControlLost: RtcGatewayOptions["onControlLost"];
  private controlOwner: string | null = null;
  private watchdog: NodeJS.Timeout;

  constructor(options: RtcGatewayOptions) {
    this.enabled = options.enabled;
    this.iceServers = options.iceServers || [];
    this.controlTimeoutMs = options.controlTimeoutMs || 750;
    this.onControl = options.onControl;
    this.onSafetyStop = options.onSafetyStop;
    this.onControlLost = options.onControlLost;
    this.watchdog = setInterval(() => this.checkWatchdog(), 100);
    this.watchdog.unref();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  peerCount(): number {
    return this.peers.size;
  }

  async acceptOffer(offer: { type: "offer"; sdp: string }): Promise<{ type: "answer"; sdp: string }> {
    if (!this.enabled) throw new Error("WebRTC 未启用");
    if (offer?.type !== "offer" || typeof offer.sdp !== "string" || offer.sdp.length > 1_000_000) {
      throw new Error("无效的 WebRTC offer");
    }

    const peer: RtcPeer = {
      id: crypto.randomUUID(),
      pc: new RTCPeerConnection({ iceServers: this.iceServers }),
      channels: new Map(),
      lastSequence: -1,
      lastControlAt: 0,
      closed: false,
    };
    this.peers.set(peer.id, peer);
    peer.pc.ondatachannel = (event: { channel: RTCDataChannel }) => this.attachChannel(peer, event.channel);
    peer.pc.onconnectionstatechange = () => {
      const state = peer.pc.connectionState;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        this.removePeer(peer);
      }
    };

    try {
      await peer.pc.setRemoteDescription(offer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await this.waitForIceGathering(peer.pc);
      const local = peer.pc.localDescription;
      if (!local) throw new Error("WebRTC answer 创建失败");
      if (local.type !== "answer") throw new Error("WebRTC 返回了非 answer 描述");
      return { type: "answer", sdp: local.sdp };
    } catch (error) {
      await this.removePeer(peer);
      throw error;
    }
  }

  broadcastControl(message: object): void {
    const data = JSON.stringify(message);
    for (const peer of this.peers.values()) {
      this.send(peer.channels.get("robot-state-v1"), data, 256 * 1024);
    }
  }

  broadcastFrame(frame: Buffer): void {
    for (const peer of this.peers.values()) {
      // A slow viewer never builds a frame queue; the next fresh frame wins.
      this.send(peer.channels.get("robot-video-v1"), frame, 256 * 1024);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.watchdog);
    const peers = [...this.peers.values()];
    this.peers.clear();
    this.controlOwner = null;
    for (const peer of peers) peer.pc.close();
  }

  private attachChannel(peer: RtcPeer, channel: RTCDataChannel): void {
    if (!["robot-control-v1", "robot-state-v1", "robot-video-v1", "robot-safety-v1"].includes(channel.label)) {
      channel.close();
      return;
    }
    peer.channels.set(channel.label, channel);
    channel.onmessage = (event: { data: unknown }) => {
      if (channel.label === "robot-control-v1") this.handleControl(peer, event.data);
      if (channel.label === "robot-safety-v1") this.handleSafety(peer, event.data);
    };
    channel.onclose = () => {
      peer.channels.delete(channel.label);
      if (channel.label === "robot-control-v1" && this.controlOwner === peer.id) {
        this.releaseControl(peer, true);
      }
    };
  }

  private handleControl(peer: RtcPeer, data: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(this.messageText(data));
    } catch {
      return;
    }
    if (message.type !== "action" || typeof message.joints !== "object" || message.joints === null) return;
    const sequence = typeof message.seq === "number" ? message.seq : peer.lastSequence + 1;
    if (!Number.isSafeInteger(sequence) || sequence <= peer.lastSequence) return;
    if (this.controlOwner !== null && this.controlOwner !== peer.id) return;
    this.controlOwner = peer.id;
    peer.lastSequence = sequence;
    peer.lastControlAt = Date.now();
    this.onControl(message);
  }

  private handleSafety(peer: RtcPeer, data: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(this.messageText(data));
    } catch {
      return;
    }
    if (message.type === "heartbeat" && this.controlOwner === peer.id) {
      peer.lastControlAt = Date.now();
    } else if (message.type === "stop" && this.controlOwner === peer.id) {
      this.onSafetyStop();
      this.releaseControl(peer, false);
    }
  }

  private checkWatchdog(): void {
    if (!this.controlOwner) return;
    const peer = this.peers.get(this.controlOwner);
    if (!peer || Date.now() - peer.lastControlAt > this.controlTimeoutMs) {
      if (peer) this.releaseControl(peer, true);
      else {
        this.controlOwner = null;
        this.onControlLost();
      }
    }
  }

  private releaseControl(peer: RtcPeer, notifyLoss: boolean): void {
    if (this.controlOwner !== peer.id) return;
    this.controlOwner = null;
    peer.lastControlAt = 0;
    if (notifyLoss) this.onControlLost();
  }

  private async removePeer(peer: RtcPeer): Promise<void> {
    if (peer.closed) return;
    peer.closed = true;
    this.peers.delete(peer.id);
    this.releaseControl(peer, true);
    peer.pc.close();
  }

  private send(channel: RTCDataChannel | undefined, data: string | Buffer, highWaterMark: number): void {
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > highWaterMark) return;
    try {
      channel.send(data);
    } catch {
      // Connection-state callbacks own cleanup; a racing close drops this sample.
    }
  }

  private messageText(data: unknown): string {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf-8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
    }
    throw new Error("unsupported DataChannel message");
  }

  private waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      const listener = () => {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(timeout);
          peer.removeEventListener("icegatheringstatechange", listener);
          resolve();
        }
      };
      peer.addEventListener("icegatheringstatechange", listener);
    });
  }
}
