#!/usr/bin/env python3
"""
SO-101 Web 遥操作控制台 - 单文件实现
启动: /home/jiang/miniconda3/envs/lerobot/bin/python web_teleop.py
访问: http://localhost:8080
"""

import asyncio
import glob
import json
import logging
import os
import subprocess
import sys
import time
from aiohttp import web, WSMsgType

logging.basicConfig(level=logging.INFO, format="[Web] %(message)s")
logger = logging.getLogger(__name__)

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON_PATH = "/home/jiang/miniconda3/envs/lerobot/bin/python"
TELEOP_SCRIPT = os.path.join(BRIDGE_DIR, "teleop_mujoco.py")

state = {
    "process": None,
    "running": False,
    "clients": set(),
}


def detect_serial_ports():
    return sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*"))


# ===================== HTML 前端页面 =====================
HTML_PAGE = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SO-101 遥操作控制台</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#0f0f23;color:#eee;min-height:100vh}
.header{background:#1a1a3e;padding:12px 24px;display:flex;align-items:center;gap:12px}
.header h1{font-size:18px;color:#e94560}
.dot{width:10px;height:10px;border-radius:50%;background:#555;transition:all .3s}
.dot.on{background:#4caf50;box-shadow:0 0 8px #4caf50}
.main{display:flex;gap:16px;padding:16px;flex-wrap:wrap}
.panel{background:#1a1a3e;border-radius:10px;padding:16px}
.ctrl{flex:0 0 320px}
.view{flex:1;min-width:420px}
.joints{flex:0 0 300px}
.panel h2{font-size:13px;color:#888;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}
.form-group{margin-bottom:10px}
.form-group label{display:block;font-size:12px;color:#888;margin-bottom:3px}
.form-group select,.form-group input{width:100%;padding:7px 8px;background:#0f0f23;border:1px solid #333;border-radius:6px;color:#eee;font-size:14px}
.row2{display:flex;gap:8px}
.row2>div{flex:1}
.btn{padding:10px;border:none;border-radius:8px;font-size:15px;cursor:pointer;width:100%;margin-top:6px;font-weight:600;transition:all .2s}
.btn-start{background:#4caf50;color:#fff}
.btn-start:hover{background:#45a049}
.btn-stop{background:#e94560;color:#fff}
.btn-stop:hover{background:#c73e54}
.btn-refresh{background:#333;border:1px solid #444;color:#aaa;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;float:right}
.btn-refresh:hover{background:#444;color:#fff}
.btn:disabled{background:#333;cursor:not-allowed;opacity:.5}
.video-box{background:#000;border-radius:8px;overflow:hidden;display:flex;justify-content:center;align-items:center;min-height:340px;position:relative}
.video-box img{width:100%;height:auto}
.video-box .placeholder{color:#555;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:5px 8px;border-bottom:1px solid #222;text-align:right}
th{color:#888;text-align:center}
td:first-child,th:first-child{text-align:left;color:#aaa}
.bar{height:6px;background:#333;border-radius:3px;margin-top:2px;overflow:hidden}
.bar-fill{height:100%;background:#e94560;transition:width .15s;border-radius:3px}
.log{font-size:12px;color:#666;margin-top:10px;max-height:80px;overflow-y:auto;font-family:monospace}
</style>
</head>
<body>
<div class="header">
  <h1>SO-101 遥操作控制台</h1>
  <div class="dot" id="statusDot"></div>
  <span id="statusText" style="font-size:13px;color:#888">未连接</span>
</div>

<div class="main">
  <!-- 控制面板 -->
  <div class="panel ctrl">
    <h2>配置</h2>
    <div class="form-group">
      <label>Follower 串口 (从臂) <button class="btn-refresh" onclick="init()">🔄 刷新</button></label>
      <select id="followerPort"></select>
    </div>
    <div class="form-group">
      <label>Follower ID</label>
      <input id="followerId" value="R12253102" placeholder="如 R12253102">
    </div>
    <div class="form-group">
      <label>Leader 串口 (主臂)</label>
      <select id="leaderPort"></select>
    </div>
    <div class="form-group">
      <label>Leader ID</label>
      <input id="leaderId" value="R07253102" placeholder="如 R07253102">
    </div>
    <div class="row2">
      <div class="form-group">
        <label>刷新率 FPS</label>
        <select id="fps">
          <option value="15">15</option>
          <option value="30" selected>30</option>
          <option value="60">60</option>
        </select>
      </div>
      <div class="form-group">
        <label>MuJoCo 窗口</label>
        <select id="viewer">
          <option value="0" selected>关闭 (Web显示)</option>
          <option value="1">打开 (弹窗)</option>
        </select>
      </div>
    </div>
    <button class="btn btn-start" id="btnStart" onclick="startTeleop()">启动遥操作</button>
    <button class="btn btn-stop" id="btnStop" onclick="stopTeleop()" disabled>停止</button>
    <div class="log" id="logBox"></div>
  </div>

  <!-- MuJoCo 画面 -->
  <div class="panel view">
    <h2>MuJoCo 仿真画面</h2>
    <div class="video-box" id="videoBox">
      <span class="placeholder">点击「启动遥操作」后显示 MuJoCo 画面</span>
    </div>
  </div>

  <!-- 关节数据 -->
  <div class="panel joints">
    <h2>关节数据</h2>
    <table id="jointTable">
      <thead><tr><th>关节</th><th>Leader</th><th>Follower</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>

<script>
let ws = null;

// 初始化：加载串口列表
async function init() {
  try {
    const res = await fetch('/api/ports');
    const data = await res.json();
    const fp = document.getElementById('followerPort');
    const lp = document.getElementById('leaderPort');
    fp.innerHTML = '';
    lp.innerHTML = '';
    for (const p of data.ports) {
      fp.appendChild(new Option(p, p));
      lp.appendChild(new Option(p, p));
    }
    // 默认选择第一个和第二个
    if (data.ports.length >= 1) fp.value = data.ports[0];
    if (data.ports.length >= 2) lp.value = data.ports[1];
  } catch(e) { log('加载串口失败: ' + e); }
}

function log(msg) {
  const box = document.getElementById('logBox');
  const t = new Date().toLocaleTimeString();
  box.innerHTML = `<div>[${t}] ${msg}</div>` + box.innerHTML;
}

function setStatus(running) {
  document.getElementById('statusDot').className = 'dot' + (running ? ' on' : '');
  document.getElementById('statusText').textContent = running ? '运行中' : '未连接';
  document.getElementById('btnStart').disabled = running;
  document.getElementById('btnStop').disabled = !running;
}

async function startTeleop() {
  const params = {
    follower_port: document.getElementById('followerPort').value,
    follower_id: document.getElementById('followerId').value,
    leader_port: document.getElementById('leaderPort').value,
    leader_id: document.getElementById('leaderId').value,
    fps: parseInt(document.getElementById('fps').value),
    viewer: document.getElementById('viewer').value === '1',
  };
  log('启动中...');
  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(params),
    });
    const data = await res.json();
    if (data.ok) {
      log('遥操作已启动');
      setStatus(true);
      connectWS();
    } else {
      log('启动失败: ' + data.error);
    }
  } catch(e) { log('请求失败: ' + e); }
}

async function stopTeleop() {
  log('停止中...');
  try {
    await fetch('/api/stop', {method: 'POST'});
    log('已停止');
    setStatus(false);
  } catch(e) { log('停止失败: ' + e); }
}

function connectWS() {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => log('WebSocket 已连接');
  ws.onclose = () => { log('WebSocket 断开'); setStatus(false); };
  ws.onerror = () => log('WebSocket 错误');
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleMsg(msg);
    } catch(e) {}
  };
}

function handleMsg(msg) {
  if (msg.type === 'status') { setStatus(msg.running); return; }
  if (msg.type === 'stopped') { setStatus(false); log('遥操作进程已退出'); return; }

  if (msg.type === 'teleop_observation') {
    updateJoints(msg.leader, msg.follower);
  }

  if (msg.type === 'mujoco_frame') {
    const box = document.getElementById('videoBox');
    box.innerHTML = `<img src="data:image/jpeg;base64,${msg.data}">`;
  }
}

function updateJoints(leader, follower) {
  const tbody = document.querySelector('#jointTable tbody');
  const names = ['shoulder_pan','shoulder_lift','elbow_flex','wrist_flex','wrist_roll','gripper'];
  let html = '';
  for (const n of names) {
    const lv = leader ? (leader[n]||0).toFixed(1) : '-';
    const fv = follower ? (follower[n]||0).toFixed(1) : '-';
    html += `<tr><td>${n}</td><td>${lv}</td><td>${fv}</td></tr>`;
  }
  tbody.innerHTML = html;
}

init();
</script>
</body>
</html>
"""


# ===================== API 处理函数 =====================

async def index(request):
    return web.Response(text=HTML_PAGE, content_type="text/html")


async def api_ports(request):
    return web.json_response({"ports": detect_serial_ports()})


async def api_start(request):
    if state["running"]:
        return web.json_response({"ok": False, "error": "已在运行中"}, status=400)

    data = await request.json()
    follower_port = data.get("follower_port", "/dev/ttyACM0")
    follower_id = data.get("follower_id", "")
    leader_port = data.get("leader_port", "/dev/ttyACM1")
    leader_id = data.get("leader_id", "")
    fps = str(data.get("fps", 30))
    use_viewer = data.get("viewer", False)

    cmd = [
        PYTHON_PATH, TELEOP_SCRIPT,
        "--follower-port", follower_port,
        "--follower-id", follower_id,
        "--leader-port", leader_port,
        "--leader-id", leader_id,
        "--fps", fps,
    ]
    if use_viewer:
        cmd.append("--viewer")

    logger.info(f"启动: {' '.join(cmd)}")
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        state["process"] = proc
        state["running"] = True
        asyncio.create_task(read_output(proc))
        asyncio.create_task(read_stderr(proc))
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e)}, status=500)

    return web.json_response({"ok": True, "msg": "遥操作已启动"})


async def api_stop(request):
    if not state["running"] or not state["process"]:
        return web.json_response({"ok": False, "error": "未在运行"}, status=400)

    proc = state["process"]
    try:
        proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
    except Exception:
        proc.kill()

    state["process"] = None
    state["running"] = False
    logger.info("遥操作已停止")
    return web.json_response({"ok": True})


async def api_status(request):
    return web.json_response({"running": state["running"]})


async def read_output(proc):
    """读取子进程 stdout，转发给 WebSocket"""
    try:
        while proc.returncode is None:
            line = await proc.stdout.readline()
            if not line:
                break
            line = line.decode().strip()
            if not line:
                continue
            # 尝试解析 JSON，只转发有效 JSON
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                logger.info(f"[stdout] {line}")
                continue
            for ws in list(state["clients"]):
                try:
                    await ws.send_str(line)
                except Exception:
                    state["clients"].discard(ws)
    except Exception as e:
        logger.error(f"读取输出异常: {e}")
    finally:
        state["running"] = False
        state["process"] = None
        for ws in list(state["clients"]):
            try:
                await ws.send_str(json.dumps({"type": "stopped"}))
            except Exception:
                pass


async def read_stderr(proc):
    try:
        while proc.returncode is None:
            line = await proc.stderr.readline()
            if not line:
                break
            logger.info(f"[teleop] {line.decode().strip()}")
    except Exception:
        pass


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    state["clients"].add(ws)
    await ws.send_str(json.dumps({"type": "status", "running": state["running"]}))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
    except Exception:
        pass
    finally:
        state["clients"].discard(ws)
    return ws


# ===================== 启动服务器 =====================

def main():
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/api/ports", api_ports)
    app.router.add_post("/api/start", api_start)
    app.router.add_post("/api/stop", api_stop)
    app.router.add_get("/api/status", api_status)
    app.router.add_get("/ws", websocket_handler)

    port = 8080
    logger.info(f"Web 遥操作控制台: http://localhost:{port}")
    web.run_app(app, host="0.0.0.0", port=port, print=None)


if __name__ == "__main__":
    main()
