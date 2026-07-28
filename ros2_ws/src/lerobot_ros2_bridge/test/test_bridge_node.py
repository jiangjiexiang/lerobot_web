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
from sensor_msgs.msg import JointState
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

    def test_external_bridge_process_forwards_ros_state_and_desired_command(self):
        namespace = f"/integration/t{time.time_ns()}"
        leader_topic = f"{namespace}/leader"
        follower_topic = f"{namespace}/follower"
        command_topic = f"{namespace}/command"
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
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        probe = rclpy.create_node(f"bridge_probe_{time.time_ns()}")
        follower_pub = probe.create_publisher(JointState, follower_topic, 1)
        command_pub = probe.create_publisher(JointTrajectory, command_topic, 1)
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if (
                    probe.count_subscribers(follower_topic) > 0
                    and probe.count_subscribers(command_topic) > 0
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
        finally:
            probe.destroy_node()
            child.send_signal(signal.SIGTERM)
            child.wait(timeout=5)
            if child.returncode != 0:
                self.fail(f"bridge exited with {child.returncode}: {child.stderr.read()}")


if __name__ == "__main__":
    unittest.main()
