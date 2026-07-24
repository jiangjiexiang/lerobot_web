# WSL2 局域网访问控制台

如果 Robot Server 与 Vite 运行在 WSL2 默认 NAT 网络中，另一台电脑通常不能直接访问 WSL 的 `172.*` 地址。操作电脑应访问 **Windows 主机的 Wi‑Fi IPv4 地址**，并将 Windows 的 5173/TCP 转发至 WSL。

浏览器访问的唯一端口是 5173：Vite 会在 WSL 内把 `/api`、`/video` 和 `/ws` 代理到 Robot Server 43127。因此通常不必把 43127 暴露到局域网；只有操作端直接访问 Robot API 时才需要转发该端口。

## 1. 获取地址

在 Windows PowerShell 中获取 Windows 的 Wi‑Fi IPv4（示例为 `192.168.1.50`）：

```powershell
ipconfig
```

在 WSL 中获取当前 WSL IPv4：

```bash
hostname -I
```

不要用 WSL 的 `172.*` 地址作为操作电脑浏览器地址或证书 SAN；应使用 Windows 的 Wi‑Fi IPv4。

## 2. 生成与 Windows 地址匹配的证书

在 WSL 项目目录：

```bash
./scripts/generate-lan-cert.sh 192.168.1.50
```

把 `.certs/lerobot-lan-ca.crt` 导入操作电脑的 Windows“受信任的根证书颁发机构”。

## 3. 配置 Windows 端口转发

以**管理员身份**打开 Windows PowerShell，以下命令中的 WSL IP 必须替换为 `hostname -I` 显示的第一个地址：

```powershell
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=172.20.67.188 connectport=5173
New-NetFirewallRule -DisplayName "LeRobot Web HTTPS" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173
```

检查规则：

```powershell
netsh interface portproxy show v4tov4
```

WSL 重启后 IP 可能变化；若操作网页无法访问，先重新运行 `hostname -I`，删除旧规则并按新地址添加：

```powershell
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5173
```

## 4. 启动与验证

WSL 中启动：

```bash
HTTPS_CERT="$PWD/.certs/lerobot-lan.crt" \
HTTPS_KEY="$PWD/.certs/lerobot-lan.key" \
./start_robot.sh
```

操作电脑 Chrome/Edge 打开：

```text
https://192.168.1.50:5173
```

若可以打开页面但“连接 Leader COM”提示不支持，检查访问地址是否为 HTTPS、证书是否已被信任，以及浏览器是否为 Chrome/Edge。

> 若已启用 WSL 的 mirrored networking，并确认局域网可以直接访问 WSL 监听端口，则可能不需要 `portproxy`。仍应只放行可信 Wi‑Fi 网段。
