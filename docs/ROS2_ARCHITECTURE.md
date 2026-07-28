# ROS 2 控制架构与接入规范

## 目标

机器人控制以 ROS 2 为唯一稳定边界，网页、LeRobot 和未来厂商驱动都是边界两侧的适配器。项目不会修改 `~/lerobot`；SO-101 驱动仍从已安装的 LeRobot Python 包导入电机总线。

```text
Browser
  │ WebRTC DataChannel（控制/状态/JPEG）或 WebSocket 回退
  ▼
robot-server
  │ stdio JSON（进程隔离）
  ▼
lerobot_web_bridge (ROS 2 / 系统 Python)
  ├── /leader/joint_states                         sensor_msgs/JointState
  ├── /follower/joint_states                       sensor_msgs/JointState
  ├── /camera1/image_raw/compressed                 sensor_msgs/CompressedImage
  ├── /camera2/image_raw/compressed                 sensor_msgs/CompressedImage
  └── /follower/joint_trajectory_controller/
      joint_trajectory                             trajectory_msgs/JointTrajectory
            │
            ├── LeRobot adapter process（SO-101，独立 Python 环境）
            └── 任意厂商 ROS 2 / ros2_control 驱动
```

ROS 2 Humble 的 `rclpy` 和 LeRobot 环境可能使用不同 Python ABI，所以桥接层和硬件层刻意使用两个进程。这样既不修改 LeRobot，也不会让 ROS 的系统 Python 与 Conda 包发生二进制冲突。

## 话题契约

| 默认话题 | 类型 | 方向 | 约束 |
| --- | --- | --- | --- |
| `/leader/joint_states` | `sensor_msgs/msg/JointState` | Leader → 系统 | `name` 与 `position` 必须等长 |
| `/follower/joint_states` | `sensor_msgs/msg/JointState` | Robot → 系统 | 位置使用 ROS 单位（旋转关节为 rad） |
| `/follower/joint_trajectory_controller/joint_trajectory` | `trajectory_msgs/msg/JointTrajectory` | 系统 → Robot | 当前遥操作使用最后一个 point |
| `/camera1/image_raw/compressed` | `sensor_msgs/msg/CompressedImage` | Camera → 系统 | JPEG，必须填写采集时间戳 |
| `/camera2/image_raw/compressed` | `sensor_msgs/msg/CompressedImage` | Camera → 系统 | JPEG，必须填写采集时间戳 |

SO-101 的前五个 LeRobot 角度从 degree 转为 rad。LeRobot 的夹爪 `0..100` 按仓库 URDF 的 `-0.174533..1.74533 rad` 线性转换。ROS 消息中不暴露 LeRobot 的归一化单位。

命令话题名称刻意与 `joint_trajectory_controller` 对齐。支持该控制器的机械臂可以直接订阅；只提供厂商 action/service 的机械臂，应增加一个很薄的厂商适配节点，不要在网页代码里添加品牌判断。长轨迹和 MoveIt 任务应使用该控制器的 `FollowJointTrajectory` action，网页 30/60 Hz 拖动才使用 topic。

## 构建与运行

```bash
cd ~/lerobot_web/ros2_ws
source /opt/ros/humble/setup.bash
colcon build --packages-select lerobot_ros2_bridge
source install/setup.bash
```

正常网页启动已经默认选择 ROS 2 控制后端：

```bash
cd ~/lerobot_web
ROS_DISTRO=humble \
ROS_PYTHON_PATH=/usr/bin/python3 \
LEROBOT_PYTHON_PATH=~/miniconda3/envs/lerobot/bin/python3 \
./start_robot.sh
```

控制源必须唯一：

```bash
# 本地 Leader 串口（网页默认本机模式）
ROS2_COMMAND_SOURCE=leader ./start_robot.sh

# 浏览器 Web Serial / WebRTC DataChannel
ROS2_COMMAND_SOURCE=web ./start_robot.sh

# 只接受 ROS 2 JointTrajectory，不需要 Leader
ROS2_COMMAND_SOURCE=ros ./start_robot.sh
```

命令订阅使用 reliable、keep-last 1，带非零时间戳且超过 `command_timeout` 的轨迹会被拒绝，避免网络恢复后执行积压目标。

查看状态和命令：

```bash
ros2 topic echo /leader/joint_states
ros2 topic echo /follower/joint_states
ros2 topic hz /follower/joint_states
```

用 ROS 2 话题发送一帧 SO-101 目标（顺序可变，名称必须齐全）：

```bash
ros2 topic pub --once \
  /follower/joint_trajectory_controller/joint_trajectory \
  trajectory_msgs/msg/JointTrajectory \
  "{joint_names: [shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper], points: [{positions: [0.0, 0.0, 0.0, 0.0, 0.0, -0.174533], time_from_start: {sec: 0, nanosec: 50000000}}]}"
```

执行真实机器人命令前应架空或清空工作区，并准备物理急停。外部命令超过 `command_timeout` 后，SO-101 适配器不再写入新目标并保持当前位置。

## 接入其他机械臂

优先顺序：

1. 厂商已有 `ros2_control`：复用其 hardware plugin 和 `joint_trajectory_controller`，将话题 remap 到本规范。
2. 厂商已有 ROS 2 驱动：写一个 `JointTrajectory` → 厂商 action/service 的适配节点，同时把厂商状态转为 `JointState`。
3. 只有 SDK：实现独立驱动节点；硬件 SDK 不应进入 `robot-server` 或前端。

运行网页桥而不启动 LeRobot 串口驱动：

```bash
CONTROL_BACKEND=ros2 ROS2_DRIVER=external ./start_robot.sh
```

`external` 模式下，桥只连接上述 ROS 2 话题，并原样转发任意 `JointState` 的关节名称和 rad 位置，本地 ROS Leader 的名称/位置也会原样组成 `JointTrajectory`。不同关节数已经能在网页状态表动态显示。非 SO-101 的网页主动命令应带 `units: "ros"`；控制配置、关节限制和 URDF 应由后续的 robot profile 提供，不能假设所有机械臂都是 SO-101 六关节布局。

数据采集同样不写死 SO-101：第一组完整的 Leader action 与 Follower state 决定 LeRobotDataset 的关节名称和顺序，续录时会验证 schema。两路 JPEG 相机和关节数据由 Robot Server 按录制 FPS 采样，并在写入前执行新鲜度及双相机时间偏差检查。

采集桥使用 `message_filters.ApproximateTimeSynchronizer` 按四路消息的 `header.stamp` 对齐 Leader、Follower 和两路相机。原始五类 ROS2 话题同时由 rosbag2 保存到 `DATASET_ROOT/.lerobot-web/raw-bags/<数据集>/`，用于故障恢复、重放和未来重新生成 LeRobotDataset。bag 使用专用 QoS override，让 JointState/CompressedImage 的 Best-Effort 发布端能被可靠记录。安装 `ros-humble-rosbag2-storage-mcap` 后使用 MCAP；未安装时可回退 sqlite3。

LeRobot 仍位于独立 Python 进程。`bridge/lerobot_dataset_compat.py` 隔离 0.4 的构造器/图片写入器 API和 0.5+ 的 `resume`、`DatasetWriter`、`finalize` 与流式编码 API，切换 LeRobot 版本不影响 ROS2 话题契约。

## 安全边界

- 每个硬件适配器必须实现命令新鲜度检查；只收到一次目标后不能无限继续运动。
- 急停应有独立的硬件链路。软件急停只能作为补充。
- 驱动必须执行关节限位、速度/加速度限制和 NaN/缺关节拒绝。
- 同一组 command interface 同时只能有一个控制者；使用 `ros2_control` controller manager 做资源仲裁。
- DDS 不应直接暴露到公网。跨网访问放在鉴权后的网关或 VPN 后。
