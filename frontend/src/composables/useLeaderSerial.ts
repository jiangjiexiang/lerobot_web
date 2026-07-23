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

export function useLeaderSerial(send: (message: object) => void, log: (message: string) => void) {
  const connected = ref(false);
  const error = ref<string | null>(null);
  const joints = ref<JointData | null>(null);
  let port: SerialPortLike | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let buffer: number[] = [];
  let active = false;

  async function nextPacket(timeoutMs = 60): Promise<number[]> {
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
        if (value[value.length - 1] === checksum) return value;
      }
      if (!reader) break;
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("读取超时")), Math.max(1, deadline - performance.now()))),
      ]);
      if (read.done) throw new Error("串口已关闭");
      buffer.push(...read.value);
    }
    throw new Error("电机无响应");
  }

  async function readPosition(id: number): Promise<number> {
    if (!writer) throw new Error("串口尚未连接");
    await writer.write(packet(id, 0x02, [56, 2]));
    const response = await nextPacket();
    if (response[2] !== id || response[4] !== 0) throw new Error(`电机 ${id} 返回异常`);
    return response[5] | (response[6] << 8);
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

    port = await serial.requestPort();
    await port.open({ baudRate: 1_000_000, bufferSize: 1024 });
    reader = port.readable?.getReader() || null;
    writer = port.writable?.getWriter() || null;
    if (!reader || !writer) throw new Error("无法打开串口读写通道");
    connected.value = true;
    active = true;
    log("Leader COM 已连接，开始只读采样");

    const interval = Math.max(16, Math.round(1000 / Math.min(60, Math.max(1, fps))));
    const poll = async () => {
      if (!active) return;
      try {
        const values = {} as JointData;
        for (const name of names) values[name] = normalize(await readPosition(calibration[name].id), name, calibration[name]);
        joints.value = values;
        send({ type: "action", joints: values, ts_ms: Date.now() });
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause);
        log(`Leader 串口错误: ${error.value}`);
        await disconnect();
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
    try { await port?.close(); } catch { /* ignore */ }
    port = null;
  }

  return { connected, error, joints, connect, disconnect };
}
