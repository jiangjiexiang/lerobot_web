#!/bin/bash
# 操作电脑启动脚本
# 用法: ./start_operator.sh

set -e

# 配置
export PYTHON_PATH="${PYTHON_PATH:-python3}"
export LEADER_PORT="${LEADER_PORT:-/dev/ttyACM1}"
export LEADER_ID="${LEADER_ID:-R07253102}"
export FPS="${FPS:-30}"
export PORT="${PORT:-3001}"
export REMOTE_HOST="${REMOTE_HOST:-localhost}"
export REMOTE_PORT="${REMOTE_PORT:-43127}"

echo "=== 操作电脑启动 ==="
echo "Python: $PYTHON_PATH"
echo "Leader 端口: $LEADER_PORT"
echo "Leader ID: $LEADER_ID"
echo "帧率: $FPS"
echo "服务端口: $PORT"
echo "远程机器人电脑: $REMOTE_HOST:$REMOTE_PORT"
echo ""

# 检查 Python 环境
if [ ! -f "$PYTHON_PATH" ]; then
    echo "警告: Python 路径不存在: $PYTHON_PATH"
    echo "请设置 PYTHON_PATH 环境变量指向 lerobot 环境的 Python"
    exit 1
fi

# 检查桥接脚本
BRIDGE_PATH="$(dirname "$0")/bridge/leader_bridge.py"
if [ ! -f "$BRIDGE_PATH" ]; then
    echo "错误: 桥接脚本不存在: $BRIDGE_PATH"
    exit 1
fi

# 启动 operator-server
cd "$(dirname "$0")/operator-server"
npm install --silent 2>/dev/null || true
npm run dev
