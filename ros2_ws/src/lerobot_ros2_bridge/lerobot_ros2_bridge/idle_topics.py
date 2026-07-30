#!/usr/bin/env python3
"""Expose ROS 2 sensor topics before the robot control bridge starts."""

from __future__ import annotations

import argparse
import base64
import json
import threading
import time

import rclpy
from rclpy.executors import ExternalShutdownException
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import CompressedImage, JointState


class IdleTopicsNode(Node):
    def __init__(self, args: argparse.Namespace, *, start_stdio_thread: bool = True):
        super().__init__("lerobot_web_idle_topics")
        sensor_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )
        self._follower_pub = self.create_publisher(
            JointState, args.follower_state_topic, sensor_qos
        )
        self._camera1_pub = self.create_publisher(
            CompressedImage, args.camera1_topic, sensor_qos
        )
        self._camera2_pub = self.create_publisher(
            CompressedImage, args.camera2_topic, sensor_qos
        )
        if start_stdio_thread:
            threading.Thread(target=self._read_input, daemon=True).start()

    def _read_input(self) -> None:
        import sys

        for line in sys.stdin:
            try:
                message = json.loads(line)
                if message.get("type") == "ros_camera_frame":
                    self._publish_camera(message)
                elif message.get("type") == "ros_follower_state":
                    self._publish_follower(message)
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                self.get_logger().warning(f"ignored invalid idle topic input: {exc}")

    def _publish_camera(self, message: dict) -> None:
        data = message.get("data")
        camera = message.get("camera")
        if not isinstance(data, str) or camera not in ("camera1", "camera2"):
            raise ValueError("camera frame requires camera1/camera2 and base64 data")
        output = CompressedImage()
        timestamp = float(message.get("ts", time.time()))
        seconds = int(timestamp)
        output.header.stamp.sec = seconds
        output.header.stamp.nanosec = int((timestamp - seconds) * 1_000_000_000)
        output.header.frame_id = camera
        output.format = "jpeg"
        output.data = base64.b64decode(data, validate=True)
        (self._camera1_pub if camera == "camera1" else self._camera2_pub).publish(output)

    def _publish_follower(self, message: dict) -> None:
        joints = message.get("joints")
        if not isinstance(joints, dict) or not joints:
            raise ValueError("follower state requires a non-empty joints object")
        output = JointState()
        output.header.stamp = self.get_clock().now().to_msg()
        output.name = list(joints)
        output.position = [float(joints[name]) for name in output.name]
        self._follower_pub.publish(output)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--follower-state-topic", default="/follower/joint_states")
    parser.add_argument("--camera1-topic", default="/camera1/image_raw/compressed")
    parser.add_argument("--camera2-topic", default="/camera2/image_raw/compressed")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    rclpy.init(args=[])
    node = IdleTopicsNode(args)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
