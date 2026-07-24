#!/usr/bin/env bash
# 双电脑 Wi-Fi 遥操作：机器人电脑一键准备 HTTPS 并启动服务。
# 用法：./start_wifi_robot.sh [--host-ip 192.168.1.50]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_IP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host-ip)
      HOST_IP="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "用法: $0 [--host-ip <Windows Wi-Fi IPv4>]"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$HOST_IP" ]]; then
  HOST_IP="$(hostname -I | awk '{print $1}')"
fi

if ! [[ "$HOST_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "错误：无法自动检测本机 IPv4。请使用：$0 --host-ip 192.168.1.50" >&2
  exit 2
fi
CERT_DIR="$ROOT_DIR/.certs"

if [[ ! -f "$CERT_DIR/lerobot-lan.crt" || ! -f "$CERT_DIR/lerobot-lan.key" ]]; then
  "$ROOT_DIR/scripts/generate-lan-cert.sh" "$HOST_IP"
fi

umask 077
echo ""
echo "=== 遥操作机器人端已就绪 ==="
echo "操作电脑网页: https://$HOST_IP:5173"
echo ""
echo "将以下根证书导入操作电脑的‘受信任的根证书颁发机构’："
echo "  $CERT_DIR/lerobot-lan-ca.crt"
echo ""

export HTTPS_CERT="$CERT_DIR/lerobot-lan.crt"
export HTTPS_KEY="$CERT_DIR/lerobot-lan.key"
export PORT="${PORT:-4000}"
exec "$ROOT_DIR/start_robot.sh"
