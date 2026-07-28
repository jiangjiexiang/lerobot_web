# WebRTC 控制与视频传输决策

## 当前实现

项目现在已经提供可选 WebRTC 传输层，并保留 WebSocket 自动回退。它不会替代 ROS 2 控制层。

```text
浏览器
  ├── JPEG frames   ◀──── RTCDataChannel ◀────── Camera/WebRTC gateway
  ├── control       ───── RTCDataChannel ──────▶ ROS 2 JointTrajectory
  └── safety/admin  ───── reliable channel ────▶ watchdog / enable / stop
```

当前 `robot-server` 使用原生 WebRTC 实现 PeerConnection 和 SDP/ICE signaling。控制、状态与现有二进制 JPEG 帧分别使用 DataChannel；浏览器协商失败或通道断开时自动恢复 WebSocket。ROS 2 继续承载关节状态与命令，数据集录制继续读取本地原始摄像头。

WebRTC 默认启用，可用 `ENABLE_WEBRTC=0` 关闭。局域网无需额外 ICE 服务；跨网可设置 `RTC_STUN_URL`、`RTC_TURN_URL`、`RTC_TURN_USERNAME`、`RTC_TURN_CREDENTIAL`。现有 WebSocket 控制与二进制 JPEG 流始终作为回退。

## 通道设计

### 视频

- 当前两路摄像头共用 `robot-video-v1`，沿用 `[类型][时间戳][JPEG]` 帧格式。
- 通道无序、零重传，并在服务端检查 `bufferedAmount`；网络拥塞时直接丢弃旧帧。
- 后续媒体轨首选 H.264（硬件编码可用时），否则 VP8；低延迟配置关闭 B 帧并缩短关键帧间隔。
- 机器人本地录制和网络传输保持分支隔离，网络拥塞不得反压控制循环或数据录制。

### 控制

使用两个 DataChannel：

| label | 配置 | 内容 |
| --- | --- | --- |
| `robot-control-v1` | `ordered: false, maxRetransmits: 0` | 高频关节目标；旧包晚到比丢包更危险 |
| `robot-state-v1` | `ordered: true` | 机器人状态和录制状态 |
| `robot-video-v1` | `ordered: false, maxRetransmits: 0` | 两路最新 JPEG 帧 |
| `robot-safety-v1` | `ordered: true` | stop 和心跳 |

控制包沿用传输无关的 JSON 语义，并增加单调序号：

```json
{
  "type": "action",
  "seq": 1842,
  "sent_at_ms": 1720000000000,
  "joints": {"shoulder_pan": 0.0, "gripper": 42.0}
}
```

网关只接受递增 `seq`，并实行单控制者租约。DataChannel 关闭、ICE 状态失败或 750 ms 心跳/控制超时会停止遥操作；ROS/硬件节点自己的 watchdog 仍同时生效。

### Signaling 与穿透

- 局域网：HTTPS 下的 REST/WebSocket signaling + host ICE candidate 通常足够。
- 跨网：部署 STUN/TURN；TURN 凭证必须短期有效，不能写入前端仓库。
- 生产环境需要会话鉴权、单控制者租约和审计。观看者只能收视频/状态，不能创建控制 DataChannel。

## 当前 JPEG 与后续视频媒体轨

当前实现不解码或重编码 JPEG，直接通过不可靠 DataChannel 发送，因此不引入额外视频编码 CPU 开销。每个客户端只保留最新帧，慢客户端不会形成队列。

生产环境若需要更低带宽和浏览器硬件解码，仍建议增加 GStreamer `webrtcbin` 视频媒体轨并使用 Jetson H.264 编码；控制和安全 DataChannel 协议无需改变。

后续优化顺序：

1. 安装并验证 `webrtcbin`、`nice`、H.264/VP8 硬件编码器。
2. 将 `robot-video-v1` JPEG 通道替换为两路 video track。
3. 增加 `getStats()` 自适应码率、分辨率和帧率。
4. 在 Wi-Fi 丢包、浏览器刷新和 TURN relay 场景完成实机急停验收。

## Signaling API

```text
GET  /api/rtc/config
POST /api/rtc/offer
```

`POST /api/rtc/offer` 接受浏览器完整 ICE gathering 后的 SDP offer，并返回 answer。RTC 服务端与浏览器的控制、状态、视频往返由 `robot-server/test/rtcGateway.integration.js` 自动验证。
