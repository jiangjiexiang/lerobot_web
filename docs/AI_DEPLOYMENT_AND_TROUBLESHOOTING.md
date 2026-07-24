# SO-101 LeRobot Web：AI 部署与排错操作手册

> 用法：把本文件、项目目录路径和终端完整日志一起交给 AI。AI 必须先检查再修改；涉及真实机械臂时，必须先让用户确认串口、设备 ID 和急停状态。

## 项目目标

这是一个 SO-101 Leader/Follower 网页遥操作项目。

- 机器人端：`robot-server`、Follower 串口、可选 USB 摄像头
- 前端：Vite HTTPS 开发服务器，默认 `5173`
- 机器人 API：默认端口 `43127`
- 控制 WebSocket：`/ws/control`
- 推流 WebSocket：`/ws/stream`
- MuJoCo：已关闭，不要重新启用或安装其渲染依赖来解决普通部署问题

控制和推流必须分离。控制消息不能和 JPEG 视频帧共用发送队列。

## 部署前检查

在执行启动前运行：

```bash
cd ~/lerobot_web
pwd
git status --short
command -v python3
python3 --version
command -v node
node --version
command -v npm
npm --version
ls -l /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true
ls -l /dev/video* 2>/dev/null || true
```

注意：`PYTHON_PATH=python3` 是合法配置，脚本会用 `command -v` 自动解析，不要因为用户名不同而硬编码 `/home/jiang`。如果用户给出绝对路径，必须确认文件存在且可执行。

## 标准启动

机器人电脑执行：

```bash
cd ~/lerobot_web
bash start_wifi_robot.sh
```

成功时应看到：

```text
Robot Server ... 43127
Vite ... 5173
```

浏览器打开脚本打印的 HTTPS 地址，例如：

```text
https://<机器人电脑局域网IP>:5173
```

首次使用 HTTPS 时，将 `.certs/lerobot-lan-ca.crt` 导入操作电脑的“受信任的根证书颁发机构”。WSL2 环境优先访问 Windows Wi‑Fi IPv4，不要直接使用 WSL 的 `172.*` 地址，除非网络已明确配置支持。

## 启动后验证

在机器人电脑：

```bash
curl -sS http://127.0.0.1:43127/health
ss -ltnp | grep -E ':43127|:5173'
```

在操作电脑：

```bash
curl -k https://<机器人电脑IP>:5173/api/status
nc -vz <机器人电脑IP> 5173
```

后端未监听 `43127` 时，不要继续排查浏览器 WebSocket；先查看启动终端里的 `ts-node`、Node、Python 和端口错误。

## 端口规则

端口只允许通过环境变量覆盖：

```bash
PORT=43127 bash start_wifi_robot.sh
```

如果修改端口，必须同步确认：

1. `start_robot.sh` 的 `PORT`
2. `start_wifi_robot.sh` 的 `PORT`
3. `frontend/vite.config.ts` 的默认代理端口
4. `operator-server` 的 `REMOTE_PORT`
5. WSL/Windows 防火墙和端口转发

不要把 Vite 的 `/api`、`/video`、`/ws` 代理写死到旧端口。Vite 应通过 `process.env.PORT` 读取后端端口。

## WebSocket 排错顺序

浏览器出现以下错误时：

```text
WebSocket connection failed
Invalid frame header
WebSocket 断开，3秒后重连
```

按这个顺序排查：

1. 确认 `curl http://127.0.0.1:43127/health` 成功。
2. 确认 Vite 运行进程是在修改配置后重新启动的；Vite 配置不会自动作用于已存在进程。
3. 确认前端连接的是 `/ws/control` 和 `/ws/stream`，不是旧的 `/ws`。
4. 确认 `vite.config.ts` 的 WebSocket 代理为 `target: ws://localhost:<PORT>` 且 `ws: true`。
5. 确认机器人端显式处理两个 Upgrade 路径。
6. HTTPS 页面必须使用 `wss://`；不要让浏览器从 HTTPS 页面直接连接普通 `ws://` 的局域网地址。
7. 若控制和推流同时失败，优先判断 Vite 代理或后端端口问题；若只有推流失败，再检查摄像头和帧大小。

## 404 排错

- `/favicon.ico` 404：通常只是浏览器图标请求，不影响控制；项目应提供 `/favicon.svg`。
- `/api/ports` 404：检查 Vite 代理是否指向 `43127`，以及后端是否启动。
- `/ws/control` 被返回 HTML：说明请求没有进入 WebSocket Upgrade，检查 Vite 重启、代理目标和后端端口。

## 串口和 Python 排错

先执行：

```bash
command -v python3
python3 --version
ls -l /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true
fuser -v /dev/ttyACM0 /dev/ttyACM1 2>/dev/null || true
```

规则：

- `Python 路径不存在: python3` 表示旧脚本错误地把命令名当文件路径；使用最新 `start_robot.sh`，它支持 PATH 命令名。
- 如果串口被占用，先停止校准程序、旧桥接进程和旧网页服务；不要盲目启动第二个实例。
- Follower 和 Leader 的串口必须根据实际枚举结果填写，不能假设永远是 `ACM0/ACM1`。
- ID 必须与对应机械臂标定文件一致。

## 摄像头排错

摄像头是可选功能，不应影响控制启动。检查：

```bash
ENABLE_CAMERA=0 bash start_wifi_robot.sh
```

如果关闭摄像头后控制恢复，检查 `/dev/video*` 占用、USB 带宽、摄像头索引和 `CAMERA_FPS`。降低帧率：

```bash
CAMERA_FPS=10 bash start_wifi_robot.sh
```

## 构建验证

代码修改后必须执行：

```bash
cd ~/lerobot_web/frontend && npm run build
cd ~/lerobot_web/robot-server && npm run build
cd ~/lerobot_web && python3 -m py_compile bridge/teleop_mujoco.py
```

若 npm 安装失败，先报告网络或 registry 错误，不要删除锁文件。依赖升级必须同时检查 `npm audit` 和构建结果。

## 真实机械臂安全规则

任何 AI 都不得在未确认以下条件时启动真机动作：

1. Follower 周围无障碍物，人员不在危险范围内。
2. 用户知道物理急停位置并已准备好。
3. 串口和 Leader/Follower ID 已确认。
4. 首次测试使用低速、小幅度动作。
5. 网络或浏览器失联时，机器人应停止接受新动作；不能把浏览器重连当作安全机制。

遇到不确定的串口、ID、网络地址、端口转发或急停行为时，AI 必须暂停并向用户询问，不得猜测后驱动机械臂。

