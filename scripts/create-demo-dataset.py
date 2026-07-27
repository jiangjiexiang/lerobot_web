#!/usr/bin/env python3
"""Create a small, review-ready dataset for the web data workspace."""

import argparse
import base64
import json
import math
import subprocess
import sys
import urllib.request
from pathlib import Path

import cv2
import numpy as np


JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
EPISODES = [
    {
        "task": "抓取桌面上的方块并放入料盒",
        "status": "approved",
        "tags": ["成功", "轨迹平稳"],
        "notes": "动作完整，双路画面清晰，可直接用于训练。",
    },
    {
        "task": "将方块从右侧移动到左侧标记区",
        "status": "unreviewed",
        "tags": ["待复查"],
        "notes": "演示用待审核 Episode。",
    },
    {
        "task": "抓取圆柱并竖直放置",
        "status": "rejected",
        "tags": ["遮挡", "抓取失败"],
        "notes": "末段目标被机械臂遮挡，保留用于展示拒绝流程。",
    },
]


def get_snapshot(url: str, camera: int) -> np.ndarray:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            payload = bytearray()
            while len(payload) < 4_000_000:
                payload.extend(response.read(32_768))
                start = payload.find(b"\xff\xd8")
                end = payload.find(b"\xff\xd9", start + 2)
                if start >= 0 and end > start:
                    image = cv2.imdecode(np.frombuffer(payload[start:end + 2], np.uint8), cv2.IMREAD_COLOR)
                    if image is not None:
                        return image
    except Exception as error:
        print(f"Camera {camera} snapshot unavailable, using generated preview: {error}", file=sys.stderr)

    image = np.zeros((540, 960, 3), dtype=np.uint8)
    image[:] = (22 + camera * 12, 40, 56 + camera * 20)
    cv2.rectangle(image, (100, 110), (430, 430), (58, 145, 210), -1)
    cv2.circle(image, (690, 270), 145, (76, 180, 115), -1)
    return image


def encode_frame(source: np.ndarray, episode: int, frame: int, total: int, camera: int) -> str:
    image = source.copy()
    height, width = image.shape[:2]
    progress = frame / max(1, total - 1)
    overlay = image.copy()
    cv2.rectangle(overlay, (0, height - 76), (width, height), (6, 14, 22), -1)
    cv2.addWeighted(overlay, 0.82, image, 0.18, 0, image)
    cv2.rectangle(image, (24, height - 26), (width - 24, height - 16), (43, 65, 80), -1)
    cv2.rectangle(image, (24, height - 26), (24 + int((width - 48) * progress), height - 16), (84, 205, 151), -1)
    cv2.putText(image, f"DEMO  EP {episode + 1:02d}  CAM {camera}  FRAME {frame + 1:03d}",
                (24, height - 43), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (232, 242, 248), 2, cv2.LINE_AA)
    ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 86])
    if not ok:
        raise RuntimeError("Failed to encode demo frame")
    return base64.b64encode(jpeg).decode("ascii")


def joints(frame: int, phase: float) -> dict[str, float]:
    return {name: float(0.35 * math.sin(frame * 0.12 + phase + index * 0.3)) for index, name in enumerate(JOINTS)}


def save_review(server: str, dataset: str, episode: int, spec: dict) -> None:
    body = json.dumps({key: spec[key] for key in ("status", "tags", "notes")}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{server}/api/datasets/{dataset}/episodes/{episode}/review",
        data=body,
        method="PATCH",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        result = json.load(response)
    if not result.get("ok"):
        raise RuntimeError(result.get("error", "Failed to save review"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=str(Path.home() / "lerobot_datasets"))
    parser.add_argument("--server", default="http://127.0.0.1:43127")
    parser.add_argument("--name", default="demo_pick_place")
    parser.add_argument("--frames", type=int, default=24)
    parser.add_argument("--fps", type=int, default=10)
    args = parser.parse_args()

    dataset_root = Path(args.root).expanduser().resolve() / args.name
    if dataset_root.exists():
        raise FileExistsError(f"Demo dataset already exists: {dataset_root}")
    camera1 = get_snapshot(f"{args.server}/video/camera", 1)
    camera2 = get_snapshot(f"{args.server}/video/camera2", 2)
    recorder = Path(__file__).resolve().parents[1] / "bridge" / "dataset_recorder.py"

    for episode, spec in enumerate(EPISODES):
        messages = []
        for frame in range(args.frames):
            messages.append({
                "type": "record_frame",
                "leader": joints(frame, episode * 0.4),
                "follower": joints(frame, episode * 0.4 + 0.08),
                "camera": encode_frame(camera1, episode, frame, args.frames, 1),
                "camera2": encode_frame(camera2, episode, frame, args.frames, 2),
            })
        messages.append({"type": "save_episode"})
        process = subprocess.run(
            [sys.executable, str(recorder), "--root", str(dataset_root), "--repo-id", f"local/{args.name}",
             "--fps", str(args.fps), "--task", spec["task"]],
            input="".join(json.dumps(message, ensure_ascii=False) + "\n" for message in messages),
            text=True,
            capture_output=True,
            timeout=180,
        )
        if process.returncode != 0:
            raise RuntimeError(process.stderr or process.stdout)
        print(f"Saved demo episode {episode}: {spec['task']}")

    for episode, spec in enumerate(EPISODES):
        save_review(args.server, args.name, episode, spec)
    print(json.dumps({"dataset": args.name, "episodes": len(EPISODES), "path": str(dataset_root)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
