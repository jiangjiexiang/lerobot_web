#!/usr/bin/env python3
"""Record synchronized web teleoperation samples as a LeRobot dataset."""

import argparse
import base64
import json
import signal
import sys
from pathlib import Path

import cv2
import numpy as np

from lerobot.datasets.lerobot_dataset import LeRobotDataset


JOINT_NAMES = [
    "shoulder_pan",
    "shoulder_lift",
    "elbow_flex",
    "wrist_flex",
    "wrist_roll",
    "gripper",
]


def emit(message: dict) -> None:
    print(json.dumps(message, ensure_ascii=False), flush=True)


def terminate(_signum, _frame) -> None:
    raise SystemExit(143)


def decode_image(encoded: str) -> np.ndarray:
    data = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("无法解码摄像头 JPEG 帧")
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)


def vector(joints: dict) -> np.ndarray:
    missing = [name for name in JOINT_NAMES if name not in joints]
    if missing:
        raise ValueError(f"关节数据不完整: {', '.join(missing)}")
    return np.asarray([joints[name] for name in JOINT_NAMES], dtype=np.float32)


def dataset_features(camera: np.ndarray, camera2: np.ndarray) -> dict:
    return {
        "observation.state": {"dtype": "float32", "shape": (len(JOINT_NAMES),), "names": JOINT_NAMES},
        "action": {"dtype": "float32", "shape": (len(JOINT_NAMES),), "names": JOINT_NAMES},
        "observation.images.camera1": {
            "dtype": "video",
            "shape": camera.shape,
            "names": ["height", "width", "channel"],
        },
        "observation.images.camera2": {
            "dtype": "video",
            "shape": camera2.shape,
            "names": ["height", "width", "channel"],
        },
    }


def open_dataset(args: argparse.Namespace, camera: np.ndarray, camera2: np.ndarray) -> LeRobotDataset:
    root = Path(args.root).expanduser().resolve()
    info_file = root / "meta" / "info.json"
    expected_features = dataset_features(camera, camera2)

    if info_file.exists():
        dataset = LeRobotDataset(args.repo_id, root=root)
        if dataset.fps != args.fps:
            raise ValueError(f"已有数据集 FPS 为 {dataset.fps}，不能用 {args.fps} FPS 续录")
        for key, expected in expected_features.items():
            actual = dataset.features.get(key)
            if actual is None or tuple(actual["shape"]) != tuple(expected["shape"]):
                raise ValueError(f"已有数据集特征不兼容: {key}")
        dataset.start_image_writer(num_processes=0, num_threads=4)
        return dataset

    root.parent.mkdir(parents=True, exist_ok=True)
    return LeRobotDataset.create(
        repo_id=args.repo_id,
        fps=args.fps,
        root=root,
        robot_type="so101_follower",
        features=expected_features,
        use_videos=True,
        image_writer_threads=4,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="LeRobot Web dataset recorder")
    parser.add_argument("--root", required=True)
    parser.add_argument("--repo-id", required=True)
    parser.add_argument("--fps", type=int, required=True)
    parser.add_argument("--task", required=True)
    args = parser.parse_args()

    dataset = None
    frame_count = 0
    completed = False
    emit({"type": "recorder_ready"})

    try:
        for line in sys.stdin:
            message = json.loads(line)
            message_type = message.get("type")

            if message_type == "record_frame":
                camera = decode_image(message["camera"])
                camera2 = decode_image(message["camera2"])
                if dataset is None:
                    dataset = open_dataset(args, camera, camera2)
                    emit({"type": "dataset_opened", "episode": dataset.num_episodes, "path": str(dataset.root)})

                dataset.add_frame({
                    "observation.state": vector(message["follower"]),
                    "action": vector(message["leader"]),
                    "observation.images.camera1": camera,
                    "observation.images.camera2": camera2,
                    "task": args.task,
                })
                frame_count += 1
                emit({"type": "frame_added", "frames": frame_count})

            elif message_type == "save_episode":
                if dataset is None or frame_count == 0:
                    emit({"type": "recorder_error", "error": "当前 episode 没有可保存的数据帧"})
                    raise SystemExit(2)
                episode_index = dataset.num_episodes
                dataset.save_episode(parallel_encoding=True)
                dataset.stop_image_writer()
                completed = True
                emit({
                    "type": "episode_saved",
                    "episode": episode_index,
                    "frames": frame_count,
                    "path": str(dataset.root),
                })
                return

            elif message_type == "cancel":
                if dataset is not None:
                    dataset.clear_episode_buffer(delete_images=True)
                    dataset.stop_image_writer()
                    dataset = None
                emit({"type": "recording_cancelled"})
                return
    except Exception as error:
        emit({"type": "recorder_error", "error": str(error)})
        raise
    finally:
        if dataset is not None and not completed:
            try:
                dataset.clear_episode_buffer(delete_images=True)
                dataset.stop_image_writer()
            except Exception as cleanup_error:
                print(f"清理未保存 episode 失败: {cleanup_error}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, terminate)
    main()
