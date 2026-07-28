#!/usr/bin/env python3
"""
LeRobot SO-101 串口驱动。

同时连接 Leader 和 Follower，或接受 ROS 2 适配层经 stdin 发送的动作。
文件名为兼容既有启动配置暂时保留；当前不加载或运行 MuJoCo。

用法:
    python teleop_mujoco.py \
        --follower-port /dev/ttyACM0 --follower-id R12253102 \
        --leader-port /dev/ttyACM1  --leader-id R07253102 \
        [--fps 30] [--viewer]
"""

import argparse
import base64
import json
import logging
import os
import signal
import sys
import threading
import time

import cv2
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
                    self._updated_at = time.monotonic()
            except (ValueError, TypeError, json.JSONDecodeError):
                continue

    def latest(self, timeout_s: float) -> dict | None:
        with self._lock:
            if self._joints is None or time.monotonic() - self._updated_at > timeout_s:
                return None
            return dict(self._joints)


class CameraCapture:
    """机器人电脑本地摄像头采集；失败不影响遥操作主循环。"""
    def __init__(self, index: int, width: int = 960, height: int = 540):
        self.cap = cv2.VideoCapture(index)
        self.available = self.cap.isOpened()
        if self.available:
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        else:
            logger.warning(f"摄像头 {index} 不可用，继续运行但不输出摄像头画面")

    def read_jpeg(self) -> bytes | None:
        if not self.available:
            return None
        ok, frame = self.cap.read()
        if not ok:
            return None
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return jpeg.tobytes() if ok else None

    def release(self):
        if self.cap.isOpened():
            self.cap.release()


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
    parser.add_argument("--stream-fps", type=int, default=20, help="网页 MuJoCo 画面最大帧率（与控制频率独立）")
    parser.add_argument("--stream-jpeg-quality", type=int, default=82, help="网页 MuJoCo JPEG 质量（1-100）")
    parser.add_argument("--viewer", action="store_true", help="打开 MuJoCo 交互式查看器")
    parser.add_argument("--remote-leader", action="store_true", help="从 stdin 接收网页 Leader 动作")
    parser.add_argument(
        "--external-command",
        action="store_true",
        help="Follower 只执行 stdin 动作；Leader 仍只读并作为观测输出（供 ROS 2 适配层使用）",
    )
    parser.add_argument("--command-timeout", type=float, default=0.15, help="远程动作超时秒数")
    parser.add_argument("--camera-index", type=int, default=-1, help="摄像头索引；-1 禁用")
    parser.add_argument("--camera-fps", type=int, default=15, help="摄像头最大帧率")
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
    command_input = RemoteLeaderInput() if args.remote_leader or args.external_command else None
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
        if args.external_command:
            logger.info("外部命令模式：Leader 只发布观测，Follower 仅执行 stdin 命令")

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
        if args.external_command:
            follower_bus.disable_torque()
            follower_bus.disconnect(disable_torque=False)
            if leader_bus is not None:
                leader_bus.disconnect()
            parser.error("ROS 2 外部命令模式要求 Leader 和 Follower 标定完整，拒绝使用原始编码器单位")
        logger.warning("无标定文件，使用原始编码器值 (0-4095)")

    period = 1.0 / args.fps
    frame_count = 0
    logger.info(f"控制频率: {args.fps} FPS")
    camera = CameraCapture(args.camera_index) if args.camera_index >= 0 else None
    if camera and camera.available:
        logger.info(f"摄像头 {args.camera_index} 初始化成功（最大 {args.camera_fps} FPS）")
    next_camera_frame = 0.0

    def emit_camera_frame():
        nonlocal next_camera_frame
        if camera is None or not camera.available or time.monotonic() < next_camera_frame:
            return
        next_camera_frame = time.monotonic() + 1.0 / max(1, args.camera_fps)
        jpeg = camera.read_jpeg()
        if jpeg:
            print(json.dumps({"type": "camera_frame", "data": base64.b64encode(jpeg).decode("ascii"), "ts": time.time()}), flush=True)

    def get_leader_joints() -> dict:
        if args.remote_leader:
            return command_input.latest(args.command_timeout) or {}
        return read_positions(leader_bus, normalize=not use_raw)

    def get_follower_goal(leader_joints: dict) -> dict:
        source = command_input.latest(args.command_timeout) if args.external_command else leader_joints
        return {k: v for k, v in (source or {}).items() if k in follower_bus.motors}

    logger.info("开始遥操作循环")
    try:
        while True:
            loop_start = time.perf_counter()
            leader_joints = get_leader_joints()
            goal_pos = get_follower_goal(leader_joints)
            if goal_pos:
                write_positions(follower_bus, goal_pos, normalize=not use_raw)
            follower_joints = read_positions(follower_bus, normalize=not use_raw)
            print(json.dumps({
                "type": "teleop_observation",
                "leader": leader_joints,
                "follower": follower_joints,
                "ts": time.time(),
            }), flush=True)
            emit_camera_frame()

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
    if camera is not None:
        camera.release()
    if leader_bus is not None:
        leader_bus.disconnect()
    logger.info("已断开所有连接")


if __name__ == "__main__":
    main()
