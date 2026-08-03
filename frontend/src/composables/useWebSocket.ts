import { ref, onMounted, onUnmounted } from "vue";

// ROS 2 drivers may expose different joint sets. The SO-101 Web Serial adapter
// still emits its six canonical names, while the status UI accepts any driver.
export type JointData = Record<string, number>;

export interface WSMessage {
  type: string;
  leader?: JointData;
  follower?: JointData;
  running?: boolean;
  data?: string;
  ts?: number;
  error?: string | null;
  [key: string]: unknown;
}

export interface DebugMetrics {
  controlFps: number;
  controlLatency: number | null;
  cameraFps: number;
  cameraLatency: number | null;
  cameraDropped: number;
  camera2Fps: number;
  camera2Latency: number | null;
  camera2Dropped: number;
  streamConnected: boolean;
  rtcConnected: boolean;
}

export interface RecordingStatus {
  state: "idle" | "preparing" | "recording" | "saving" | "error";
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

export function useWebSocket() {
  const connected = ref(false);
  const running = ref(false);
  const leaderJoints = ref<JointData | null>(null);
  const followerJoints = ref<JointData | null>(null);
  const cameraFrame = ref<string | null>(null);
  const camera2Frame = ref<string | null>(null);
  const cameraStream = ref<MediaStream | null>(null);
  const camera2Stream = ref<MediaStream | null>(null);
  const logs = ref<string[]>([]);
  const fatalError = ref<string | null>(null);
  const recording = ref<RecordingStatus>({
    state: "idle", dataset: null, task: null, fps: 30, frames: 0,
    episode: null, path: null, error: null, plannedEpisodes: 10, episodeTime: 20, resetTime: 5, resume: false,
  });
  const metrics = ref<DebugMetrics>({
    controlFps: 0, controlLatency: null,
    cameraFps: 0, cameraLatency: null, cameraDropped: 0,
    camera2Fps: 0, camera2Latency: null, camera2Dropped: 0,
    streamConnected: false, rtcConnected: false,
  });

  let ws: WebSocket | null = null;
  let streamWs: WebSocket | null = null;
  let rtcPeer: RTCPeerConnection | null = null;
  let rtcControl: RTCDataChannel | null = null;
  let rtcState: RTCDataChannel | null = null;
  let rtcSafety: RTCDataChannel | null = null;
  let rtcStateOpen = false;
  let rtcVideoOpen = false;
  let rtcSequence = 0;
  const controlSentAt = new Map<number, number>();
  let reconnectTimer: number | null = null;
  let streamReconnectTimer: number | null = null;
  let rtcReconnectTimer: number | null = null;
  let rtcDisconnectTimer: number | null = null;
  let frameAnimation: number | null = null;
  let pendingCameraFrame: Blob | null = null;
  let pendingCamera2Frame: Blob | null = null;
  let pendingCameraTs: number | undefined;
  let pendingCamera2Ts: number | undefined;
  let cameraFrameUrl: string | null = null;
  let camera2FrameUrl: string | null = null;
  let metricsTimer: number | null = null;
  let controlFrames = 0;
  let cameraFrames = 0;
  let camera2Frames = 0;
  let cameraDropped = 0;
  let camera2Dropped = 0;
  let disposed = false;
  let pingTimer: number | null = null;
  let rtcHeartbeatTimer: number | null = null;
  let lastLogMessage = "";
  let lastLogAt = 0;
  // 机器人上位机时钟与浏览器时钟不同步（无 NTP），直接用两台设备的时间戳相减会得到
  // 无意义甚至负数的延迟，被 Math.max(0, ...) 钳制后就一直显示 0ms。
  // 用控制 WebSocket 做一次简易 NTP 式估算：clockOffset = 机器人时钟 - 浏览器时钟。
  let clockOffset = 0;

  function sendPing() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  }

  function handlePong(msg: WSMessage) {
    const clientTs = msg.clientTs as number | undefined;
    const serverTs = msg.serverTs as number | undefined;
    if (typeof clientTs !== "number" || typeof serverTs !== "number") return;
    const rtt = Date.now() - clientTs;
    // 假设上下行延迟对称，服务端处理时刻约为 clientTs + rtt/2。
    clockOffset = serverTs - (clientTs + rtt / 2);
  }

  function latency(ts?: number): number | null {
    if (typeof ts !== "number") return null;
    const robotNow = Date.now() + clockOffset;
    return Math.max(0, Math.round(robotNow - ts * 1000));
  }

  function reportLatencyMetrics(current: DebugMetrics) {
    if (current.controlLatency === null && current.cameraLatency === null && current.camera2Latency === null) return;
    void fetch("/api/logs/latency", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        controlLatencyMs: current.controlLatency,
        cameraLatencyMs: current.cameraLatency,
        camera2LatencyMs: current.camera2Latency,
        controlFps: current.controlFps,
        cameraFps: current.cameraFps,
        camera2Fps: current.camera2Fps,
      }),
    }).catch(() => undefined);
  }

  function updateMetrics() {
    const updated = {
      ...metrics.value,
      controlFps: controlFrames,
      cameraFps: cameraFrames,
      cameraDropped,
      camera2Fps: camera2Frames,
      camera2Dropped,
    };
    metrics.value = updated;
    reportLatencyMetrics(updated);
    controlFrames = cameraFrames = camera2Frames = 0;
    cameraDropped = camera2Dropped = 0;
  }

  function scheduleFrames() {
    if (frameAnimation !== null) return;
    frameAnimation = requestAnimationFrame(() => {
      frameAnimation = null;
      if (pendingCameraFrame !== null) {
        const url = URL.createObjectURL(pendingCameraFrame);
        if (cameraFrameUrl) URL.revokeObjectURL(cameraFrameUrl);
        cameraFrameUrl = url;
        cameraFrame.value = url;
        metrics.value.cameraLatency = latency(pendingCameraTs);
        pendingCameraFrame = null;
      }
      if (pendingCamera2Frame !== null) {
        const url = URL.createObjectURL(pendingCamera2Frame);
        if (camera2FrameUrl) URL.revokeObjectURL(camera2FrameUrl);
        camera2FrameUrl = url;
        camera2Frame.value = url;
        metrics.value.camera2Latency = latency(pendingCamera2Ts);
        pendingCamera2Frame = null;
      }
    });
  }

  function handleBinaryFrame(buffer: ArrayBuffer) {
    // 帧格式: [1 字节类型][8 字节 timestamp(float64, 秒)][JPEG 字节]，见 robot-server broadcastBinaryFrame。
    if (buffer.byteLength < 9) return;
    const view = new DataView(buffer);
    const streamType = view.getUint8(0);
    const ts = view.getFloat64(1, true);
    const jpeg = new Blob([buffer.slice(9)], { type: "image/jpeg" });
    if (streamType === 1) {
      cameraFrames += 1;
      if (pendingCameraFrame !== null) cameraDropped += 1;
      pendingCameraFrame = jpeg;
      pendingCameraTs = ts;
      scheduleFrames();
    } else if (streamType === 2) {
      camera2Frames += 1;
      if (pendingCamera2Frame !== null) camera2Dropped += 1;
      pendingCamera2Frame = jpeg;
      pendingCamera2Ts = ts;
      scheduleFrames();
    }
  }

  function log(msg: string) {
    const now = Date.now();
    // 控制状态会同时走 WebSocket 与 WebRTC；合并紧邻的同一事件。
    if (msg === lastLogMessage && now - lastLogAt < 1000) return;
    lastLogMessage = msg;
    lastLogAt = now;
    const t = new Date().toLocaleTimeString();
    logs.value.unshift(`[${t}] ${msg}`);
    if (logs.value.length > 500) logs.value.length = 500;
  }

  function clearLogs() {
    logs.value = [];
    lastLogMessage = "";
    lastLogAt = 0;
  }

  function connect() {
    if (disposed || (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN))) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/control`);

    ws.onopen = () => {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connected.value = true;
      log("WebSocket 已连接");
      sendPing();
    };

    ws.onclose = () => {
      ws = null;
      connected.value = false;
      log("WebSocket 断开，3秒后重连...");
      if (!disposed && reconnectTimer === null) {
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, 3000);
      }
    };

    ws.onerror = () => log("WebSocket 错误");

    ws.onmessage = (ev) => {
      try {
        const msg: WSMessage = JSON.parse(ev.data);
        if (rtcStateOpen && msg.type === "teleop_observation") return;
        handleMessage(msg);
      } catch {
        // 忽略非 JSON
      }
    };
  }

  function connectStream() {
    if (disposed || (streamWs && (streamWs.readyState === WebSocket.CONNECTING || streamWs.readyState === WebSocket.OPEN))) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    streamWs = new WebSocket(`${proto}://${location.host}/ws/stream`);
    streamWs.binaryType = "arraybuffer";
    streamWs.onopen = () => { metrics.value = { ...metrics.value, streamConnected: true }; };
    streamWs.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        handleBinaryFrame(ev.data);
      } else {
        try { handleMessage(JSON.parse(ev.data)); } catch { /* ignore malformed frame */ }
      }
    };
    streamWs.onclose = () => {
      metrics.value = { ...metrics.value, streamConnected: false };
      streamWs = null;
      if (!disposed && !rtcVideoOpen && streamReconnectTimer === null) {
        streamReconnectTimer = window.setTimeout(() => {
          streamReconnectTimer = null;
          connectStream();
        }, 3000);
      }
    };
  }

  function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, 5000);
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

  function scheduleRtcReconnect() {
    if (disposed || rtcReconnectTimer !== null) return;
    rtcReconnectTimer = window.setTimeout(() => {
      rtcReconnectTimer = null;
      void connectRtc();
    }, 3000);
  }

  function closeRtc(scheduleReconnect = false) {
    if (rtcDisconnectTimer !== null) {
      clearTimeout(rtcDisconnectTimer);
      rtcDisconnectTimer = null;
    }
    rtcStateOpen = false;
    const hadVideo = rtcVideoOpen;
    rtcVideoOpen = false;
    metrics.value = { ...metrics.value, rtcConnected: false };
    rtcControl = rtcState = rtcSafety = null;
    cameraStream.value = null;
    camera2Stream.value = null;
    const peer = rtcPeer;
    rtcPeer = null;
    peer?.close();
    if (hadVideo && !disposed) connectStream();
    if (scheduleReconnect) scheduleRtcReconnect();
  }

  async function connectRtc() {
    if (disposed || rtcPeer) return;
    try {
      const configResponse = await fetch("/api/rtc/config");
      const config = await configResponse.json();
      if (!configResponse.ok || !config.enabled) return;
      const peer = new RTCPeerConnection({ iceServers: config.iceServers || [] });
      rtcPeer = peer;
      rtcControl = peer.createDataChannel("robot-control-v1", { ordered: false, maxRetransmits: 0 });
      // State is real-time telemetry: an old sample is useless, so never retransmit or preserve ordering.
      rtcState = peer.createDataChannel("robot-state-v1", { ordered: false, maxRetransmits: 0 });
      rtcSafety = peer.createDataChannel("robot-safety-v1", { ordered: true });
      const rtcVideoEnabled = config.videoEnabled === true;
      if (rtcVideoEnabled) {
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.addTransceiver("video", { direction: "recvonly" });
      }

      rtcState.onopen = () => {
        rtcStateOpen = true;
        metrics.value = { ...metrics.value, rtcConnected: true };
        log("WebRTC 状态通道已连接");
      };
      rtcState.onclose = () => { rtcStateOpen = false; };
      rtcState.onmessage = (event) => {
        try { handleMessage(JSON.parse(String(event.data))); } catch { /* ignore malformed state */ }
      };
      const pendingTracks = new Map<string, MediaStreamTrack>();
      let videoMids: { camera1: string; camera2: string } | null = null;
      const activeVideoMids = new Set<string>();
      const activateRtcVideo = (mid: string, track: MediaStreamTrack) => {
        if (!videoMids) return;
        if (mid === videoMids.camera1) cameraStream.value = new MediaStream([track]);
        if (mid === videoMids.camera2) camera2Stream.value = new MediaStream([track]);
        activeVideoMids.add(mid);
        rtcVideoOpen = true;
        if (activeVideoMids.size === 2) {
          if (streamReconnectTimer) { clearTimeout(streamReconnectTimer); streamReconnectTimer = null; }
          streamWs?.close();
        }
      };
      const installTrack = (mid: string, track: MediaStreamTrack) => {
        if (!videoMids) { pendingTracks.set(mid, track); return; }
        track.onunmute = () => activateRtcVideo(mid, track);
        track.onended = () => {
          activeVideoMids.delete(mid);
          if (mid === videoMids?.camera1) cameraStream.value = null;
          if (mid === videoMids?.camera2) camera2Stream.value = null;
          rtcVideoOpen = activeVideoMids.size > 0;
          if (!disposed) connectStream();
        };
        if (!track.muted) activateRtcVideo(mid, track);
      };
      peer.ontrack = (event) => {
        const mid = event.transceiver.mid;
        const receiver = event.receiver as RTCRtpReceiver & {
          playoutDelayHint?: number;
          jitterBufferTarget?: number;
        };
        try {
          receiver.playoutDelayHint = 0;
          receiver.jitterBufferTarget = 0;
        } catch {
          // Experimental low-latency hints are not available in every browser.
        }
        if (mid !== null) installTrack(mid, event.track);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected" && rtcDisconnectTimer !== null) {
          clearTimeout(rtcDisconnectTimer);
          rtcDisconnectTimer = null;
        } else if (peer.connectionState === "disconnected" && rtcDisconnectTimer === null) {
          rtcDisconnectTimer = window.setTimeout(() => {
            rtcDisconnectTimer = null;
            if (rtcPeer === peer && peer.connectionState === "disconnected") closeRtc(!disposed);
          }, 3000);
        } else if (["failed", "closed"].includes(peer.connectionState)) {
          closeRtc(!disposed);
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      const response = await fetch("/api/rtc/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(peer.localDescription),
      });
      const answer = await response.json();
      if (!response.ok) throw new Error(answer.error || "WebRTC signaling 失败");
      videoMids = answer.videoMids;
      await peer.setRemoteDescription(answer);
      for (const [mid, track] of pendingTracks) installTrack(mid, track);
    } catch (cause) {
      log(`WebRTC 不可用，继续使用 WebSocket: ${cause instanceof Error ? cause.message : String(cause)}`);
      closeRtc(!disposed);
    }
  }

  function handleMessage(msg: WSMessage) {
    switch (msg.type) {
      case "pong":
        handlePong(msg);
        break;
      case "status":
        running.value = msg.running ?? false;
        break;
      case "stopped":
        running.value = false;
        if (msg.error) {
          log(`遥操作进程异常退出: ${msg.error}`);
          fatalError.value = msg.error;
        } else {
          log("遥操作进程已退出");
        }
        break;
      case "teleop_observation":
        controlFrames += 1;
        if (typeof msg.applied_seq === "number") {
          const sentAt = controlSentAt.get(msg.applied_seq);
          if (sentAt !== undefined) {
            metrics.value.controlLatency = Math.round(performance.now() - sentAt);
            for (const sequence of controlSentAt.keys()) {
              if (sequence <= msg.applied_seq) controlSentAt.delete(sequence);
            }
          }
        } else {
          metrics.value.controlLatency = latency(msg.ts);
        }
        if (msg.leader) leaderJoints.value = msg.leader;
        if (msg.follower) followerJoints.value = msg.follower;
        break;
      case "recording_status":
        recording.value = {
          state: msg.state as RecordingStatus["state"],
          dataset: typeof msg.dataset === "string" ? msg.dataset : null,
          task: typeof msg.task === "string" ? msg.task : null,
          fps: typeof msg.fps === "number" ? msg.fps : 30,
          frames: typeof msg.frames === "number" ? msg.frames : 0,
          episode: typeof msg.episode === "number" ? msg.episode : null,
          path: typeof msg.path === "string" ? msg.path : null,
          error: typeof msg.error === "string" ? msg.error : null,
          plannedEpisodes: typeof msg.plannedEpisodes === "number" ? msg.plannedEpisodes : 10,
          episodeTime: typeof msg.episodeTime === "number" ? msg.episodeTime : 20,
          resetTime: typeof msg.resetTime === "number" ? msg.resetTime : 5,
          resume: msg.resume === true,
        };
        break;
      case "bridge_log": {
        const source = msg.source === "recorder" ? "录制" : "遥操作";
        const level = msg.level === "error" || msg.level === "stderr" ? "错误" : msg.level === "warn" ? "警告" : "信息";
        const message = typeof msg.message === "string" ? msg.message : "未知日志";
        log(`[${source}/${level}] ${message}`);
        break;
      }
    }
  }

  function send(msg: object) {
    let payload = msg;
    if ((msg as WSMessage).type === "action") {
      const sequence = ++rtcSequence;
      payload = { ...msg, seq: sequence, sent_at_ms: Date.now() };
      controlSentAt.set(sequence, performance.now());
      if (controlSentAt.size > 240) controlSentAt.delete(controlSentAt.keys().next().value!);
      if (rtcControl?.readyState === "open" && rtcControl.bufferedAmount < 64 * 1024) {
        rtcControl.send(JSON.stringify(payload));
        return;
      }
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  onMounted(() => {
    connect();
    connectStream();
    void connectRtc();
    metricsTimer = window.setInterval(updateMetrics, 1000);
    // 定期重新估算时钟偏差，避免长时间运行后（时钟漂移、网络路径变化）产生的误差累积。
    pingTimer = window.setInterval(sendPing, 5000);
    rtcHeartbeatTimer = window.setInterval(() => {
      if (rtcSafety?.readyState === "open") {
        rtcSafety.send(JSON.stringify({ type: "heartbeat", ts_ms: Date.now() }));
      }
    }, 250);
  });
  onUnmounted(() => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (streamReconnectTimer) clearTimeout(streamReconnectTimer);
    if (rtcReconnectTimer) clearTimeout(rtcReconnectTimer);
    if (rtcDisconnectTimer) clearTimeout(rtcDisconnectTimer);
    if (frameAnimation !== null) cancelAnimationFrame(frameAnimation);
    if (metricsTimer !== null) clearInterval(metricsTimer);
    if (pingTimer !== null) clearInterval(pingTimer);
    if (rtcHeartbeatTimer !== null) clearInterval(rtcHeartbeatTimer);
    if (ws) ws.close();
    if (streamWs) streamWs.close();
    closeRtc(false);
    if (cameraFrameUrl) URL.revokeObjectURL(cameraFrameUrl);
    if (camera2FrameUrl) URL.revokeObjectURL(camera2FrameUrl);
  });

  return {
    connected,
    running,
    leaderJoints,
    followerJoints,
    cameraFrame,
    camera2Frame,
    cameraStream,
    camera2Stream,
    logs,
    fatalError,
    recording,
    metrics,
    log,
    clearLogs,
    send,
  };
}
