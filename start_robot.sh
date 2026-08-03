#!/usr/bin/env bash
# 轻量遥操作、数据采集与数据管理一键启动（Robot Server）
# 用法: ./start_robot.sh

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${PYTHON_PATH:-}" ]; then
    if [ -x "/home/jiang/miniconda3/envs/lerobot/bin/python3" ]; then
        PYTHON_PATH="/home/jiang/miniconda3/envs/lerobot/bin/python3"
    elif [ -x "/home/nvidia/miniconda3/envs/lerobot/bin/python3" ]; then
        PYTHON_PATH="/home/nvidia/miniconda3/envs/lerobot/bin/python3"
    elif [ -n "${CONDA_PREFIX:-}" ] && [ -x "$CONDA_PREFIX/bin/python3" ]; then
        PYTHON_PATH="$CONDA_PREFIX/bin/python3"
    else
        PYTHON_PATH="$(command -v python3 || true)"
    fi
fi
export PYTHON_PATH
export LEROBOT_PYTHON_PATH="${LEROBOT_PYTHON_PATH:-$PYTHON_PATH}"
export PORT="${PORT:-5173}"
export ENABLE_CAMERA="${ENABLE_CAMERA:-1}"
export CAMERA_FPS="${CAMERA_FPS:-30}"
export CAMERA_WIDTH="${CAMERA_WIDTH:-1280}"
export CAMERA_HEIGHT="${CAMERA_HEIGHT:-720}"
export CONTROL_OBSERVATION_FPS="${CONTROL_OBSERVATION_FPS:-30}"
export RTC_VIDEO_FPS="${RTC_VIDEO_FPS:-15}"
export RTC_VIDEO_BITRATE="${RTC_VIDEO_BITRATE:-1500000}"
export RTC_CONTROL_TIMEOUT_MS="${RTC_CONTROL_TIMEOUT_MS:-2000}"
export ENABLE_WEBRTC_VIDEO="${ENABLE_WEBRTC_VIDEO:-0}"
HTTPS_CERT="${HTTPS_CERT:-}"
HTTPS_KEY="${HTTPS_KEY:-}"
AUTO_HTTPS="${AUTO_HTTPS:-1}"
HTTPS_HOST="${HTTPS_HOST:-}"

echo "=== 机器人数据采集平台一键启动 ==="
echo "Python 环境: 已就绪"
echo "控制后端: 直连串口"
if [ "$ENABLE_CAMERA" = "0" ]; then
    echo "摄像头: 已关闭"
else
    echo "摄像头: 自动检测 USB 摄像头 (GStreamer MJPG ${CAMERA_WIDTH}x${CAMERA_HEIGHT}@$CAMERA_FPS FPS)"
fi

# 清理上次异常退出后仍占用服务端口的进程。
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "错误: PORT 必须是 1-65535 之间的整数: $PORT"
    exit 1
fi

PORT_PIDS="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$PORT_PIDS" ]; then
    echo "清理端口 $PORT 上的旧进程: $PORT_PIDS"
    kill $PORT_PIDS 2>/dev/null || true

    for _ in $(seq 1 20); do
        if ! lsof -t -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
            break
        fi
        sleep 0.1
    done

    PORT_PIDS="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$PORT_PIDS" ]; then
        echo "旧进程未正常退出，强制清理: $PORT_PIDS"
        kill -9 $PORT_PIDS 2>/dev/null || true
    fi
fi

if [ -z "$HTTPS_CERT" ] && [ -z "$HTTPS_KEY" ] && [ "$AUTO_HTTPS" != "0" ]; then
    if [ -z "$HTTPS_HOST" ]; then
        HTTPS_HOST="$(hostname -I 2>/dev/null | awk '{
            for (i = 1; i <= NF; i++) if ($i ~ /^192\.168\./) { print $i; exit }
            for (i = 1; i <= NF; i++) if ($i ~ /^172\.(1[6-9]|2[0-9]|3[01])\./) { print $i; exit }
            for (i = 1; i <= NF; i++) if ($i ~ /^10\./) { print $i; exit }
            for (i = 1; i <= NF; i++) if ($i !~ /^127\./ && $i !~ /:/) { print $i; exit }
        }')"
    fi
    if [ -z "$HTTPS_HOST" ]; then
        HTTPS_HOST="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
    fi
    if ! [[ "$HTTPS_HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        echo "错误: 无法自动检测用于 HTTPS 的局域网 IPv4"
        echo "请指定地址后重试: HTTPS_HOST=192.168.1.36 ./start_robot.sh"
        echo "或临时使用 HTTP: AUTO_HTTPS=0 ./start_robot.sh"
        exit 1
    fi

    CERT_DIR="$DIR/.certs"
    HTTPS_CERT="$CERT_DIR/robot-lan.crt"
    HTTPS_KEY="$CERT_DIR/robot-lan.key"
    if [ ! -f "$HTTPS_CERT" ] || [ ! -f "$HTTPS_KEY" ] \
        || ! openssl x509 -in "$HTTPS_CERT" -noout -checkip "$HTTPS_HOST" >/dev/null 2>&1; then
        echo "正在为 $HTTPS_HOST 生成局域网 HTTPS 证书..."
        "$DIR/scripts/generate-lan-cert.sh" "$HTTPS_HOST"
    fi
fi

if [ -n "$HTTPS_CERT" ] || [ -n "$HTTPS_KEY" ]; then
    if [ ! -f "$HTTPS_CERT" ] || [ ! -f "$HTTPS_KEY" ]; then
        echo "错误: HTTPS_CERT 或 HTTPS_KEY 文件不存在"
        exit 1
    fi
    export HTTPS_CERT HTTPS_KEY
    WEB_SCHEME="https"
else
    WEB_SCHEME="http"
fi
echo ""

# 串口控制、录制与摄像头都使用项目 Python 环境。
if [[ "$PYTHON_PATH" == */* ]]; then
    if [ ! -f "$PYTHON_PATH" ] || [ ! -x "$PYTHON_PATH" ]; then
        echo "错误: Python 可执行文件不存在或不可执行: $PYTHON_PATH"
        exit 1
    fi
elif [ "$NEEDS_APP_PYTHON" -eq 1 ]; then
    if ! command -v "$PYTHON_PATH" >/dev/null 2>&1; then
        echo "错误: PATH 中找不到 Python 命令: $PYTHON_PATH"
        echo "当前 PATH: $PATH"
        exit 1
    fi
    PYTHON_PATH="$(command -v "$PYTHON_PATH")"
    export PYTHON_PATH
fi

if [ "$ENABLE_CAMERA" != "0" ]; then
    if ! command -v gst-launch-1.0 >/dev/null 2>&1 \
        || ! gst-inspect-1.0 v4l2src fdsink >/dev/null 2>&1; then
        echo "错误: 缺少 GStreamer 摄像头运行时或 v4l2src/fdsink 插件"
        echo "请安装: sudo apt install gstreamer1.0-tools gstreamer1.0-plugins-good"
        exit 1
    fi
    if ! "$PYTHON_PATH" -c "from lerobot.datasets.lerobot_dataset import LeRobotDataset" >/dev/null 2>&1; then
        echo "错误: Python 环境缺少采集数据依赖"
        echo "请安装项目与机械臂依赖后重试。"
        exit 1
    fi
fi
if ! "$LEROBOT_PYTHON_PATH" -c "import scservo_sdk; from lerobot.motors.feetech import FeetechMotorsBus" >/dev/null 2>&1; then
    echo "错误: Python 环境缺少 Feetech 电机依赖"
    exit 1
fi

# 检查 Node.js 版本
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo "0")
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "错误: Node.js 版本过低 (v$NODE_MAJOR), 需要 v18+"
    echo "请安装新版 Node.js:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt install -y nodejs"
    exit 1
fi

# 安装依赖
if [ ! -d "$DIR/robot-server/node_modules" ]; then
    echo "安装 robot-server 依赖..."
    cd "$DIR/robot-server" && npm install
    chmod +x "$DIR/robot-server/node_modules/.bin/"* 2>/dev/null || true
fi
if [ ! -d "$DIR/frontend/node_modules" ]; then
    echo "安装 frontend 依赖..."
    cd "$DIR/frontend" && npm install
    chmod +x "$DIR/frontend/node_modules/.bin/"* 2>/dev/null || true
fi

# 生产模式直接由 Robot Server 托管前端，避免 Vite 代理视频造成 CPU 和网络队列抖动。
FRONTEND_OUTPUT="$DIR/frontend/dist/index.html"
if [ ! -f "$FRONTEND_OUTPUT" ] \
    || [ "$DIR/frontend/vite.config.ts" -nt "$FRONTEND_OUTPUT" ] \
    || find "$DIR/frontend/src" -type f -newer "$FRONTEND_OUTPUT" -print -quit | grep -q .; then
    echo "前端源码有更新，正在构建生产资源..."
    cd "$DIR/frontend"
    npm run build
fi

# 日常启动直接运行编译后的服务端；仅源文件变化时重新构建。
BACKEND_OUTPUT="$DIR/robot-server/dist/index.js"
BACKEND_NEEDS_BUILD=0
if [ ! -f "$BACKEND_OUTPUT" ] \
    || [ "$DIR/robot-server/tsconfig.json" -nt "$BACKEND_OUTPUT" ] \
    || find "$DIR/robot-server/src" -type f -newer "$BACKEND_OUTPUT" -print -quit | grep -q .; then
    BACKEND_NEEDS_BUILD=1
fi
if [ "$BACKEND_NEEDS_BUILD" -eq 1 ]; then
    echo "服务端源码有更新，正在构建..."
    cd "$DIR/robot-server"
    npm run build
fi

# 后台启动 robot-server
echo "启动 robot-server (端口 $PORT)..."
node "$BACKEND_OUTPUT" &
BACKEND_PID=$!

cleanup() {
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 等待后端就绪
echo -n "      等待后端就绪"
for i in $(seq 1 80); do
    if curl --noproxy "*" --connect-timeout 0.1 --max-time 0.2 -k -s "$WEB_SCHEME://localhost:$PORT/health" > /dev/null 2>&1; then
        echo " OK"
        break
    fi
    if [ $((i % 10)) -eq 0 ]; then echo -n "."; fi
    sleep 0.05
    if [ "$i" -eq 80 ]; then
        echo " 超时"
        kill $BACKEND_PID 2>/dev/null
        exit 1
    fi
done

echo ""
echo "========================================"
if [ -n "$HTTPS_HOST" ]; then
    echo "  浏览器打开: $WEB_SCHEME://$HTTPS_HOST:$PORT"
else
    echo "  浏览器打开: $WEB_SCHEME://localhost:$PORT"
fi
echo "  API 服务:   $WEB_SCHEME://localhost:$PORT"
echo "  Ctrl+C 退出"
echo "========================================"
echo ""

wait "$BACKEND_PID"
