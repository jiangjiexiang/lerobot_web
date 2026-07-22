#!/usr/bin/env bash
# 为局域网控制台生成私有 CA 与含 IP SAN 的 HTTPS 证书。
# 用法：./scripts/generate-lan-cert.sh 192.168.1.50
set -euo pipefail

LAN_IP="${1:-}"
if [[ -z "$LAN_IP" ]]; then
  echo "用法: $0 <机器人电脑的局域网 IPv4 地址>"
  exit 1
fi

if ! [[ "$LAN_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "错误：'$LAN_IP' 不是 IPv4 地址。"
  exit 1
fi

CERT_DIR="${CERT_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.certs}"
mkdir -p "$CERT_DIR"

if [[ ! -f "$CERT_DIR/lerobot-lan-ca.key" ]]; then
  openssl genrsa -out "$CERT_DIR/lerobot-lan-ca.key" 4096
  openssl req -x509 -new -nodes -key "$CERT_DIR/lerobot-lan-ca.key" -sha256 -days 3650 \
    -subj "/CN=LeRobot LAN Development CA" \
    -out "$CERT_DIR/lerobot-lan-ca.crt"
fi

openssl genrsa -out "$CERT_DIR/lerobot-lan.key" 2048
openssl req -new -key "$CERT_DIR/lerobot-lan.key" -subj "/CN=$LAN_IP" -out "$CERT_DIR/lerobot-lan.csr"
cat > "$CERT_DIR/lan-ext.cnf" <<EOF
subjectAltName = IP:$LAN_IP
extendedKeyUsage = serverAuth
keyUsage = digitalSignature,keyEncipherment
EOF
openssl x509 -req -in "$CERT_DIR/lerobot-lan.csr" \
  -CA "$CERT_DIR/lerobot-lan-ca.crt" -CAkey "$CERT_DIR/lerobot-lan-ca.key" -CAcreateserial \
  -out "$CERT_DIR/lerobot-lan.crt" -days 825 -sha256 -extfile "$CERT_DIR/lan-ext.cnf"
rm -f "$CERT_DIR/lerobot-lan.csr" "$CERT_DIR/lan-ext.cnf"

echo "已生成：$CERT_DIR/lerobot-lan.crt"
echo "请仅将 $CERT_DIR/lerobot-lan-ca.crt 导入操作电脑的‘受信任的根证书颁发机构’。"
echo "启动：HTTPS_CERT=$CERT_DIR/lerobot-lan.crt HTTPS_KEY=$CERT_DIR/lerobot-lan.key ./start_robot.sh"
