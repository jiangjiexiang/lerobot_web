#!/usr/bin/env python3
"""Publish a deterministic synchronized capture stream for process tests."""

import base64

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import CompressedImage, JointState


JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkI"
    "BgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoK"
    "CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEB"
    "AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKB"
    "kaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1"
    "dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl"
    "5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcF"
    "BAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5"
    "OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0"
    "tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5fooor+Nz"
    "+AwooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/Z"
)


class CaptureFixture(Node):
    def __init__(self):
        super().__init__("lerobot_capture_fixture")
        self.leader_pub = self.create_publisher(JointState, "/leader/joint_states", 1)
        self.follower_pub = self.create_publisher(JointState, "/follower/joint_states", 1)
        self.camera1_pub = self.create_publisher(
            CompressedImage, "/camera1/image_raw/compressed", 1
        )
        self.camera2_pub = self.create_publisher(
            CompressedImage, "/camera2/image_raw/compressed", 1
        )
        self.timer = self.create_timer(0.025, self.publish_sample)

    def publish_sample(self):
        stamp = self.get_clock().now().to_msg()
        for publisher, positions in (
            (self.leader_pub, [0.1, -0.2, 0.3]),
            (self.follower_pub, [0.08, -0.18, 0.28]),
        ):
            message = JointState()
            message.header.stamp = stamp
            message.name = ["axis_a", "axis_b", "tool"]
            message.position = positions
            publisher.publish(message)
        for publisher, frame_id in (
            (self.camera1_pub, "camera1"),
            (self.camera2_pub, "camera2"),
        ):
            image = CompressedImage()
            image.header.stamp = stamp
            image.header.frame_id = frame_id
            image.format = "jpeg"
            image.data = JPEG
            publisher.publish(image)


def main():
    rclpy.init()
    node = CaptureFixture()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
