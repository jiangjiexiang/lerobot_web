# LeRobot Web · SO-101 遥操作控制台

用于 SO-101 Leader / Follower 机械臂的网页遥操作与 MuJoCo 实时镜像。当前稳定使用方式是 **两只机械臂连接同一台机器人电脑**；浏览器通过网页控制台启动、停止和观察遥操作。

> 要把 Leader 放到另一台 Wi‑Fi 电脑，请先阅读 [双电脑 Wi‑Fi 遥操作设计](docs/WIFI_TWO_COMPUTER_TELEOP.md)。项目中已有 `operator-server` 原型，但它与当前一体化桥接脚本的消息协议尚未完成对接，不能直接用于生产遥操作。

## 当前架构

```text
浏览器 ── HTTP / WebSocket ── robot-server ── stdio ── teleop_mujoco.py
                                      │                     │
                                      │                     ├─ /dev/ttyACM0  Follower（从臂）
                                      │                     ├─ /dev/ttyACM1  Leader（主臂）
                                      │                     └─ MuJoCo 离屏渲染
                                      └─ 网页关节数据 / MuJoCo JPEG 帧
```

默认映射（请以实际线缆为准）：

| 设备 | 串口 | ID |
| --- | --- | --- |
| Follower（从臂） | `/dev/ttyACM0` | `R12253102` |
| Leader（主臂） | `/dev/ttyACM1` | `R07253102` |

## 快速启动

```bash
cd ~/lerobot_web
./start_robot.sh
```

打开 `http://localhost:5173`。页面中确认串口和 ID 后启动遥操作；建议先选择“仅网页画面”。

### 局域网 HTTPS（Web Serial 的前置条件）

若另一台电脑要只通过浏览器连接 Leader 的 COM 口，控制网页必须使用 HTTPS。先在机器人电脑生成包含其局域网 IP 的证书：

```bash
./scripts/generate-lan-cert.sh 192.168.1.50
```

将生成的 `.certs/lerobot-lan-ca.crt` **仅一次**导入操作电脑 Windows 的“受信任的根证书颁发机构”，然后启动：

```bash
HTTPS_CERT="$PWD/.certs/lerobot-lan.crt" \
HTTPS_KEY="$PWD/.certs/lerobot-lan.key" \
REMOTE_CONTROL_TOKEN="请替换为随机控制密钥" \
./start_robot.sh
```

操作电脑使用 Chrome 或 Edge 打开 `https://192.168.1.50:5173`。证书文件和私有 CA 不会被 Git 跟踪。

若服务运行在 WSL2，请按 [WSL2 局域网访问控制台](docs/WSL_LAN_ACCESS.md) 配置 Windows 5173 端口转发与防火墙；操作电脑应访问 Windows 的 Wi‑Fi IPv4，而不是 WSL 的 `172.*` 地址。

在网页勾选“浏览器 Web Serial 主臂”，填写 Leader ID 后点击“连接 Leader COM”，在浏览器弹窗中选择该电脑上的 COM 口。连接成功前，“启动遥操作”会保持禁用；这样机器人端不会在没有操作输入时启动。
网页中的“远程控制密钥”必须与机器人端的 `REMOTE_CONTROL_TOKEN` 完全一致；建议用 `openssl rand -hex 32` 生成。该密钥不会保存到浏览器或仓库。

也可一条命令完成机器人端的证书、密钥和服务启动：

```bash
./start_wifi_robot.sh
```

脚本会自动读取 Windows 默认路由网卡的 IPv4，并打印操作电脑需要打开的网页地址、控制密钥及 Windows 管理员端口转发命令。若自动检测不正确，才显式指定 `--host-ip 192.168.1.50`。

服务端口：

| 服务 | 地址 |
| --- | --- |
| 网页开发服务器 | `http://localhost:5173` |
| Robot API | `http://localhost:3000` |
| WebSocket | `ws://localhost:3000/ws` |
| MuJoCo MJPEG | `http://localhost:3000/video/mujoco` |
| 健康检查 | `http://localhost:3000/health` |

## 常用操作

### 关闭卡住的遥操作进程

先在启动终端按 `Ctrl+C`。若串口仍被占用：

```bash
fuser -v /dev/ttyACM0 /dev/ttyACM1
kill <PID>
```

确认 `fuser` 没有输出后再启动。

### 检查串口

```bash
ls /dev/ttyACM* /dev/ttyUSB*
```

不要同时运行校准程序、独立桥接脚本和网页遥操作；它们会争用串口。

### 画面质量

网页 MuJoCo 输出为 1920×1080。60 FPS 会显著增加 GPU、JPEG 编码和 Wi‑Fi/局域网负载；若出现掉帧，保持 1080p 并改为 30 FPS 或 15 FPS。

## 项目结构

```text
bridge/                 Python 串口、遥操作与 MuJoCo 桥接
  teleop_mujoco.py      当前单机遥操作主程序
  leader_bridge.py      Leader 只读桥接（双电脑方案使用）
  models/               MuJoCo 模型与资源
robot-server/           当前机器人端 API / WebSocket 服务
operator-server/        双电脑操作端原型（待完成协议对接）
frontend/               Vue 3 控制台
docs/                   部署与设计文档
start_robot.sh          一键启动机器人端与前端
start_operator.sh       操作端原型启动脚本
```

## 开发验证

```bash
cd frontend && npm run build
cd ../robot-server && npm run build
/home/jiang/miniconda3/envs/lerobot/bin/python -m py_compile ../bridge/teleop_mujoco.py
```

## 安全提示

- 启动前确保 Follower 周围无障碍物，首次运行时保持低速、小幅度动作。
- 网络遥操作必须加入失联超时和急停；具体要求见 [双电脑 Wi‑Fi 遥操作设计](docs/WIFI_TWO_COMPUTER_TELEOP.md)。
- 不要把控制端口直接暴露到公网。
