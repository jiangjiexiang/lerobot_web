#!/bin/bash
# SO-101 遥操作一键启动 (robot-server + Vite 前端)
# 用法: ./start_robot.sh

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHON_PATH="${PYTHON_PATH:-/home/jiang/miniconda3/envs/lerobot/bin/python}"
export PORT="${PORT:-3000}"
export REMOTE_CONTROL_TOKEN="${REMOTE_CONTROL_TOKEN:-}"
HTTPS_CERT="${HTTPS_CERT:-}"
HTTPS_KEY="${HTTPS_KEY:-}"

echo "=== SO-101 遥操作一键启动 ==="
echo "Python: $PYTHON_PATH"
if [ -z "$REMOTE_CONTROL_TOKEN" ]; then
    echo "提示: 未设置 REMOTE_CONTROL_TOKEN，浏览器 Web Serial 远程模式将被拒绝。"
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

# 检查 Python
if [ ! -f "$PYTHON_PATH" ]; then
    echo "错误: Python 路径不存在: $PYTHON_PATH"
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

# 后台启动 robot-server
echo "[3/4] 启动 robot-server (端口 $PORT)..."
cd "$DIR/robot-server"
npm run dev &
BACKEND_PID=$!

# 等待后端就绪
echo -n "      等待后端就绪"
for i in $(seq 1 20); do
    if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
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

# 前台启动 Vite (Ctrl+C 退出时同时关后端)
echo "[4/4] 启动 Vite 前端 (端口 5173)..."
echo ""
echo "========================================"
echo "  浏览器打开: $WEB_SCHEME://localhost:5173"
echo "  API 服务:   http://localhost:$PORT"
echo "  Ctrl+C 退出"
echo "========================================"
echo ""

cd "$DIR/frontend"
trap "kill $BACKEND_PID 2>/dev/null; exit 0" INT TERM
npm run dev
