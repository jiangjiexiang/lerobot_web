# LeRobot Web · ROS 2 数据采集平台

这是一个以 ROS 2 为设备边界的机械臂数据采集与管理网页。当前支持 SO-101 Leader/Follower 和双 USB 摄像头，也允许其他机械臂通过标准 ROS 2 话题接入。项目不会修改 LeRobot 源码；LeRobot 仅作为独立 Python 环境中的硬件与 Dataset 依赖。

当前验收范围是：

- 网页遥操作与双路摄像头预览
- ROS 2 关节状态、控制命令和双相机同步
- LeRobot Dataset 录制、追加 Episode 和视频编码
- 原始 ROS bag 归档
- Dataset/Episode 浏览、同步回放、审核和质量扫描

训练、评估和部署页面暂时不在本阶段验收范围内。

## 系统结构

```text
浏览器
  ├─ 遥操作 / 录制
  └─ 数据管理
          │ HTTP + WebSocket
          ▼
    robot-server
      ├─ ROS 2 bridge ── 标准 ROS 2 话题 ── 机械臂驱动
      ├─ camera_stream ── USB 摄像头
      ├─ dataset_recorder ── LeRobot Dataset
      └─ ros2 bag record ── 原始传感器数据
```

详细的设备接入规则见 [ROS 2 架构说明](docs/ROS2_ARCHITECTURE.md)。

## 一键启动

项目有一键启动脚本：

```bash
cd ~/lerobot_web
./start_robot.sh
```

脚本会完成以下操作：

1. 检查 LeRobot Python、ROS 2、Node.js 和采集依赖。
2. 首次运行时安装前后端 npm 依赖。
3. 构建前端。
4. 启动 Robot Server 和 Vite 网页。
5. 在退出时回收本次启动的进程。

默认地址：

- 网页：`http://localhost:5173`
- Robot API：`http://localhost:43127`
- 数据管理：`http://localhost:5173/#datasets`

首次部署需要先执行一次：

```bash
/home/jiang/miniconda3/envs/lerobot/bin/python3 \
  -m pip install -e '/home/jiang/lerobot[feetech]'

bash scripts/install_ros2_capture_deps.sh
```

如果 Python 或数据目录不在默认位置：

```bash
PYTHON_PATH=/path/to/lerobot/bin/python3 \
LEROBOT_PYTHON_PATH=/path/to/lerobot/bin/python3 \
DATASET_ROOT=/data/lerobot_datasets \
./start_robot.sh
```

## SO-101 采集

默认设备映射如下，请以实际接线为准：

| 设备 | 串口 | 默认 ID |
| --- | --- | --- |
| Follower | `/dev/ttyACM0` | `R12253102` |
| Leader | `/dev/ttyACM1` | `R07253102` |

使用默认 ROS 2 + LeRobot 驱动：

```bash
CONTROL_BACKEND=ros2 ROS2_DRIVER=lerobot ./start_robot.sh
```

网页中选择两个串口和两路摄像头，启动遥操作，确认关节和画面持续更新后即可开始录制。

## 接入其他 ROS 2 机械臂

外部驱动需要提供以下接口：

| 方向 | 默认话题 | 消息类型 |
| --- | --- | --- |
| 输入 | `/leader/joint_states` | `sensor_msgs/msg/JointState` |
| 输入 | `/follower/joint_states` | `sensor_msgs/msg/JointState` |
| 输出 | `/follower/joint_trajectory_controller/joint_trajectory` | `trajectory_msgs/msg/JointTrajectory` |
| 输入 | `/camera1/image_raw/compressed` | `sensor_msgs/msg/CompressedImage` |
| 输入 | `/camera2/image_raw/compressed` | `sensor_msgs/msg/CompressedImage` |

所有采集输入必须填写 `header.stamp`，两路关节和两路图像会按消息时间戳近似同步。关节名称和数量由第一帧 `JointState` 自动建立，不限定为 SO-101 的六关节。

启动外部驱动模式：

```bash
CONTROL_BACKEND=ros2 \
ROS2_DRIVER=external \
ROS2_COMMAND_SOURCE=ros \
ENABLE_CAMERA=0 \
./start_robot.sh
```

`ENABLE_CAMERA=0` 表示相机由外部 ROS 2 节点发布。如果相机仍接在本机并由网页进程读取，则不要设置它。

当前网页一键启动链路和 rosbag 使用上表中的稳定话题名。厂商驱动话题不同的情况下，建议在厂商 launch 文件中 remap 到这些名称。只单独运行 bridge 时，也可以显式指定话题：

```bash
/usr/bin/python3 \
  ros2_ws/src/lerobot_ros2_bridge/lerobot_ros2_bridge/web_bridge.py \
  --driver external \
  --command-source ros \
  --leader-state-topic /my_arm/leader/joint_states \
  --follower-state-topic /my_arm/follower/joint_states \
  --command-topic /my_arm/controller/joint_trajectory \
  --camera1-topic /my_arm/camera_left/image_raw/compressed \
  --camera2-topic /my_arm/camera_right/image_raw/compressed
```

检查话题：

```bash
source /opt/ros/humble/setup.bash
ros2 topic list
ros2 topic info /follower/joint_states -v
ros2 topic hz /camera1/image_raw/compressed
```

## 数据采集

在“遥操作”页面右侧填写数据集名称、任务、FPS 和 Episode 参数：

1. 点击“开始录制”。
2. 完成动作后点击“停止并保存”。
3. 打开“数据管理”检查 Episode、双路视频和质量报告。

默认输出：

```text
~/lerobot_datasets/<dataset>/
  meta/
  data/
  videos/
  .lerobot-web/reviews.json

~/lerobot_datasets/.lerobot-web/raw-bags/<dataset>/
  episode-*/
```

同名 Dataset 只有在 FPS、相机分辨率、关节名称和顺序一致时才会追加。录制器兼容 LeRobot 0.4 与 0.5+；兼容逻辑封装在本项目内，不修改 LeRobot。

同步和归档相关环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RECORDING_MAX_SENSOR_AGE_MS` | `250` | 允许的最大传感器数据年龄 |
| `RECORDING_MAX_CAMERA_SKEW_MS` | `100` | 两路相机最大时间差 |
| `ROSBAG_ENABLED` | `1` | 是否同时保存原始 ROS bag |
| `ROSBAG_REQUIRE_MCAP` | `0` | 为 `1` 时，缺少 MCAP 插件则拒绝录制 |
| `DATASET_STREAMING_ENCODING` | `auto` | LeRobot 0.5+ 实时视频编码策略 |
| `DATASET_VIDEO_CODEC` | `auto` | 视频编码器 |

MCAP 插件缺失时默认回退到 sqlite3，并在网页录制状态中显示实际存储格式。

## 数据管理

打开 `/#datasets` 后可以：

- 浏览 Dataset 和 Episode 元数据
- 同步播放两路相机视频
- 编辑审核状态、标签、负责人和备注
- 批量审核
- 执行数据质量扫描
- 下载视频和查看原始数据路径

审核信息只写入 `.lerobot-web/reviews.json`，不会改写原始 Parquet 或视频。

## 局域网 HTTPS

浏览器 Web Serial 必须运行在安全上下文。生成本机局域网证书并一键启动：

```bash
./start_wifi_robot.sh --host-ip 192.168.1.50
```

将 `.certs/lerobot-lan-ca.crt` 导入操作电脑的受信任根证书，然后访问脚本打印的 HTTPS 地址。WSL2 端口转发见 [WSL2 局域网说明](docs/WSL_LAN_ACCESS.md)。

## 常用排查

```bash
# 检查串口
ls /dev/ttyACM* /dev/ttyUSB*

# 查看串口占用
fuser -v /dev/ttyACM0 /dev/ttyACM1

# 检查服务
curl http://localhost:43127/health

# 降低相机负载
CAMERA_FPS=15 CAMERA_WIDTH=640 CAMERA_HEIGHT=360 ./start_robot.sh
```

不要同时运行校准程序、独立机械臂驱动和网页遥操作，它们会争用串口。首次带实机运行时保持低速、小幅动作，并确保 Follower 周围没有障碍物。

## 项目结构

```text
bridge/
  camera_stream.py             USB 相机采集
  dataset_recorder.py          LeRobot Episode 录制
  lerobot_dataset_compat.py    LeRobot 0.4/0.5 兼容层
  dataset_catalog.py           数据集读取与质量扫描
  teleop_mujoco.py             SO-101 串口驱动（保留旧文件名）
frontend/                      Vue 3 网页
robot-server/                  API、WebSocket、WebRTC、录制协调
ros2_ws/                       ROS 2 bridge、launch、配置与测试
scripts/                       依赖安装和证书工具
start_robot.sh                 本机一键启动
start_wifi_robot.sh            局域网 HTTPS 一键启动
```

## 开发验证

```bash
cd frontend && npm run build
cd ../robot-server && npm test
npm run test:data
cd ..

/home/jiang/miniconda3/envs/lerobot/bin/python3 -m unittest \
  bridge.test_dataset_recorder \
  bridge.test_lerobot_dataset_compat

source /opt/ros/humble/setup.bash
cd ros2_ws
colcon build --symlink-install
colcon test --event-handlers console_direct+
colcon test-result --verbose
```
