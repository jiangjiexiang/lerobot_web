import base64
import time
import unittest
from unittest.mock import patch

import rclpy

from lerobot_ros2_bridge.idle_topics import IdleTopicsNode, parse_args


class IdleTopicsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rclpy.init(args=[])

    @classmethod
    def tearDownClass(cls):
        if rclpy.ok():
            rclpy.shutdown()

    def make_node(self):
        namespace = f"/idle_test/t{time.time_ns()}"
        args = parse_args(
            [
                "--follower-state-topic",
                f"{namespace}/follower",
                "--camera1-topic",
                f"{namespace}/camera1",
                "--camera2-topic",
                f"{namespace}/camera2",
            ]
        )
        return IdleTopicsNode(args, start_stdio_thread=False), args

    def test_registers_follower_and_camera_publishers(self):
        node, args = self.make_node()
        try:
            topics = dict(node.get_topic_names_and_types())
            self.assertEqual(topics[args.follower_state_topic], ["sensor_msgs/msg/JointState"])
            self.assertEqual(topics[args.camera1_topic], ["sensor_msgs/msg/CompressedImage"])
            self.assertEqual(topics[args.camera2_topic], ["sensor_msgs/msg/CompressedImage"])
        finally:
            node.destroy_node()

    def test_publishes_camera_frame_from_stdio_message(self):
        node, _ = self.make_node()
        try:
            with patch.object(node._camera1_pub, "publish") as publish:
                node._publish_camera(
                    {
                        "camera": "camera1",
                        "data": base64.b64encode(b"jpeg-data").decode("ascii"),
                        "ts": 123.25,
                    }
                )
            message = publish.call_args.args[0]
            self.assertEqual(bytes(message.data), b"jpeg-data")
            self.assertEqual(message.header.stamp.sec, 123)
            self.assertEqual(message.header.frame_id, "camera1")
        finally:
            node.destroy_node()

    def test_publishes_follower_state_when_provided(self):
        node, _ = self.make_node()
        try:
            with patch.object(node._follower_pub, "publish") as publish:
                node._publish_follower({"joints": {"joint_a": 0.25, "joint_b": -0.5}})
            message = publish.call_args.args[0]
            self.assertEqual(message.name, ["joint_a", "joint_b"])
            self.assertEqual(list(message.position), [0.25, -0.5])
        finally:
            node.destroy_node()


if __name__ == "__main__":
    unittest.main()
