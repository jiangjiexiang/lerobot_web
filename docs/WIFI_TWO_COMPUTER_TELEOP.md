# 双电脑 Wi‑Fi 遥操作设计

## 目标

让主臂（Leader）接在 **操作电脑**，从臂（Follower）接在 **机器人电脑**。两台电脑连接同一可信 Wi‑Fi，操作电脑只需 Chrome/Edge 浏览器：网页借助 Web Serial 读取 Leader 的关节角度并发送给机器人电脑，机器人电脑再驱动 Follower。MuJoCo 已关闭。

```text
操作电脑（Operator）                                    机器人电脑（Robot）
┌──────────────────────────────────────┐              ┌──────────────────────────────────────┐
│ Leader USB → /dev/ttyACM*             │              │ Follower USB → /dev/ttyACM*           │
│ leader_bridge.py                       │              │ follower_bridge.py                     │
│ operator-server :3001                  │── Wi‑Fi ───▶│ robot-server :43127                   │
│ 浏览器（可选，本地状态页）              │  WebSocket   │ 浏览器监控 / 摄像头                    │
└──────────────────────────────────────┘              └──────────────────────────────────────┘
              关节采样 / 控制指令                                    执行、状态和视频回传
```

## 当前实现与限制

当前网页已经实现 Web Serial Leader：勾选“浏览器 Web Serial 主臂”，选择 COM 口后，浏览器以 1 Mbps 读取 6 个 STS3215 的 `Present_Position`，用机器人端提供的 Leader 标定换算为关节值，再以 WebSocket `action` 发送给机器人端。

机器人端以 `--remote-leader` 启动时不再打开本机 Leader 串口，只接收完整的六关节动作；150 ms 未收到有效动作时不再写入新目标，从而保持最后姿态。此模式仍须先在空载、低速台架上验证，再用于真机任务。

## 网络与地址规划

建议为两台电脑保留 DHCP 地址或静态地址，例如：

| 设备 | 示例地址 | 需要监听的端口 |
| --- | --- | --- |
| 机器人电脑 | `192.168.1.50` | TCP 43127 |
| 操作电脑 | `192.168.1.51` | 本地 3001（可选） |

机器人端应是服务端，操作端主动连接：`ws://192.168.1.50:43127/ws/control`。视频使用独立的 `/ws/stream` 通道；这样无需在操作电脑上开放控制入站端口。

在接机械臂前验证网络：

```bash
# 操作电脑上
curl http://192.168.1.50:43127/health
nc -vz 192.168.1.50 43127
```

若机器人服务运行在 WSL2，必须先确认该端口能从局域网访问。WSL 的默认 NAT 网络有时只允许 Windows 本机访问；可使用 WSL 镜像网络或在 Windows 主机配置受限的端口转发。无论哪种方式，都只允许可信 Wi‑Fi 网段访问 TCP 43127。

## 推荐消息协议

使用一条持久 WebSocket 承载控制、状态和心跳。每个消息都包含版本、单调递增序号和毫秒时间戳。

### 操作端 → 机器人端：动作

```json
{
  "type": "action",
  "version": 1,
  "seq": 4312,
  "ts_ms": 1760000000123,
  "joints": {
    "shoulder_pan": 12.4,
    "shoulder_lift": -21.8,
    "elbow_flex": 35.2,
    "wrist_flex": 4.0,
    "wrist_roll": 0.0,
    "gripper": 58.0
  }
}
```

机器人端只接受已认证的操作端连接，并验证：字段完整、数值有限、单位一致、序号递增、关节范围合法。

### 机器人端 → 操作端：状态

```json
{
  "type": "follower_observation",
  "version": 1,
  "ts_ms": 1760000000132,
  "joints": { "shoulder_pan": 12.1, "shoulder_lift": -21.5 },
  "control": { "armed": true, "last_action_age_ms": 9 },
  "fault": null
}
```

视频不应与 60 Hz 控制指令争抢同一无节流通道。控制使用 `/ws/control`；摄像头使用独立 `/ws/stream`，并且只保留最新帧。MuJoCo 已关闭。

## 组件职责

| 组件 | 部署位置 | 职责 |
| --- | --- | --- |
| `leader_bridge.py` | 操作电脑 | 只读 Leader；不向 Leader 写入位置 |
| `operator-server` | 操作电脑 | 连接管理、限频、将 Leader 数据转换为 `action` |
| `robot-server` | 机器人电脑 | 鉴权、心跳/超时、指令校验、状态与视频服务 |
| `follower_bridge.py`（新增） | 机器人电脑 | 独占 Follower 串口，执行动作并读取反馈 |

`follower_bridge.py` 应从 stdin 接收 JSON `action`，并从 stdout 输出 `follower_observation`。机器人服务负责把 WebSocket 的 `action` 转发给它。不要让多个进程同时打开 Follower 串口。

## 失联与安全策略（必须实现）

1. **默认未解锁。** 机器人端启动后 `armed=false`，必须由本地网页或物理确认动作解锁。
2. **动作看门狗。** 最后有效 `action` 超过 150 ms：停止写入新目标；超过 500 ms：禁用 Follower 扭矩或进入经验证的安全保持姿态。
3. **速度限制。** 保留每关节最大相对目标限制，首次部署建议 10–20°/s，并限制夹爪动作。
4. **显式急停。** 机器人端需要本地可用的 Stop/急停；操作端断网、浏览器关闭或服务崩溃不能阻止急停。
5. **单控制者。** 同一时刻只允许一个已认证操作端会话。新会话不能静默抢占。
6. **日志。** 记录连接、解锁、急停、超时、范围拒绝和执行异常；不要记录凭据。

## 分阶段实施

### 阶段 1：网络与只读验证

1. 两台电脑接入同一 Wi‑Fi，固定机器人电脑地址。
2. 只启动 Robot API，验证操作电脑能访问 `/health`。
3. 操作端运行 `leader_bridge.py`，确认能持续读取 Leader。
4. 不连接 Follower 的动作写入；仅在操作端网页显示 Leader 数据。

### 阶段 2：机器人端动作通道

1. 新建仅管理 Follower 的桥接进程，先使用模拟数据或低速单关节测试。
2. 接入 `action` 校验、序号检查与 150 ms 看门狗。
3. 将 Follower 反馈回传；验证网络中断时动作停止。

### 阶段 3：端到端低风险遥操作

1. 在空旷台面、低 FPS / 低速度限制下启用 `armed`。
2. 测量端到端延迟（Leader 采样时间到 Follower 反馈时间），目标局域网通常应小于 50 ms。
3. 逐步提高到所需帧率；控制频率和视频帧率可分别调节。

### 阶段 4：安全加固

使用 WPA2/WPA3 可信网络；跨网络访问时优先使用 WireGuard/Tailscale 等私网，不要将 43127 端口公网映射。为控制 WebSocket 添加令牌或双向 TLS，并在机器人端做来源限制。

## 启动步骤

1. 在机器人电脑创建并启用局域网 HTTPS，详见根目录 README；启动 `./start_robot.sh`。
2. 在操作电脑用 Chrome/Edge 打开 `https://机器人电脑IP:5173`。
3. 填写 Follower 串口/ID；勾选“浏览器 Web Serial 主臂”，填写 Leader ID。
4. 点击“连接 Leader COM”，在浏览器权限窗中选择主臂 COM 口。
5. 确认网页状态与关节数据正常后，点击“启动遥操作”。
6. 紧急情况始终优先使用机器人电脑网页的“停止遥操作”、物理断电或硬件急停。
