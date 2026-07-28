"""Pure joint-unit conversion helpers shared by the ROS bridge and tests."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

JOINT_NAMES = (
    "shoulder_pan",
    "shoulder_lift",
    "elbow_flex",
    "wrist_flex",
    "wrist_roll",
    "gripper",
)

# LeRobot exposes the arm joints in degrees and the gripper in the normalized
# 0..100 range. ROS JointState/JointTrajectory positions use SI units.
LEROBOT_TO_ROS_SCALE = {
    "shoulder_pan": math.pi / 180.0,
    "shoulder_lift": math.pi / 180.0,
    "elbow_flex": math.pi / 180.0,
    "wrist_flex": math.pi / 180.0,
    "wrist_roll": math.pi / 180.0,
    "gripper": (1.74533 - (-0.174533)) / 100.0,
}
LEROBOT_TO_ROS_OFFSET = {
    **{name: 0.0 for name in JOINT_NAMES},
    # SO-101 URDF revolute limit. LeRobot exposes this motor as 0..100.
    "gripper": -0.174533,
}


def lerobot_to_ros(joints: Mapping[str, float]) -> list[float]:
    """Return positions in canonical joint order and ROS-compatible units."""
    missing = [name for name in JOINT_NAMES if name not in joints]
    if missing:
        raise ValueError(f"missing joints: {', '.join(missing)}")
    positions = [
        float(joints[name]) * LEROBOT_TO_ROS_SCALE[name] + LEROBOT_TO_ROS_OFFSET[name]
        for name in JOINT_NAMES
    ]
    if not all(math.isfinite(value) for value in positions):
        raise ValueError("joint positions must be finite")
    return positions


def ros_to_lerobot(names: Sequence[str], positions: Sequence[float]) -> dict[str, float]:
    """Convert a named ROS position vector to the LeRobot command dictionary."""
    if len(names) != len(positions):
        raise ValueError("joint_names and positions must have equal length")
    by_name = dict(zip(names, positions, strict=True))
    missing = [name for name in JOINT_NAMES if name not in by_name]
    if missing:
        raise ValueError(f"missing joints: {', '.join(missing)}")
    result = {
        name: (float(by_name[name]) - LEROBOT_TO_ROS_OFFSET[name])
        / LEROBOT_TO_ROS_SCALE[name]
        for name in JOINT_NAMES
    }
    if not all(math.isfinite(value) for value in result.values()):
        raise ValueError("joint positions must be finite")
    return result
