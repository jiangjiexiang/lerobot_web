#!/bin/bash
# 遥操作与数据平台一键启动（Robot Server + Vite）
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
export CONTROL_BACKEND="${CONTROL_BACKEND:-ros2}"
export ROS2_DRIVER="${ROS2_DRIVER:-lerobot}"
export ROS2_COMMAND_SOURCE="${ROS2_COMMAND_SOURCE:-}"
export ROS_DISTRO="${ROS_DISTRO:-humble}"
export ROS_PYTHON_PATH="${ROS_PYTHON_PATH:-/usr/bin/python3}"
export PORT="${PORT:-43127}"
export ENABLE_CAMERA="${ENABLE_CAMERA:-1}"
export CAMERA_FPS="${CAMERA_FPS:-30}"
export CAMERA_WIDTH="${CAMERA_WIDTH:-640}"
export CAMERA_HEIGHT="${CAMERA_HEIGHT:-360}"
export STREAM_FPS="${STREAM_FPS:-0}"
HTTPS_CERT="${HTTPS_CERT:-}"
HTTPS_KEY="${HTTPS_KEY:-}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"

echo "=== 遥操作与数据平台一键启动 ==="
echo "Python: $PYTHON_PATH"
if [ "$CONTROL_BACKEND" = "ros2" ]; then
    echo "控制后端: ros2 / $ROS2_DRIVER${ROS2_COMMAND_SOURCE:+ / $ROS2_COMMAND_SOURCE}"
else
    echo "控制后端: legacy"
fi
echo "摄像头: 自动检测 USB 摄像头 (MJPG ${CAMERA_WIDTH}x${CAMERA_HEIGHT}@$CAMERA_FPS FPS)"

# 清理上次异常退出后仍占用服务端口的进程。
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "错误: PORT 必须是 1-65535 之间的整数: $PORT"
    exit 1
fi
if ! [[ "$FRONTEND_PORT" =~ ^[0-9]+$ ]] || [ "$FRONTEND_PORT" -lt 1 ] || [ "$FRONTEND_PORT" -gt 65535 ]; then
    echo "错误: FRONTEND_PORT 必须是 1-65535 之间的整数: $FRONTEND_PORT"
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

# LeRobot、摄像头或旧后端需要通用 Python；纯 external ROS 2 模式可不依赖 LeRobot 环境。
NEEDS_APP_PYTHON=0
if [ "$CONTROL_BACKEND" = "legacy" ] || [ "$ROS2_DRIVER" = "lerobot" ] || [ "$ENABLE_CAMERA" != "0" ]; then
    NEEDS_APP_PYTHON=1
fi
if [ "$NEEDS_APP_PYTHON" -eq 1 ] && [[ "$PYTHON_PATH" == */* ]]; then
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
    if ! "$PYTHON_PATH" -c "import cv2, numpy; from lerobot.datasets.lerobot_dataset import LeRobotDataset" >/dev/null 2>&1; then
        echo "错误: $PYTHON_PATH 缺少摄像头或 LeRobotDataset 采集依赖"
        echo "请在 LeRobot 环境安装项目与机械臂依赖，例如:"
        echo "  $PYTHON_PATH -m pip install -e '/home/jiang/lerobot[feetech]'"
        exit 1
    fi
fi
if [ "$ROS2_DRIVER" = "lerobot" ]; then
    if ! "$LEROBOT_PYTHON_PATH" -c "import scservo_sdk; from lerobot.motors.feetech import FeetechMotorsBus" >/dev/null 2>&1; then
        echo "错误: $LEROBOT_PYTHON_PATH 缺少 LeRobot Feetech 电机依赖"
        exit 1
    fi
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

if [ "$CONTROL_BACKEND" = "ros2" ]; then
    ROS_SETUP="/opt/ros/$ROS_DISTRO/setup.bash"
    if [ ! -f "$ROS_SETUP" ]; then
        echo "错误: 找不到 ROS 2 环境: $ROS_SETUP"
        exit 1
    fi
    # ROS 2 Humble 的 rclpy 必须由它对应的系统 Python 运行；LeRobot 仍由上面的独立环境运行。
    source "$ROS_SETUP"
    if ! "$ROS_PYTHON_PATH" -c "import rclpy, sensor_msgs, trajectory_msgs" >/dev/null 2>&1; then
        echo "错误: $ROS_PYTHON_PATH 无法导入 ROS 2 Python 包"
        echo "请确认 ROS_DISTRO=$ROS_DISTRO 与 ROS_PYTHON_PATH 匹配"
        exit 1
    fi
fi

# 安装依赖
if [ ! -d "$DIR/robot-server/node_modules" ]; then
    echo "[1/4] 安装 robot-server 依赖..."
    cd "$DIR/robot-server" && npm install
fi
if [ ! -d "$DIR/frontend/node_modules" ]; then
    echo "[2/4] 安装 frontend 依赖..."
    cd "$DIR/frontend" && npm install
fi

# 修复 .bin 执行权限 (WSL2 常见问题)
chmod +x "$DIR/robot-server/node_modules/.bin/"* 2>/dev/null || true
chmod +x "$DIR/frontend/node_modules/.bin/"* 2>/dev/null || true

# Robot Server 会直接提供构建后的前端，本机模式不再依赖额外的 5173 代理。
echo "[3/4] 构建 frontend..."
cd "$DIR/frontend"
npm run build

# 后台启动 robot-server
echo "[4/4] 启动 robot-server (端口 $PORT)..."
cd "$DIR/robot-server"
npm run dev &
BACKEND_PID=$!

cleanup() {
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 等待后端就绪
echo -n "      等待后端就绪"
for i in $(seq 1 20); do
    if curl --noproxy "*" -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
        echo " OK"
        break
    fi
    echo -n "."
    sleep 1
    if [ $i -eq 20 ]; then
        echo " 超时"
        kill $BACKEND_PID 2>/dev/null
        exit 1
    fi
done

# 清理失效或遗留的 Vite 进程，确保页面固定使用 FRONTEND_PORT。
FRONTEND_PIDS="$(lsof -t -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$FRONTEND_PIDS" ]; then
    echo "清理端口 $FRONTEND_PORT 上的旧前端进程: $FRONTEND_PIDS"
    kill $FRONTEND_PIDS 2>/dev/null || true
    for _ in $(seq 1 20); do
        if ! lsof -t -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
        sleep 0.1
    done
    FRONTEND_PIDS="$(lsof -t -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$FRONTEND_PIDS" ]; then
        echo "旧前端进程未正常退出，强制清理: $FRONTEND_PIDS"
        kill -9 $FRONTEND_PIDS 2>/dev/null || true
    fi
fi

echo ""
echo "========================================"
echo "  浏览器打开: $WEB_SCHEME://localhost:$FRONTEND_PORT"
echo "  API 服务:   http://localhost:$PORT"
echo "  Ctrl+C 退出"
echo "========================================"
echo ""

cd "$DIR/frontend"
npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort
