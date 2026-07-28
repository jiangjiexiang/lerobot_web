#!/usr/bin/env python3
"""Bridge LeRobot Web stdio and hardware subprocesses to standard ROS 2 topics."""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import rclpy
import message_filters
from ament_index_python.packages import get_package_share_directory
from rclpy.node import Node
from rclpy.executors import ExternalShutdownException
from rclpy.qos import DurabilityPolicy, HistoryPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import CompressedImage, JointState
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint

if __package__:
    from .conversions import JOINT_NAMES, lerobot_to_ros, ros_to_lerobot
else:
    # Allow robot-server to execute this source file before the colcon
    # workspace has been built, while keeping the normal ROS package entrypoint.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from lerobot_ros2_bridge.conversions import (  # type: ignore[no-redef]
        JOINT_NAMES,
        lerobot_to_ros,
        ros_to_lerobot,
    )


def emit(message: dict) -> None:
    print(json.dumps(message, separators=(",", ":")), flush=True)


class LeRobotWebRosBridge(Node):
    def __init__(self, args: argparse.Namespace, *, start_stdio_thread: bool = True):
        super().__init__("lerobot_web_bridge")
        self.args = args
        self._write_lock = threading.Lock()
        self._child: subprocess.Popen[str] | None = None
        self.driver_exit_code: int | None = None
        self._latest_leader: dict[str, float] | None = None
        self._latest_follower: dict[str, float] | None = None
        self._command_subscription = None
        self._leader_subscription = None
        self._follower_subscription = None
        self._capture_sync_enabled = False

        sensor_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.BEST_EFFORT,
            durability=DurabilityPolicy.VOLATILE,
        )
        command_qos = QoSProfile(
            history=HistoryPolicy.KEEP_LAST,
            depth=1,
            reliability=ReliabilityPolicy.RELIABLE,
            durability=DurabilityPolicy.VOLATILE,
        )
        self._leader_pub = self.create_publisher(
            JointState, args.leader_state_topic, sensor_qos
        )
        self._follower_pub = self.create_publisher(
            JointState, args.follower_state_topic, sensor_qos
        )
        self._command_pub = self.create_publisher(
            JointTrajectory, args.command_topic, command_qos
        )
        self._camera1_pub = self.create_publisher(
            CompressedImage, args.camera1_topic, sensor_qos
        )
        self._camera2_pub = self.create_publisher(
            CompressedImage, args.camera2_topic, sensor_qos
        )
        self._camera1_subscription = self.create_subscription(
            CompressedImage, args.camera1_topic, self._on_camera1, sensor_qos
        )
        self._camera2_subscription = self.create_subscription(
            CompressedImage, args.camera2_topic, self._on_camera2, sensor_qos
        )
        self._sync_inputs = [
            message_filters.Subscriber(
                self, JointState, args.leader_state_topic, qos_profile=sensor_qos
            ),
            message_filters.Subscriber(
                self, JointState, args.follower_state_topic, qos_profile=sensor_qos
            ),
            message_filters.Subscriber(
                self, CompressedImage, args.camera1_topic, qos_profile=sensor_qos
            ),
            message_filters.Subscriber(
                self, CompressedImage, args.camera2_topic, qos_profile=sensor_qos
            ),
        ]
        self._capture_synchronizer = message_filters.ApproximateTimeSynchronizer(
            self._sync_inputs,
            queue_size=args.capture_sync_queue,
            slop=args.capture_sync_slop,
            allow_headerless=False,
        )
        self._capture_synchronizer.registerCallback(self._on_synchronized_capture)
        if args.command_source == "ros":
            self._command_subscription = self.create_subscription(
                JointTrajectory, args.command_topic, self._on_ros_command, command_qos
            )

        if args.driver == "external":
            self._leader_subscription = self.create_subscription(
                JointState,
                args.leader_state_topic,
                self._on_external_leader,
                sensor_qos,
            )
            self._follower_subscription = self.create_subscription(
                JointState,
                args.follower_state_topic,
                self._on_external_follower,
                sensor_qos,
            )
        else:
            self._start_lerobot_driver()

        if start_stdio_thread:
            threading.Thread(target=self._read_web_input, daemon=True).start()

    def _start_lerobot_driver(self) -> None:
        command = [
            self.args.lerobot_python,
            self.args.lerobot_driver_script,
            "--follower-port",
            self.args.follower_port,
            "--follower-id",
            self.args.follower_id,
            "--leader-port",
            self.args.leader_port,
            "--leader-id",
            self.args.leader_id,
            "--fps",
            str(self.args.fps),
            "--stream-fps",
            "0",
            "--command-timeout",
            str(self.args.command_timeout),
            "--external-command",
        ]
        if self.args.command_source != "leader":
            command.append("--remote-leader")
        self.get_logger().info(
            f"starting LeRobot adapter process: {self.args.lerobot_driver_script}"
        )
        self._child = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._read_driver_output, daemon=True).start()

    def _joint_state(self, joints: dict[str, float]) -> JointState:
        message = JointState()
        message.header.stamp = self.get_clock().now().to_msg()
        message.name = list(JOINT_NAMES)
        message.position = lerobot_to_ros(joints)
        return message

    def _ros_joint_state(
        self, joints: dict[str, float], stamp=None, frame_id: str = ""
    ) -> JointState:
        message = JointState()
        message.header.stamp = stamp or self.get_clock().now().to_msg()
        message.header.frame_id = frame_id
        message.name = list(joints)
        message.position = [float(joints[name]) for name in message.name]
        return message

    def _trajectory(self, joints: dict[str, float]) -> JointTrajectory:
        message = JointTrajectory()
        message.header.stamp = self.get_clock().now().to_msg()
        message.joint_names = list(JOINT_NAMES)
        point = JointTrajectoryPoint()
        point.positions = lerobot_to_ros(joints)
        duration_ns = max(1, int(1_000_000_000 / self.args.fps))
        point.time_from_start.sec = duration_ns // 1_000_000_000
        point.time_from_start.nanosec = duration_ns % 1_000_000_000
        message.points = [point]
        return message

    def _ros_trajectory(self, joints: dict[str, float]) -> JointTrajectory:
        if not joints or not all(math.isfinite(float(value)) for value in joints.values()):
            raise ValueError("joint positions must be a non-empty set of finite values")
        message = JointTrajectory()
        message.header.stamp = self.get_clock().now().to_msg()
        message.joint_names = list(joints)
        point = JointTrajectoryPoint()
        point.positions = [float(joints[name]) for name in message.joint_names]
        duration_ns = max(1, int(1_000_000_000 / self.args.fps))
        point.time_from_start.sec = duration_ns // 1_000_000_000
        point.time_from_start.nanosec = duration_ns % 1_000_000_000
        message.points = [point]
        return message

    def _publish_observation(self, leader: dict, follower: dict, timestamp: float) -> None:
        output: dict = {"type": "teleop_observation", "ts": timestamp}
        try:
            self._follower_pub.publish(self._joint_state(follower))
            self._latest_follower = follower
            output["follower"] = follower
        except ValueError as exc:
            self.get_logger().warning(f"rejected follower observation: {exc}")
            return

        try:
            leader_state = self._joint_state(leader)
        except ValueError:
            leader_state = None
        if leader_state is not None:
            self._latest_leader = leader
            self._leader_pub.publish(leader_state)
            output["leader"] = leader
            if self.args.command_source == "leader":
                trajectory = self._trajectory(leader)
                self._command_pub.publish(trajectory)
                self._send_driver_command(leader)
        emit(output)

    def _read_driver_output(self) -> None:
        child = self._child
        if child is None or child.stdout is None:
            return
        for line in child.stdout:
            try:
                message = json.loads(line)
                if message.get("type") != "teleop_observation":
                    emit(message)
                    continue
                leader = message.get("leader")
                follower = message.get("follower")
                if isinstance(leader, dict) and isinstance(follower, dict):
                    self._publish_observation(
                        leader, follower, float(message.get("ts", time.time()))
                    )
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                self.get_logger().warning(f"ignored invalid driver output: {exc}")
        return_code = child.wait()
        self.driver_exit_code = return_code
        if rclpy.ok():
            self.get_logger().error(f"LeRobot adapter exited with code {return_code}")
            rclpy.shutdown()

    def _read_web_input(self) -> None:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                if message.get("type") == "capture_sync":
                    self._capture_sync_enabled = bool(message.get("enabled"))
                    continue
                if message.get("type") == "ros_camera_frame":
                    self._publish_camera_from_stdio(message)
                    continue
                joints = message.get("joints") if message.get("type") == "action" else None
                if isinstance(joints, dict) and self.args.command_source == "web":
                    self._latest_leader = joints
                    if self.args.driver == "external" and message.get("units") == "ros":
                        self._leader_pub.publish(self._ros_joint_state(joints))
                        self._command_pub.publish(self._ros_trajectory(joints))
                    else:
                        self._leader_pub.publish(self._joint_state(joints))
                        self._command_pub.publish(self._trajectory(joints))
                        self._send_driver_command(joints)
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                self.get_logger().warning(f"ignored invalid web command: {exc}")

    def _on_ros_command(self, message: JointTrajectory) -> None:
        if not message.points or self._command_is_stale(message):
            return
        if self.args.driver == "external":
            point = message.points[-1]
            if len(message.joint_names) != len(point.positions) or not message.joint_names:
                self.get_logger().warning("rejected trajectory command: names and positions must be equal length")
                return
            desired = dict(zip(message.joint_names, map(float, point.positions)))
            if not all(math.isfinite(value) for value in desired.values()):
                self.get_logger().warning("rejected trajectory command: positions must be finite")
                return
            self._latest_leader = desired
            self._leader_pub.publish(
                self._ros_joint_state(desired, message.header.stamp)
            )
            self._emit_external_observation()
            return
        try:
            joints = ros_to_lerobot(message.joint_names, message.points[-1].positions)
        except ValueError as exc:
            self.get_logger().warning(f"rejected trajectory command: {exc}")
            return
        self._send_driver_command(joints)

    def _command_is_stale(self, message: JointTrajectory) -> bool:
        stamp = message.header.stamp
        if stamp.sec == 0 and stamp.nanosec == 0:
            return False
        stamp_ns = stamp.sec * 1_000_000_000 + stamp.nanosec
        age_s = (self.get_clock().now().nanoseconds - stamp_ns) / 1_000_000_000
        if age_s > self.args.command_timeout:
            self.get_logger().warning(
                f"rejected stale trajectory command ({age_s * 1000:.0f} ms old)"
            )
            return True
        if age_s < -1.0:
            self.get_logger().warning("rejected trajectory command with a future timestamp")
            return True
        return False

    def _send_driver_command(self, joints: dict[str, float]) -> None:
        if self.args.driver == "external":
            return
        child = self._child
        if child is None or child.poll() is not None or child.stdin is None:
            return
        with self._write_lock:
            try:
                child.stdin.write(json.dumps({"type": "action", "joints": joints}) + "\n")
                child.stdin.flush()
            except BrokenPipeError:
                pass

    def _from_joint_state(self, message: JointState) -> dict[str, float] | None:
        if len(message.name) != len(message.position) or not message.name:
            self.get_logger().warning("rejected joint state: names and positions must be non-empty and equal length")
            return None
        joints = {name: float(value) for name, value in zip(message.name, message.position)}
        if len(joints) != len(message.name) or not all(math.isfinite(value) for value in joints.values()):
            self.get_logger().warning("rejected joint state: duplicate names or non-finite positions")
            return None
        return joints

    def _on_external_leader(self, message: JointState) -> None:
        joints = self._from_joint_state(message)
        if joints is None:
            return
        self._latest_leader = joints
        if self.args.command_source == "leader":
            self._command_pub.publish(self._ros_trajectory(joints))
        self._emit_external_observation()

    def _on_external_follower(self, message: JointState) -> None:
        joints = self._from_joint_state(message)
        if joints is None:
            return
        self._latest_follower = joints
        self._emit_external_observation()

    def _publish_camera_from_stdio(self, message: dict) -> None:
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

    @staticmethod
    def _stamp_seconds(message) -> float:
        return message.header.stamp.sec + message.header.stamp.nanosec / 1_000_000_000

    def _emit_ros_camera(self, camera: str, message: CompressedImage) -> None:
        emit({
            "type": "ros_camera_frame",
            "camera": camera,
            "data": base64.b64encode(bytes(message.data)).decode("ascii"),
            "ts": self._stamp_seconds(message),
            "format": message.format,
        })

    def _on_camera1(self, message: CompressedImage) -> None:
        self._emit_ros_camera("camera1", message)

    def _on_camera2(self, message: CompressedImage) -> None:
        self._emit_ros_camera("camera2", message)

    def _on_synchronized_capture(
        self,
        leader: JointState,
        follower: JointState,
        camera1: CompressedImage,
        camera2: CompressedImage,
    ) -> None:
        if not self._capture_sync_enabled:
            return
        leader_joints = self._from_joint_state(leader)
        follower_joints = self._from_joint_state(follower)
        if leader_joints is None or follower_joints is None:
            return
        stamps = [
            self._stamp_seconds(leader),
            self._stamp_seconds(follower),
            self._stamp_seconds(camera1),
            self._stamp_seconds(camera2),
        ]
        emit({
            "type": "capture_sample",
            "ts": max(stamps),
            "sensor_skew_ms": (max(stamps) - min(stamps)) * 1000,
            "leader": leader_joints,
            "follower": follower_joints,
            "camera": base64.b64encode(bytes(camera1.data)).decode("ascii"),
            "camera2": base64.b64encode(bytes(camera2.data)).decode("ascii"),
        })

    def _emit_external_observation(self) -> None:
        if self._latest_follower is None:
            return
        output = {
            "type": "teleop_observation",
            "follower": self._latest_follower,
            "ts": time.time(),
        }
        if self._latest_leader is not None:
            output["leader"] = self._latest_leader
        emit(output)

    def destroy_node(self) -> bool:
        child = self._child
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGTERM)
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
        return super().destroy_node()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    source_driver = Path(__file__).resolve().parents[4] / "bridge" / "teleop_mujoco.py"
    if source_driver.is_file():
        default_driver = source_driver
    else:
        default_driver = (
            Path(get_package_share_directory("lerobot_ros2_bridge"))
            / "driver"
            / "teleop_mujoco.py"
        )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--driver", choices=("lerobot", "external"), default="lerobot")
    parser.add_argument("--follower-port", default="/dev/ttyACM0")
    parser.add_argument("--follower-id", default="")
    parser.add_argument("--leader-port", default="/dev/ttyACM1")
    parser.add_argument("--leader-id", default="")
    parser.add_argument("--fps", type=int, default=60)
    parser.add_argument("--stream-fps", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--viewer", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--command-timeout", type=float, default=0.15)
    parser.add_argument("--remote-leader", action="store_true")
    parser.add_argument(
        "--command-source",
        choices=("leader", "web", "ros"),
        default=os.environ.get("ROS2_COMMAND_SOURCE"),
        help="唯一控制源；未指定时由 --remote-leader 推断",
    )
    parser.add_argument(
        "--lerobot-python",
        default=os.environ.get("LEROBOT_PYTHON_PATH", os.environ.get("PYTHON_PATH", "python3")),
    )
    parser.add_argument(
        "--lerobot-driver-script",
        default=os.environ.get("LEROBOT_DRIVER_SCRIPT", str(default_driver)),
    )
    parser.add_argument("--leader-state-topic", default="/leader/joint_states")
    parser.add_argument("--follower-state-topic", default="/follower/joint_states")
    parser.add_argument("--camera1-topic", default="/camera1/image_raw/compressed")
    parser.add_argument("--camera2-topic", default="/camera2/image_raw/compressed")
    parser.add_argument("--capture-sync-slop", type=float, default=0.05)
    parser.add_argument("--capture-sync-queue", type=int, default=20)
    parser.add_argument(
        "--command-topic",
        default="/follower/joint_trajectory_controller/joint_trajectory",
    )
    args = parser.parse_args(argv)
    if args.command_source is None:
        args.command_source = "web" if args.remote_leader else "leader"
    return args


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.fps < 1 or args.fps > 200:
        raise SystemExit("--fps must be between 1 and 200")
    # argparse owns the executable flags; do not let rclpy parse them again.
    rclpy.init(args=[])
    node = LeRobotWebRosBridge(args)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    if node.driver_exit_code not in (None, 0):
        raise SystemExit(node.driver_exit_code)


if __name__ == "__main__":
    main()
