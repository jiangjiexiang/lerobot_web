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
    def test_cancel_before_first_frame_does_not_wait_for_heavy_imports(self) -> None:
        with tempfile.TemporaryDirectory(prefix="lerobot-recorder-cancel-test-") as directory:
            command = [
                sys.executable,
                str(Path(__file__).with_name("dataset_recorder.py")),
                "--root",
                str(Path(directory) / "demo"),
                "--repo-id",
                "local/demo",
                "--fps",
                "10",
                "--task",
                "cancel",
                "--robot-type",
                "so101_test",
            ]
            result = subprocess.run(
                command,
                input=json.dumps({"type": "cancel"}) + chr(10),
                text=True,
                capture_output=True,
                timeout=5,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(events[0]["type"], "recorder_ready")
        self.assertEqual(events[-1]["type"], "recording_cancelled")

    def test_records_joint_schema_and_two_videos(self) -> None:
        image = np.zeros((48, 64, 3), dtype=np.uint8)
        image[:, :, 1] = 180
        ok, jpeg = cv2.imencode(".jpg", image)
        self.assertTrue(ok)
        encoded = base64.b64encode(jpeg).decode("ascii")
        joints = {"axis_a": 0.1, "axis_b": -0.2, "tool": 0.3}
        first_stdin = "\n".join(
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
        large_image = np.zeros((720, 1280, 3), dtype=np.uint8)
        large_image[:, :, 0] = 90
        ok, large_jpeg = cv2.imencode(".jpg", large_image)
        self.assertTrue(ok)
        large_encoded = base64.b64encode(large_jpeg).decode("ascii")
        second_stdin = "\n".join(
            [
                json.dumps(
                    {
                        "type": "record_frame",
                        "leader": joints,
                        "follower": joints,
                        "camera": large_encoded,
                        "camera2": large_encoded,
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
                "so101_test",
            ]
            for expected_episode, episode_stdin in ((0, first_stdin), (1, second_stdin)):
                result = subprocess.run(
                    recorder_command,
                    input=episode_stdin,
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
