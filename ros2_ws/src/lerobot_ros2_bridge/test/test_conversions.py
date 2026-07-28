import math
import unittest

from lerobot_ros2_bridge.conversions import JOINT_NAMES, lerobot_to_ros, ros_to_lerobot


class ConversionTests(unittest.TestCase):
    def test_joint_conversion_round_trip_and_reordering(self):
        source = {
            "shoulder_pan": 90.0,
            "shoulder_lift": -45.0,
            "elbow_flex": 10.0,
            "wrist_flex": 20.0,
            "wrist_roll": -30.0,
            "gripper": 75.0,
        }
        ros_positions = lerobot_to_ros(source)
        self.assertAlmostEqual(ros_positions[0], math.pi / 2)
        self.assertAlmostEqual(ros_positions[-1], -0.174533 + 0.75 * 1.919863)

        reversed_names = list(reversed(JOINT_NAMES))
        reversed_positions = list(reversed(ros_positions))
        round_trip = ros_to_lerobot(reversed_names, reversed_positions)
        for name, expected in source.items():
            self.assertAlmostEqual(round_trip[name], expected)

    def test_conversion_rejects_partial_or_non_finite_commands(self):
        with self.assertRaisesRegex(ValueError, "missing joints"):
            lerobot_to_ros({"shoulder_pan": 0.0})
        with self.assertRaisesRegex(ValueError, "finite"):
            ros_to_lerobot(JOINT_NAMES, [0.0, 0.0, 0.0, 0.0, math.nan, 0.0])


if __name__ == "__main__":
    unittest.main()
