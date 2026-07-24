import { ref } from "vue";
import type { JointData } from "./useWebSocket";

type Calibration = Record<string, { id: number; drive_mode: number; range_min: number; range_max: number }>;
type SerialPortLike = { open(options: { baudRate: number; bufferSize?: number }): Promise<void>; close(): Promise<void>; readable: ReadableStream<Uint8Array> | null; writable: WritableStream<Uint8Array> | null };
type SerialNavigator = Navigator & { serial?: { requestPort(): Promise<SerialPortLike> } };

const names: (keyof JointData)[] = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];

function packet(id: number, instruction: number, params: number[]) {
  const bytes = [0xff, 0xff, id, params.length + 2, instruction, ...params];
  return new Uint8Array([...bytes, (~bytes.slice(2).reduce((sum, byte) => sum + byte, 0)) & 0xff]);
}

export function useLeaderSerial(
  send: (message: object) => void,
  log: (message: string) => void,
  onFatalDisconnect: () => Promise<void>,
) {
  const connected = ref(false);
  const error = ref<string | null>(null);
  const joints = ref<JointData | null>(null);
  let port: SerialPortLike | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let buffer: number[] = [];
  let active = false;
  let readFailure: Error | null = null;
  let consecutivePollFailures = 0;

  const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  async function readLoop() {
    try {
      while (reader) {
        const read = await reader.read();
        if (read.done) throw new Error("串口已关闭");
        buffer.push(...read.value);
      }
    } catch (cause) {
      if (active) readFailure = cause instanceof Error ? cause : new Error(String(cause));
    }
  }

  async function nextPacket(expectedId: number, minimumParams: number, timeoutMs = 250): Promise<number[]> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      while (buffer.length >= 4) {
        const start = buffer.findIndex((byte, index) => byte === 0xff && buffer[index + 1] === 0xff);
        if (start < 0) { buffer = buffer.slice(-1); break; }
        if (start > 0) buffer = buffer.slice(start);
        const total = buffer[3] + 4;
        if (buffer.length < total) break;
        const value = buffer.splice(0, total);
        const checksum = (~value.slice(2, -1).reduce((sum, byte) => sum + byte, 0)) & 0xff;
        if (value[value.length - 1] !== checksum) continue;
        // 关闭扭矩等写命令可能留下 ACK；只接收当前读取请求的完整响应。
        if (value[2] !== expectedId || value[3] < minimumParams + 2) continue;
        return value;
      }
      if (readFailure) throw readFailure;
      if (!reader) throw new Error("串口已关闭");
      await delay(2);
    }
    throw new Error("读取超时");
  }

  async function readPosition(id: number): Promise<number> {
    if (!writer) throw new Error("串口尚未连接");
    let lastError = "读取超时";
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await writer.write(packet(id, 0x02, [56, 2]));
      try {
        const response = await nextPacket(id, 2);
        if (response[4] !== 0) throw new Error(`返回错误码 ${response[4]}`);
        return response[5] | (response[6] << 8);
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause);
        if (readFailure || !active) break;
        await delay(20);
      }
    }
    throw new Error(`电机 ${id} ${lastError}（已重试 3 次）`);
  }

  async function disableLeaderTorque() {
    if (!writer) throw new Error("串口尚未连接");
    // 与 LeRobot 的 leader_bus.disable_torque() 对齐：关闭扭矩并解除锁定，
    // 使主臂可被手动拖动。只写 Leader，绝不向 Follower 发送此指令。
    for (let id = 1; id <= 6; id += 1) {
      await writer.write(packet(id, 0x03, [40, 0])); // Torque_Enable = 0
      await writer.write(packet(id, 0x03, [55, 0])); // Lock = 0
    }
  }

  function normalize(raw: number, name: keyof JointData, cal: Calibration["shoulder_pan"]): number {
    const bounded = Math.max(cal.range_min, Math.min(cal.range_max, raw));
    if (name === "gripper") {
      const percent = ((bounded - cal.range_min) / (cal.range_max - cal.range_min)) * 100;
      return cal.drive_mode ? 100 - percent : percent;
    }
    return (bounded - (cal.range_min + cal.range_max) / 2) * 360 / 4095;
  }

  async function connect(leaderId: string, fps: number) {
    const serial = (navigator as SerialNavigator).serial;
    if (!serial) throw new Error("当前浏览器不支持 Web Serial；请使用 Chrome 或 Edge，并通过 HTTPS 访问。");
    if (!leaderId) throw new Error("请填写 Leader ID");
    error.value = null;
    const calibrationResponse = await fetch(`/api/calibration/leader/${encodeURIComponent(leaderId)}`);
    const calibrationJson = await calibrationResponse.json();
    if (!calibrationResponse.ok || !calibrationJson.ok) throw new Error(calibrationJson.error || "无法加载 Leader 标定");
    const calibration = calibrationJson.calibration as Calibration;
    if (!names.every((name) => calibration[name])) throw new Error("Leader 标定缺少关节数据");

    try {
      port = await serial.requestPort();
      await port.open({ baudRate: 1_000_000, bufferSize: 1024 });
      reader = port.readable?.getReader() || null;
      writer = port.writable?.getWriter() || null;
      if (!reader || !writer) throw new Error("无法打开串口读写通道");
      active = true;
      readFailure = null;
      consecutivePollFailures = 0;
      void readLoop();
      await disableLeaderTorque();
      // 给半双工适配器留出发送 ACK 和切回接收方向的时间。
      await delay(150);
      buffer = [];
      connected.value = true;
      log("Leader COM 已连接，已关闭 Leader 扭矩，开始只读采样");
    } catch (cause) {
      await disconnect();
      throw cause;
    }

    const interval = Math.max(16, Math.round(1000 / Math.min(60, Math.max(1, fps))));
    const poll = async () => {
      if (!active) return;
      try {
        const values = {} as JointData;
        for (const name of names) values[name] = normalize(await readPosition(calibration[name].id), name, calibration[name]);
        joints.value = values;
        send({ type: "action", joints: values, ts_ms: Date.now() });
        if (consecutivePollFailures > 0) {
          log(`Leader 串口已恢复（连续丢包 ${consecutivePollFailures} 轮）`);
          error.value = null;
          consecutivePollFailures = 0;
        }
      } catch (cause) {
        // 用户主动停止会取消正在等待的串口读取，不应记录为设备故障。
        if (!active) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!readFailure && message.includes("读取超时")) {
          consecutivePollFailures += 1;
          error.value = `${message}；正在自动恢复 (${consecutivePollFailures}/5)`;
          if (consecutivePollFailures === 1) log(`Leader 串口瞬时丢包: ${error.value}`);
          // 丢弃不完整的一轮动作；机器人端超时后保持当前位置，下一轮重新读取全部关节。
          buffer = [];
          if (consecutivePollFailures < 5) {
            window.setTimeout(poll, 50);
            return;
          }
        } else {
          error.value = message;
        }
        log(`Leader 串口错误: ${error.value}`);
        await disconnect();
        await onFatalDisconnect();
        return;
      }
      window.setTimeout(poll, interval);
    };
    void poll();
  }

  async function disconnect() {
    active = false;
    connected.value = false;
    try { await reader?.cancel(); } catch { /* port may already be gone */ }
    try { reader?.releaseLock(); writer?.releaseLock(); } catch { /* ignore */ }
    reader = null; writer = null; buffer = [];
    readFailure = null;
    consecutivePollFailures = 0;
    try { await port?.close(); } catch { /* ignore */ }
    port = null;
  }

  return { connected, error, joints, connect, disconnect };
}
