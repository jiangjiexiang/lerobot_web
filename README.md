# LeRobot Web · SO-101 遥操作控制台

用于 SO-101 Leader / Follower 机械臂的网页遥操作。当前稳定使用方式是 **两只机械臂连接同一台机器人电脑**；浏览器通过网页控制台启动、停止和观察遥操作。MuJoCo 功能已关闭，控制链路不再初始化仿真或生成仿真帧。

> 要把 Leader 放到另一台 Wi‑Fi 电脑，请先阅读 [双电脑 Wi‑Fi 遥操作设计](docs/WIFI_TWO_COMPUTER_TELEOP.md)。项目中已有 `operator-server` 原型，但它与当前一体化桥接脚本的消息协议尚未完成对接，不能直接用于生产遥操作。

## 当前架构

```text
浏览器 ── HTTP / WebSocket ── robot-server ── stdio ── teleop_mujoco.py
                                      │                     │
                                      │                     ├─ /dev/ttyACM0  Follower（从臂）
                                      │                     ├─ /dev/ttyACM1  Leader（主臂）
                                      │                     └─ 摄像头采集
                                      └─ 控制状态 / 独立摄像头推流
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

打开 `http://localhost:5173`。页面中确认串口和 ID 后启动遥操作；建议先选择“仅网页画面”。Vite 会把控制 API、WebSocket 和视频流代理到 Robot Server。

默认启动为轻量模式：控制频率为 60 FPS，并开启机器人摄像头（15 FPS）。网页会枚举 `/dev/video*` 并允许选择摄像头。如需关闭摄像头，可使用 `ENABLE_CAMERA=0 ./start_robot.sh`。MuJoCo 已关闭，`STREAM_FPS` 不再启用仿真推流。

### 局域网 HTTPS（Web Serial 的前置条件）

若另一台电脑要只通过浏览器连接 Leader 的 COM 口，控制网页必须使用 HTTPS。先在机器人电脑生成包含其局域网 IP 的证书：

```bash
./scripts/generate-lan-cert.sh 192.168.1.50
```

将生成的 `.certs/lerobot-lan-ca.crt` **仅一次**导入操作电脑 Windows 的“受信任的根证书颁发机构”，然后启动：

```bash
HTTPS_CERT="$PWD/.certs/lerobot-lan.crt" \
HTTPS_KEY="$PWD/.certs/lerobot-lan.key" \
./start_robot.sh
```

操作电脑使用 Chrome 或 Edge 打开 `https://192.168.1.50:5173`。证书文件和私有 CA 不会被 Git 跟踪。

若服务运行在 WSL2，请按 [WSL2 局域网访问控制台](docs/WSL_LAN_ACCESS.md) 配置 Windows 5173 端口转发与防火墙；操作电脑应访问 Windows 的 Wi‑Fi IPv4，而不是 WSL 的 `172.*` 地址。

在网页勾选“浏览器 Web Serial 主臂”，填写 Leader ID 后点击“连接 Leader COM”，在浏览器弹窗中选择该电脑上的 COM 口。连接成功前，“启动遥操作”会保持禁用；这样机器人端不会在没有操作输入时启动。

也可一条命令完成机器人端的证书、密钥和服务启动：

```bash
./start_wifi_robot.sh
```

脚本会自动读取 Windows 默认路由网卡的 IPv4，并打印操作电脑需要打开的网页地址及 Windows 管理员端口转发命令。若自动检测不正确，才显式指定 `--host-ip 192.168.1.50`。

服务端口：

| 服务 | 地址 |
| --- | --- |
| 网页与数据平台 | `http://localhost:5173` |
| Robot API | `http://localhost:43127` |
| 控制 WebSocket | `ws://localhost:43127/ws/control` |
| 推流 WebSocket | `ws://localhost:43127/ws/stream` |
| 健康检查 | `http://localhost:43127/health` |

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

摄像头 JPEG 推流会占用网络和 CPU；若出现掉帧，降低 `CAMERA_FPS`。控制 WebSocket 与推流 WebSocket 已分离，视频拥塞不应阻塞控制指令。

### 录制 LeRobot 数据集

启动遥操作并确认两路摄像头都有实时画面后，在右侧“数据集录制”中填写数据集名称和任务描述。点击“开始录制”，完成后点击“停止并保存”；数据默认写入 `~/lerobot_datasets/<数据集名称>`，可用 `DATASET_ROOT` 修改根目录。同名数据集会在 FPS 和双摄像头分辨率一致时追加 episode。

录制需要当前 Python 环境已安装 LeRobot 及其视频编码依赖。停止遥操作时，正在录制且已有数据帧的 episode 会自动保存；“丢弃”只清理本次尚未保存的 episode。

页面顶部切换到“数据管理”（也可直接打开 `http://localhost:5173/#datasets`）后，可以浏览本地数据集和 episode、同步回放两路摄像头视频，并编辑审核状态、标签和备注。审核内容保存在数据集内的 `.lerobot-web/reviews.json`，不会改写原始 Parquet 或视频文件。

通过审核的数据仍保留在原 Dataset。点击“发布已通过数据”会生成不可变训练选集，例如 `~/lerobot_datasets/<数据集>/.lerobot-web/collections/v001.json`。左侧“训练管理”（`http://localhost:5173/#training`）可检测 CPU、内存、磁盘和 CUDA/GPU，并基于该选集创建 ACT、Diffusion、SmolVLA 等训练任务。训练输出默认位于 `~/lerobot_datasets/.lerobot-web/training/outputs/<job-id>`。

## 项目结构

```text
bridge/                 Python 串口、遥操作与摄像头桥接
  teleop_mujoco.py      当前单机遥操作主程序（MuJoCo 已禁用）
  leader_bridge.py      Leader 只读桥接（双电脑方案使用）
  dataset_recorder.py   LeRobot 双摄像头 episode 录制器
  dataset_catalog.py    数据集与 episode 元数据读取器
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

## 交给 AI 部署

需要在新电脑上部署或排错时，直接把 [AI 部署与排错操作手册](docs/AI_DEPLOYMENT_AND_TROUBLESHOOTING.md) 连同终端日志交给 AI。手册要求 AI 先检查环境、端口和串口，再执行修改，不应跳过安全检查直接驱动机械臂。
