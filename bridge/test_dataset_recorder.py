#!/usr/bin/env python3
"""Process-level smoke test for the LeRobot dataset recorder."""

import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from lerobot.datasets.lerobot_dataset import LeRobotDataset


class DatasetRecorderTest(unittest.TestCase):
    def test_records_dynamic_ros_joint_schema_and_two_videos(self) -> None:
        image = np.zeros((48, 64, 3), dtype=np.uint8)
        image[:, :, 1] = 180
        ok, jpeg = cv2.imencode(".jpg", image)
        self.assertTrue(ok)
        encoded = base64.b64encode(jpeg).decode("ascii")
        joints = {"axis_a": 0.1, "axis_b": -0.2, "tool": 0.3}
        stdin = "\n".join(
            [
                json.dumps(
                    {
                        "type": "record_frame",
                        "leader": joints,
                        "follower": joints,
                        "camera": encoded,
                        "camera2": encoded,
                    }
                ),
                json.dumps({"type": "save_episode"}),
                "",
            ]
        )

        with tempfile.TemporaryDirectory(prefix="lerobot-recorder-test-") as directory:
            root = Path(directory) / "demo"
            recorder_command = [
                sys.executable,
                str(Path(__file__).with_name("dataset_recorder.py")),
                "--root",
                str(root),
                "--repo-id",
                "local/demo",
                "--fps",
                "10",
                "--task",
                "synthetic",
                "--robot-type",
                "ros2_test",
            ]
            for expected_episode in (0, 1):
                result = subprocess.run(
                    recorder_command,
                    input=stdin,
                    text=True,
                    capture_output=True,
                    timeout=90,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                events = [json.loads(line) for line in result.stdout.splitlines()]
                saved = next(event for event in events if event["type"] == "episode_saved")
                self.assertEqual(saved["episode"], expected_episode)

            dataset = LeRobotDataset("local/demo", root=root)
            self.assertEqual(dataset.num_episodes, 2)
            self.assertEqual(dataset.num_frames, 2)
            self.assertEqual(dataset.fps, 10)
            self.assertEqual(dataset.features["observation.state"]["names"], list(joints))
            self.assertEqual(len(list((root / "videos").glob("**/*.mp4"))), 4)

            catalog_script = str(Path(__file__).with_name("dataset_catalog.py"))
            for command in ("list", "detail", "quality"):
                args = [sys.executable, catalog_script, command, "--root", directory]
                if command != "list":
                    args.extend(["--dataset", "demo"])
                catalog = subprocess.run(
                    args,
                    text=True,
                    capture_output=True,
                    timeout=90,
                    check=False,
                )
                self.assertEqual(catalog.returncode, 0, catalog.stdout + catalog.stderr)
                payload = json.loads(catalog.stdout)
                if command == "list":
                    self.assertEqual(payload["datasets"][0]["totalEpisodes"], 2)
                else:
                    self.assertEqual(len(payload["episodes"]), 2)
                if command == "quality":
                    self.assertEqual(payload["summary"]["errors"], 0)


if __name__ == "__main__":
    unittest.main()
