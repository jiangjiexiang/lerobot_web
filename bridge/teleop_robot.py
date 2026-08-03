#!/usr/bin/env python3
"""
LeRobot SO-101 串口驱动。

同时连接 Leader 和 Follower，或接受网页经 stdin 发送的动作。

用法:
    python teleop_robot.py \
        --follower-port /dev/ttyACM0 --follower-id R12253102 \
        --leader-port /dev/ttyACM1  --leader-id R07253102 \
        [--fps 30]
"""

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../lerobot/src"))

from lerobot.motors import Motor, MotorCalibration, MotorNormMode
from lerobot.motors.feetech import FeetechMotorsBus, OperatingMode

logging.basicConfig(level=logging.INFO, format="[Teleop] %(message)s")
logger = logging.getLogger(__name__)

MOTOR_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
class RemoteLeaderInput:
    """从 stdin 接收 robot-server 转发的网页 Leader 动作；永不写入 Leader 串口。"""
    def __init__(self):
        self._lock = threading.Lock()
        self._joints: dict[str, float] | None = None
        self._sequence: int | None = None
        self._updated_at = 0.0
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self):
        for line in sys.stdin:
            try:
                msg = json.loads(line)
                joints = msg.get("joints") if msg.get("type") == "action" else None
                if not isinstance(joints, dict):
                    continue
                values = {name: float(joints[name]) for name in MOTOR_NAMES if name in joints}
                if len(values) != len(MOTOR_NAMES) or not all(np.isfinite(v) for v in values.values()):
                    continue
                with self._lock:
                    self._joints = values
                    sequence = msg.get("seq")
                    self._sequence = sequence if isinstance(sequence, int) and sequence >= 0 else None
                    self._updated_at = time.monotonic()
            except (ValueError, TypeError, json.JSONDecodeError):
                continue

    def latest(self, timeout_s: float) -> tuple[dict, int | None] | None:
        with self._lock:
            if self._joints is None or time.monotonic() - self._updated_at > timeout_s:
                return None
            return dict(self._joints), self._sequence


def load_calibration(robot_type: str, robot_id: str) -> dict:
    """从 lerobot 标准路径加载标定文件，返回 MotorCalibration 字典"""
    calib_path = os.path.expanduser(f"~/.lerobot/calibration/{robot_type}/{robot_id}.json")
    if os.path.exists(calib_path):
        logger.info(f"加载标定文件: {calib_path}")
        with open(calib_path) as f:
            raw = json.load(f)
        return {name: MotorCalibration(**data) for name, data in raw.items()}
    else:
        logger.warning(f"标定文件不存在: {calib_path}")
        return {}


def create_bus(port: str, robot_type: str, robot_id: str) -> FeetechMotorsBus:
    """创建 MotorsBus"""
    motors = {
        "shoulder_pan": Motor(1, "sts3215", MotorNormMode.DEGREES),
        "shoulder_lift": Motor(2, "sts3215", MotorNormMode.DEGREES),
        "elbow_flex": Motor(3, "sts3215", MotorNormMode.DEGREES),
        "wrist_flex": Motor(4, "sts3215", MotorNormMode.DEGREES),
        "wrist_roll": Motor(5, "sts3215", MotorNormMode.DEGREES),
        "gripper": Motor(6, "sts3215", MotorNormMode.RANGE_0_100),
    }
    calib = load_calibration(robot_type, robot_id)
    bus = FeetechMotorsBus(port=port, motors=motors, calibration=calib)
    return bus, bool(calib)


def read_positions(bus: FeetechMotorsBus, *, normalize: bool = True) -> dict:
    """读取关节角度"""
    positions = bus.sync_read("Present_Position", normalize=normalize)
    return {name: int(val) if not normalize else float(val) for name, val in positions.items()}


def complete_joint_state(joints: dict) -> bool:
    """判断一组关节读数是否包含 SO-101 全部 6 个有效关节。"""
    return (
        isinstance(joints, dict)
        and all(name in joints for name in MOTOR_NAMES)
        and all(np.isfinite(value) for value in joints.values())
    )


def write_positions(bus: FeetechMotorsBus, goal_pos: dict, *, normalize: bool = True):
    """写入目标位置"""
    if not normalize:
        # 原始模式需要整数（位运算要求）
        goal_pos = {k: int(round(v)) for k, v in goal_pos.items()}
    bus.sync_write("Goal_Position", goal_pos, normalize=normalize)


def main():
    parser = argparse.ArgumentParser(description="LeRobot SO-101 串口驱动")
    parser.add_argument("--follower-port", type=str, required=True, help="Follower 串口")
    parser.add_argument("--follower-id", type=str, default="", help="Follower ID")
    parser.add_argument("--leader-port", type=str, default="", help="Leader 串口")
    parser.add_argument("--leader-id", type=str, default="", help="Leader ID")
    parser.add_argument("--fps", type=int, default=60, help="控制循环频率")
    parser.add_argument("--observation-fps", type=int, default=30, help="Follower 状态读取频率")
    parser.add_argument("--remote-leader", action="store_true", help="从 stdin 接收网页 Leader 动作")
    parser.add_argument("--command-timeout", type=float, default=0.15, help="远程动作超时秒数")
    args = parser.parse_args()

    # === 连接 Follower ===
    logger.info(f"连接 Follower: port={args.follower_port}")
    follower_bus, follower_has_calib = create_bus(args.follower_port, "so101_follower", args.follower_id)
    follower_bus.connect()
    logger.info(f"Follower 连接成功 (标定: {'有' if follower_has_calib else '无'})")

    # 配置 follower 电机
    follower_bus.disable_torque()
    for motor in MOTOR_NAMES:
        follower_bus.write("Operating_Mode", motor, OperatingMode.POSITION.value)
        follower_bus.write("P_Coefficient", motor, 16)
        follower_bus.write("I_Coefficient", motor, 0)
        follower_bus.write("D_Coefficient", motor, 0)
    follower_bus.enable_torque()
    logger.info("Follower 电机配置完成 (位置模式)")

    # === 连接 Leader / 接收远程 Leader ===
    command_input = RemoteLeaderInput() if args.remote_leader else None
    leader_bus = None
    if args.remote_leader:
        leader_has_calib = True
        logger.info(f"远程 Leader 模式：等待网页动作（超时 {args.command_timeout:.2f}s 时保持当前位置）")
    else:
        if not args.leader_port:
            parser.error("本机 Leader 模式必须提供 --leader-port")
        logger.info(f"连接 Leader: port={args.leader_port}")
        leader_bus, leader_has_calib = create_bus(args.leader_port, "so101_leader", args.leader_id)
        leader_bus.connect()
        leader_bus.disable_torque()
        logger.info(f"Leader 连接成功 (仅读取模式, 标定: {'有' if leader_has_calib else '无'})")

    def shutdown_from_signal(signum, _frame):
        """Node 停止子进程时确保从臂不再保持扭矩。"""
        logger.warning(f"收到信号 {signum}，正在关闭 Follower 扭矩")
        try:
            follower_bus.disable_torque()
            follower_bus.disconnect(disable_torque=False)
        except Exception as exc:  # 信号处理路径必须尽力清理，不能再次阻塞退出
            logger.warning(f"Follower 清理失败: {exc}")
        try:
            if leader_bus is not None:
                leader_bus.disconnect()
        except Exception:
            pass
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, shutdown_from_signal)

    # 无标定时用原始编码器值
    use_raw = not (follower_has_calib and leader_has_calib)
    if use_raw:
        logger.warning("无标定文件，使用原始编码器值 (0-4095)")

    period = 1.0 / args.fps
    frame_count = 0
    last_missing_observation_log = 0.0
    logger.info(f"控制频率: {args.fps} FPS")
    observation_period = 1.0 / max(1, min(args.fps, args.observation_fps))
    next_observation_at = 0.0

    logger.info("开始遥操作循环")
    try:
        while True:
            loop_start = time.perf_counter()
            remote_command = command_input.latest(args.command_timeout) if args.remote_leader else None
            leader_joints = remote_command[0] if remote_command else (
                {} if args.remote_leader else read_positions(leader_bus, normalize=not use_raw)
            )
            follower_command = remote_command if args.remote_leader else (leader_joints, None)
            source_joints = follower_command[0] if follower_command else {}
            applied_sequence = follower_command[1] if follower_command else None
            goal_pos = {k: v for k, v in source_joints.items() if k in follower_bus.motors}
            if goal_pos:
                write_positions(follower_bus, goal_pos, normalize=not use_raw)
            if time.perf_counter() >= next_observation_at:
                next_observation_at = loop_start + observation_period
                follower_joints = read_positions(follower_bus, normalize=not use_raw)
                if complete_joint_state(leader_joints) and complete_joint_state(follower_joints):
                    observation = {
                        "type": "teleop_observation",
                        "leader": leader_joints,
                        "follower": follower_joints,
                        "ts": time.time(),
                    }
                    if applied_sequence is not None:
                        observation["applied_seq"] = applied_sequence
                    print(json.dumps(observation), flush=True)
                else:
                    now = time.monotonic()
                    if now - last_missing_observation_log >= 5.0:
                        logger.warning(
                            "跳过不完整关节采样: leader=%d follower=%d",
                            len(leader_joints),
                            len(follower_joints),
                        )
                        last_missing_observation_log = now
            sleep_time = period - (time.perf_counter() - loop_start)
            if sleep_time > 0:
                time.sleep(sleep_time)
            frame_count += 1
            if frame_count % 100 == 0:
                logger.info(f"已运行 {frame_count} 帧")
    except KeyboardInterrupt:
        logger.info("遥操作退出")

    # 清理
    follower_bus.disable_torque()
    follower_bus.disconnect()
    if leader_bus is not None:
        leader_bus.disconnect()
    logger.info("已断开所有连接")


if __name__ == "__main__":
    main()
