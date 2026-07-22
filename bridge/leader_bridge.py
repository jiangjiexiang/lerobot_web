#!/usr/bin/env python3
"""
Leader Bridge - 读取 SO101 Leader 机械臂关节角度，通过 stdout 输出 JSON。
运行在操作电脑上，通过 stdio 与 Node.js 进程通信。

用法:
    python leader_bridge.py --port /dev/ttyACM1 --teleop-id R07253102 [--fps 30]
"""

import argparse
import json
import logging
import sys
import time
import os

# 将 lerobot 加入 path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../lerobot/src"))

from lerobot.motors import Motor, MotorNormMode
from lerobot.motors.feetech import FeetechMotorsBus

logging.basicConfig(level=logging.INFO, format="[LeaderBridge] %(message)s")
logger = logging.getLogger(__name__)

MOTOR_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]


def create_leader_bus(port: str) -> FeetechMotorsBus:
    """创建 leader 机械臂的 MotorsBus"""
    motors = {
        "shoulder_pan": Motor(1, "sts3215", MotorNormMode.DEGREES),
        "shoulder_lift": Motor(2, "sts3215", MotorNormMode.DEGREES),
        "elbow_flex": Motor(3, "sts3215", MotorNormMode.DEGREES),
        "wrist_flex": Motor(4, "sts3215", MotorNormMode.DEGREES),
        "wrist_roll": Motor(5, "sts3215", MotorNormMode.DEGREES),
        "gripper": Motor(6, "sts3215", MotorNormMode.RANGE_0_100),
    }
    return FeetechMotorsBus(port=port, motors=motors)


def main():
    parser = argparse.ArgumentParser(description="Leader Bridge - 读取 SO101 Leader 关节角度")
    parser.add_argument("--port", type=str, required=True, help="串口路径，如 /dev/ttyACM1")
    parser.add_argument("--teleop-id", type=str, default="", help="Leader 机械臂 ID（用于标定文件）")
    parser.add_argument("--fps", type=int, default=30, help="读取频率 (默认 30)")
    args = parser.parse_args()

    logger.info(f"连接 Leader 机械臂: port={args.port}")
    bus = create_leader_bus(args.port)
    bus.connect()
    logger.info("Leader 连接成功")

    # 配置为位置模式
    bus.disable_torque()
    for motor in MOTOR_NAMES:
        bus.write("Operating_Mode", motor, 1)  # POSITION mode
    logger.info("Leader 配置完成，开始读取循环")

    period = 1.0 / args.fps

    try:
        while True:
            loop_start = time.perf_counter()

            # 读取所有关节角度
            positions = bus.sync_read("Present_Position")
            joints = {name: float(val) for name, val in positions.items()}

            # 输出 JSON 到 stdout
            msg = {"type": "leader_observation", "joints": joints, "ts": time.time()}
            print(json.dumps(msg), flush=True)

            # 精确等待
            dt = time.perf_counter() - loop_start
            sleep_time = period - dt
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        logger.info("Leader Bridge 退出")
    finally:
        bus.disconnect()
        logger.info("Leader 已断开")


if __name__ == "__main__":
    main()
