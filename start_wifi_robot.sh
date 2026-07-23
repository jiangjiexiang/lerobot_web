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

if [[ -z "$HOST_IP" ]] && command -v powershell.exe >/dev/null 2>&1; then
  # 在 Windows 默认路由所在网卡上取 IPv4；比解析本地化的 ipconfig 输出更稳定。
  HOST_IP="$(powershell.exe -NoProfile -Command '$route=Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1; Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike "169.254*"} | Select-Object -First 1 -ExpandProperty IPAddress' 2>/dev/null | tr -d '\r')"
fi

if ! [[ "$HOST_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "错误：无法自动检测 Windows Wi-Fi IPv4。请使用：$0 --host-ip 192.168.1.50" >&2
  exit 2
fi

WSL_IP="$(hostname -I | awk '{print $1}')"
CERT_DIR="$ROOT_DIR/.certs"

if [[ ! -f "$CERT_DIR/lerobot-lan.crt" || ! -f "$CERT_DIR/lerobot-lan.key" ]]; then
  "$ROOT_DIR/scripts/generate-lan-cert.sh" "$HOST_IP"
fi

umask 077
cat > "$ROOT_DIR/.wifi-teleop.env" <<EOF
# 自动生成；勿提交、勿发送给他人。
ROBOT_HOST_IP=$HOST_IP
WSL_IP=$WSL_IP
EOF

echo ""
echo "=== Wi-Fi 遥操作机器人端已就绪 ==="
echo "操作电脑网页: https://$HOST_IP:5173"
echo "WSL IP: $WSL_IP"
echo ""
echo "若 Windows 尚未配置端口转发，请以管理员身份运行："
echo "  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=$WSL_IP connectport=5173"
echo "  New-NetFirewallRule -DisplayName 'LeRobot Web HTTPS' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173"
echo ""
echo "将以下根证书导入操作电脑的‘受信任的根证书颁发机构’："
echo "  $CERT_DIR/lerobot-lan-ca.crt"
echo ""

export HTTPS_CERT="$CERT_DIR/lerobot-lan.crt"
export HTTPS_KEY="$CERT_DIR/lerobot-lan.key"
exec "$ROOT_DIR/start_robot.sh"
