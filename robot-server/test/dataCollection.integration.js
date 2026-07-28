const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const projectRoot = path.resolve(__dirname, "../..");
const port = 44000 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const datasetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lerobot-web-api-test-"));
const logs = [];

function startWithRos(command, args, extraEnv = {}) {
  const quoted = [command, ...args].map((value) => JSON.stringify(value)).join(" ");
  const child = spawn("bash", ["-lc", `source /opt/ros/humble/setup.bash && exec ${quoted}`], {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return child;
}

async function request(route, options) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${route}: ${body.error || response.status}`);
  return body;
}

async function waitFor(check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError || new Error("condition timeout");
}

async function main() {
  const server = startWithRos("node", ["robot-server/dist/index.js"], {
    PORT: String(port),
    DATASET_ROOT: datasetRoot,
    ENABLE_CAMERA: "0",
    ENABLE_WEBRTC: "0",
    CONTROL_BACKEND: "ros2",
    ROS2_DRIVER: "external",
    ROS2_COMMAND_SOURCE: "leader",
    ROS_PYTHON_PATH: "/usr/bin/python3",
    PYTHON_PATH: "/home/jiang/miniconda3/envs/lerobot/bin/python3",
    ROS2_BRIDGE_SCRIPT: path.join(
      projectRoot,
      "ros2_ws/src/lerobot_ros2_bridge/lerobot_ros2_bridge/web_bridge.py",
    ),
  });
  const fixture = startWithRos("/usr/bin/python3", [
    "ros2_ws/src/lerobot_ros2_bridge/test/capture_fixture_node.py",
  ]);

  try {
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/health`);
      return response.ok;
    });
    await request("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fps: 30 }),
    });
    await waitFor(async () => {
      const check = await request("/api/self-check");
      return check.server.running && check.cameras.every((camera) => camera.frameFresh);
    });

    await request("/api/recording/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataset: "integration",
        task: "synchronized collection test",
        fps: 5,
        plannedEpisodes: 1,
        episodeTime: 1,
        resetTime: 0,
      }),
    });
    const recording = await waitFor(async () => {
      const status = await request("/api/recording/status");
      return status.state === "idle" && status.frames >= 5 ? status : null;
    }, 30000);
    assert.strictEqual(recording.frames, 5);
    assert.ok(["mcap", "sqlite3"].includes(recording.rawBagStorage));
    assert.ok(fs.existsSync(recording.rawBagPath));
    const bagInfo = execFileSync("ros2", ["bag", "info", recording.rawBagPath], { encoding: "utf-8" });
    const messageCount = Number(bagInfo.match(/Messages:\s+(\d+)/)?.[1] || 0);
    assert.ok(messageCount > 0, bagInfo);

    const list = await request("/api/datasets");
    assert.strictEqual(list.datasets[0].name, "integration");
    assert.strictEqual(list.datasets[0].totalEpisodes, 1);

    const detail = await request("/api/datasets/integration");
    assert.strictEqual(detail.episodes.length, 1);
    assert.strictEqual(Object.keys(detail.episodes[0].videos).length, 2);
    for (const videoUrl of Object.values(detail.episodes[0].videos)) {
      const response = await fetch(`${baseUrl}${videoUrl}`);
      assert.strictEqual(response.status, 200);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
    }

    const quality = await request("/api/datasets/integration/quality");
    assert.strictEqual(quality.summary.errors, 0);
    console.log("Data collection/list/detail/video/quality integration: OK");
  } finally {
    server.kill("SIGINT");
    fixture.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.rmSync(datasetRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  console.error(logs.join(""));
  process.exitCode = 1;
});
