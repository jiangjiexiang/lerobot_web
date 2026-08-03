# LeRobot Web · 轻量数据采集平台

这是一个直接连接 SO-101 Leader/Follower 和双 USB 摄像头的机械臂数据采集与管理网页，不依赖 ROS 2。项目不会修改 LeRobot 源码；LeRobot 仅作为独立 Python 环境中的硬件与 Dataset 依赖。

当前验收范围是：

- 网页遥操作与双路摄像头预览
- LeRobot Dataset 录制、追加 Episode 和视频编码
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
      ├─ serial bridge ── 直连串口 ── 机械臂驱动
      ├─ camera_stream ── USB 摄像头
      └─ dataset_recorder ── LeRobot Dataset
```

## 一键启动

项目有一键启动脚本：

```bash
cd ~/lerobot_web
./start_robot.sh
```

脚本会完成以下操作：

1. 检查 LeRobot Python、Node.js 和采集依赖。
2. 首次运行时安装前后端 npm 依赖。
3. 在服务端源码变化时自动增量构建。
4. 自动生成或复用局域网 HTTPS 证书。
5. 启动直接托管网页、API 和 WebSocket 的 Robot Server。
6. 在退出时回收本次启动的进程。

Robot Server 启动后会自动检测并启动 USB 摄像头；启动遥操作后才连接机械臂串口。

默认地址：

- 网页：脚本打印的 `https://<局域网IP>:43127`
- Robot API：`https://localhost:43127`
- 数据管理：`https://<局域网IP>:43127/#datasets`

首次启动后，将 `.certs/lerobot-lan-ca.crt` 导入访问网页设备的受信任根证书。若自动检测的局域网 IP 不正确，可使用 `HTTPS_HOST=192.168.1.36 ./start_robot.sh`；临时使用 HTTP 可设置 `AUTO_HTTPS=0`。

日常启动会复用前后端构建缓存；前端源码变化时会自动重新构建生产资源。

首次部署需要先执行一次：

```bash
/home/jiang/miniconda3/envs/lerobot/bin/python3 \
  -m pip install -e '/home/jiang/lerobot[feetech]'
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

使用默认直连串口后端：

```bash
./start_robot.sh
```

网页中选择两个串口和两路摄像头，启动遥操作，确认关节和画面持续更新后即可开始录制。

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

```

同名 Dataset 只有在 FPS、相机分辨率、关节名称和顺序一致时才会追加。录制器兼容 LeRobot 0.4 与 0.5+；兼容逻辑封装在本项目内，不修改 LeRobot。

采集相关环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RECORDING_MAX_SENSOR_AGE_MS` | `250` | 允许的最大传感器数据年龄 |
| `RECORDING_MAX_CAMERA_SKEW_MS` | `100` | 两路相机最大时间差 |
| `DATASET_STREAMING_ENCODING` | `auto` | LeRobot 0.5+ 实时视频编码策略 |
| `DATASET_VIDEO_CODEC` | `auto` | 视频编码器 |

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

浏览器 Web Serial 必须运行在安全上下文。`start_robot.sh` 默认自动检测局域网 IP、生成证书并启用 HTTPS：

```bash
./start_robot.sh
```

如需明确指定访问 IP：

```bash
HTTPS_HOST=192.168.1.50 ./start_robot.sh
```

将 `.certs/lerobot-lan-ca.crt` 导入操作电脑的受信任根证书，然后访问脚本打印的 HTTPS 地址。`start_wifi_robot.sh --host-ip 192.168.1.50` 仍可使用。WSL2 端口转发见 [WSL2 局域网说明](docs/WSL_LAN_ACCESS.md)。

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

Jetson 默认采用混合低延迟模式：控制与状态走 WebRTC DataChannel，视频保持摄像头
原生 MJPEG 并通过只保留最新帧的视频通道发送，避免 MJPEG → I420 → VP8 的二次
软件转码。需要在性能更强的平台测试纯 WebRTC 视频时可开启：

```bash
ENABLE_WEBRTC_VIDEO=1 RTC_VIDEO_FPS=15 RTC_VIDEO_BITRATE=1500000 ./start_robot.sh
```

不要同时运行校准程序、独立机械臂驱动和网页遥操作，它们会争用串口。首次带实机运行时保持低速、小幅动作，并确保 Follower 周围没有障碍物。

## 项目结构

```text
bridge/
  camera_stream.py             旧版 OpenCV USB 相机采集（兼容保留）
  dataset_recorder.py          LeRobot Episode 录制
  lerobot_dataset_compat.py    LeRobot 0.4/0.5 兼容层
  dataset_catalog.py           数据集读取与质量扫描
  teleop_robot.py              SO-101 串口驱动
frontend/                      Vue 3 网页
robot-server/                  API、WebSocket、WebRTC、录制协调
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
```
