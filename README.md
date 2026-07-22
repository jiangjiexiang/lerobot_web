# LeRobot Web 遥操作与监控系统

基于 Vue 3 + Vite + Node.js + Python 的双电脑网络遥操作架构，支持实时显示机械臂关节角度、摄像头画面、MuJoCo 3D 仿真，并支持远程控制。

## 架构

```
操作电脑 (Operator)                    机器人电脑 (Robot)
──────────────┐                      ┌──────────────┐
│ Vue 前端      │                      │ Node.js 后端  │
│ (浏览器)      │◄── WebSocket ──────►│ (Express+WS) │
│              │                      │              │
│ Node.js 后端  │                      │ Python 桥接   │
│ (本地代理)    │                      │ (lerobot SDK)│
│              │                      │              │
│ Python 桥接   │                      │ MuJoCo 仿真   │
│ (Leader)     │                      │ 摄像头采集    │
└──────────────┘                      └──────────────┘
     /dev/ttyACM1                           /dev/ttyACM0
     (Leader 机械臂)                        (Follower 机械臂)
```

## 项目结构

```
lerobot_web/
├── bridge/                     # Python 桥接进程（通用）
│   ├── robot_bridge.py         # Follower 端：lerobot + MuJoCo + 摄像头
│   ├── leader_bridge.py        # Leader 端：lerobot 读取角度
│   ├── models/
│   │   └── so101.xml          # SO-101 MuJoCo 模型
│   └── test_mujoco.py         # MuJoCo 测试脚本
│
├── robot-server/               # 机器人电脑 - Node.js 后端
│   ├── src/
│   │   ├── index.ts            # WebSocket 服务 + MJPEG 端点
│   │   ├── robotBridge.ts      # 管理 Python 子进程
│   │   └── streams.ts         # MJPEG 流管理
│   └── package.json
│
├── operator-server/            # 操作电脑 - Node.js 后端
│   ├── src/
│   │   ├── index.ts            # 服务前端 + 管理 leader 桥接
│   │   ├── remoteClient.ts     # WebSocket 客户端（连机器人电脑）
│   │   └── leaderBridge.ts     # 管理本地 leader Python 子进程
│   └── package.json
│
├── frontend/                   # Vue + Vite 前端
│   ├── src/
│   │   ├── App.vue
│   │   ├── components/
│   │   │   ├── JointPanel.vue
│   │   │   ├── LeaderPanel.vue
│   │   │   ├── CameraView.vue
│   │   │   ├── MuJoCoView.vue
│   │   │   └── StatusBar.vue
│   │   └── composables/
│   │       └── useWebSocket.ts
│   └── package.json
│
├── start_robot.sh              # 机器人电脑启动脚本
└── start_operator.sh           # 操作电脑启动脚本
```

## 快速开始

### 1. 安装依赖

```bash
# 安装 Node.js 依赖
cd robot-server && npm install
cd ../operator-server && npm install
cd ../frontend && npm install

# Python 依赖（在 lerobot 环境中）
pip install mujoco opencv-python numpy
```

### 2. 机器人电脑启动

```bash
# 方式 1: 使用启动脚本
./start_robot.sh

# 方式 2: 手动启动
export PYTHON_PATH=/home/jiang/miniconda3/envs/lerobot/bin/python
cd robot-server
PYTHON_PATH=$PYTHON_PATH npm run dev
```

服务启动后：
- WebSocket: `ws://0.0.0.0:3000/ws`
- 摄像头流: `http://0.0.0.0:3000/video/camera`
- MuJoCo 流: `http://0.0.0.0:3000/video/mujoco`
- 健康检查: `http://0.0.0.0:3000/health`

### 3. 操作电脑启动

```bash
# 方式 1: 使用启动脚本
./start_operator.sh

# 方式 2: 手动启动（指定机器人电脑 IP）
export REMOTE_HOST=192.168.1.100
export PYTHON_PATH=/home/jiang/miniconda3/envs/lerobot/bin/python
cd operator-server
REMOTE_HOST=$REMOTE_HOST PYTHON_PATH=$PYTHON_PATH npm run dev

# 启动前端（开发模式）
cd frontend
npm run dev
```

### 4. 访问前端

打开浏览器访问 `http://localhost:5173`

## 配置环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PYTHON_PATH` | `python3` | Python 可执行文件路径 |
| `ROBOT_PORT` | `/dev/ttyACM0` | Follower 串口 |
| `ROBOT_ID` | `""` | Follower 机械臂 ID |
| `LEADER_PORT` | `/dev/ttyACM1` | Leader 串口 |
| `LEADER_ID` | `""` | Leader 机械臂 ID |
| `CAMERA_INDEX` | `0` | 摄像头设备索引 |
| `FPS` | `30` | 循环频率 |
| `PORT` | `3000`/`3001` | 服务端口 |
| `REMOTE_HOST` | `localhost` | 机器人电脑 IP |
| `REMOTE_PORT` | `3000` | 机器人电脑端口 |

## MuJoCo 测试

```bash
cd bridge

# 测试模型加载和离屏渲染
python test_mujoco.py

# 测试关节运动动画
python test_mujoco.py --animate

# 打开交互式查看器（需要 GUI）
python test_mujoco.py --viewer
```

## 通信协议

### WebSocket 消息格式

**观察数据（机器人 -> 操作）**：
```json
{
  "type": "observation",
  "joints": {
    "shoulder_pan": 45.2,
    "shoulder_lift": -10.5,
    "elbow_flex": 30.0,
    "wrist_flex": -5.0,
    "wrist_roll": 0.0,
    "gripper": 80.0
  },
  "ts": 1234567890.123
}
```

**控制指令（操作 -> 机器人）**：
```json
{
  "type": "action",
  "joints": {
    "shoulder_pan": 50.0,
    "shoulder_lift": -5.0,
    "elbow_flex": 35.0,
    "wrist_flex": 0.0,
    "wrist_roll": 0.0,
    "gripper": 100.0
  }
}
```

## 故障排查

### 串口权限问题
```bash
sudo usermod -aG dialout $USER
# 或
sudo chmod 666 /dev/ttyACM0 /dev/ttyACM1
```

### Python 环境找不到 lerobot
确保使用 lerobot 环境的 Python：
```bash
export PYTHON_PATH=/home/jiang/miniconda3/envs/lerobot/bin/python
```

### MuJoCo 渲染失败
检查模型文件是否存在：
```bash
ls bridge/models/so101.xml
```

## 许可证

Apache 2.0
