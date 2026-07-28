import json
import os
import selectors
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import rclpy
from sensor_msgs.msg import CompressedImage, JointState
from trajectory_msgs.msg import JointTrajectory
from trajectory_msgs.msg import JointTrajectoryPoint

from lerobot_ros2_bridge.web_bridge import LeRobotWebRosBridge, parse_args


FOLLOWER = {
    "shoulder_pan": 0.0,
    "shoulder_lift": 0.0,
    "elbow_flex": 0.0,
    "wrist_flex": 0.0,
    "wrist_roll": 0.0,
    "gripper": 50.0,
}


class BridgeNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rclpy.init(args=[])

    @classmethod
    def tearDownClass(cls):
        if rclpy.ok():
            rclpy.shutdown()

    def make_node(self, command_source="ros"):
        namespace = f"/test/t{time.time_ns()}"
        args = parse_args(
            [
                "--driver",
                "external",
                "--command-source",
                command_source,
                "--leader-state-topic",
                f"{namespace}/leader",
                "--follower-state-topic",
                f"{namespace}/follower",
                "--command-topic",
                f"{namespace}/command",
                "--camera1-topic",
                f"{namespace}/camera1",
                "--camera2-topic",
                f"{namespace}/camera2",
            ]
        )
        return LeRobotWebRosBridge(args, start_stdio_thread=False)

    def test_missing_leader_does_not_drop_follower_observation(self):
        node = self.make_node()
        try:
            with patch("lerobot_ros2_bridge.web_bridge.emit") as emit:
                node._publish_observation({}, FOLLOWER, 123.0)
            payload = emit.call_args.args[0]
            self.assertEqual(payload["follower"], FOLLOWER)
            self.assertNotIn("leader", payload)
        finally:
            node.destroy_node()

    def test_external_driver_accepts_arbitrary_joint_set(self):
        node = self.make_node()
        state = JointState()
        state.name = ["vendor_joint_a", "vendor_joint_b"]
        state.position = [0.25, -0.5]
        try:
            with patch("lerobot_ros2_bridge.web_bridge.emit") as emit:
                node._on_external_follower(state)
            self.assertEqual(
                emit.call_args.args[0]["follower"],
                {"vendor_joint_a": 0.25, "vendor_joint_b": -0.5},
            )
        finally:
            node.destroy_node()

    def test_stale_and_future_commands_are_rejected(self):
        node = self.make_node()
        try:
            command = JointTrajectory()
            old_ns = node.get_clock().now().nanoseconds - 1_000_000_000
            command.header.stamp.sec = old_ns // 1_000_000_000
            command.header.stamp.nanosec = old_ns % 1_000_000_000
            self.assertTrue(node._command_is_stale(command))

            command.header.stamp.sec = 0
            command.header.stamp.nanosec = 0
            self.assertFalse(node._command_is_stale(command))
        finally:
            node.destroy_node()

    def test_remote_leader_defaults_to_web_command_source(self):
        self.assertEqual(parse_args(["--remote-leader"]).command_source, "web")
        self.assertEqual(parse_args([]).command_source, "leader")

    def test_synchronized_capture_uses_ros_header_stamps(self):
        node = self.make_node()
        leader = JointState()
        follower = JointState()
        leader.name = follower.name = ["joint"]
        leader.position = [0.5]
        follower.position = [0.25]
        camera1 = CompressedImage()
        camera2 = CompressedImage()
        camera1.data = b"first"
        camera2.data = b"second"
        for index, message in enumerate((leader, follower, camera1, camera2)):
            message.header.stamp.sec = 10
            message.header.stamp.nanosec = index * 10_000_000
        node._capture_sync_enabled = True
        try:
            with patch("lerobot_ros2_bridge.web_bridge.emit") as emit:
                node._on_synchronized_capture(leader, follower, camera1, camera2)
            payload = emit.call_args.args[0]
            self.assertEqual(payload["type"], "capture_sample")
            self.assertAlmostEqual(payload["sensor_skew_ms"], 30.0)
            self.assertEqual(payload["leader"], {"joint": 0.5})
        finally:
            node.destroy_node()

    def test_external_bridge_process_forwards_ros_state_and_desired_command(self):
        namespace = f"/integration/t{time.time_ns()}"
        leader_topic = f"{namespace}/leader"
        follower_topic = f"{namespace}/follower"
        command_topic = f"{namespace}/command"
        camera1_topic = f"{namespace}/camera1"
        camera2_topic = f"{namespace}/camera2"
        child = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "lerobot_ros2_bridge.web_bridge",
                "--driver",
                "external",
                "--command-source",
                "ros",
                "--leader-state-topic",
                leader_topic,
                "--follower-state-topic",
                follower_topic,
                "--command-topic",
                command_topic,
                "--camera1-topic",
                camera1_topic,
                "--camera2-topic",
                camera2_topic,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        probe = rclpy.create_node(f"bridge_probe_{time.time_ns()}")
        leader_pub = probe.create_publisher(JointState, leader_topic, 1)
        follower_pub = probe.create_publisher(JointState, follower_topic, 1)
        command_pub = probe.create_publisher(JointTrajectory, command_topic, 1)
        camera1_pub = probe.create_publisher(CompressedImage, camera1_topic, 1)
        camera2_pub = probe.create_publisher(CompressedImage, camera2_topic, 1)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if (
                    probe.count_subscribers(follower_topic) > 0
                    and probe.count_subscribers(command_topic) > 0
                    and probe.count_subscribers(camera1_topic) > 0
                    and probe.count_subscribers(camera2_topic) > 0
                ):
                    break
                rclpy.spin_once(probe, timeout_sec=0.05)
            else:
                self.fail("external bridge topics were not discovered")

            follower = JointState()
            follower.name = ["vendor_joint"]
            follower.position = [0.25]
            desired = JointTrajectory()
            desired.joint_names = ["vendor_joint"]
            point = JointTrajectoryPoint()
            point.positions = [0.5]
            desired.points = [point]
            follower_pub.publish(follower)
            command_pub.publish(desired)

            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            observed = None
            output_lines = []
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                # Repeat current state/command like a real control loop and avoid
                # relying on a single DDS sample during endpoint discovery.
                follower_pub.publish(follower)
                command_pub.publish(desired)
                for key, _ in selector.select(timeout=0.2):
                    line = key.fileobj.readline()
                    output_lines.append(line.rstrip())
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("leader") == {"vendor_joint": 0.5}:
                        observed = payload
                        break
                if observed is not None:
                    break
            self.assertIsNotNone(observed, f"bridge output: {output_lines}")
            self.assertEqual(observed["follower"], {"vendor_joint": 0.25})

            child.stdin.write(json.dumps({"type": "capture_sync", "enabled": True}) + "\n")
            child.stdin.flush()
            capture = None
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                stamp = probe.get_clock().now().to_msg()
                leader = JointState()
                leader.header.stamp = stamp
                leader.name = ["vendor_joint"]
                leader.position = [0.5]
                follower.header.stamp = stamp
                camera1 = CompressedImage()
                camera1.header.stamp = stamp
                camera1.data = b"jpeg-one"
                camera2 = CompressedImage()
                camera2.header.stamp = stamp
                camera2.data = b"jpeg-two"
                leader_pub.publish(leader)
                follower_pub.publish(follower)
                camera1_pub.publish(camera1)
                camera2_pub.publish(camera2)
                for key, _ in selector.select(timeout=0.2):
                    line = key.fileobj.readline()
                    output_lines.append(line.rstrip())
                    try:
                        payload = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if payload.get("type") == "capture_sample":
                        capture = payload
                        break
                if capture is not None:
                    break
            self.assertIsNotNone(capture, f"bridge output: {output_lines}")
            self.assertEqual(capture["leader"], {"vendor_joint": 0.5})
            self.assertLess(capture["sensor_skew_ms"], 1.0)
        finally:
            probe.destroy_node()
            child.send_signal(signal.SIGTERM)
            child.wait(timeout=5)
            if child.returncode != 0:
                self.fail(f"bridge exited with {child.returncode}: {child.stderr.read()}")


if __name__ == "__main__":
    unittest.main()
