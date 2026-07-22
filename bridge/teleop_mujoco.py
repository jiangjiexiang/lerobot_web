#!/usr/bin/env python3
"""
单进程遥操作 + MuJoCo 镜像脚本
同时连接 Leader (ttyACM1) 和 Follower (ttyACM0)，Leader 控制 Follower，Follower 状态实时镜像到 MuJoCo。

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
import sys
import time

import cv2
import mujoco
import mujoco.viewer
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../lerobot/src"))

from lerobot.motors import Motor, MotorCalibration, MotorNormMode
from lerobot.motors.feetech import FeetechMotorsBus, OperatingMode

logging.basicConfig(level=logging.INFO, format="[Teleop] %(message)s")
logger = logging.getLogger(__name__)

MOTOR_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "menagerie_so_arm100", "scene.xml")


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


class MuJoCoSim:
    """MuJoCo 仿真管理器"""

    # lerobot 电机名称 -> MuJoCo Menagerie 关节名称
    JOINT_MAP = {
        "shoulder_pan": "Rotation",
        "shoulder_lift": "Pitch",
        "elbow_flex": "Elbow",
        "wrist_flex": "Wrist_Pitch",
        "wrist_roll": "Wrist_Roll",
        "gripper": "Jaw",
    }

    # 方向反转标志: True 表示真实机械臂的正方向对应模型的负方向
    # 根据机械臂安装方向和 Menagerie 模型关节轴方向调整
    JOINT_INVERT = {
        "shoulder_pan": False,
        "shoulder_lift": False,
        "elbow_flex": False,
        "wrist_flex": False,
        "wrist_roll": False,
        "gripper": False,
    }

    # STS3215 分辨率
    MOTOR_RESOLUTION = 4095

    # Full HD 网页流。帧率由 --fps 控制（前端可选 60 FPS）。
    def __init__(self, model_path: str, calibration: dict | None = None, width: int = 1920, height: int = 1080):
        self.model = mujoco.MjModel.from_xml_path(model_path)
        self.data = mujoco.MjData(self.model)
        self.renderer = mujoco.Renderer(self.model, height=height, width=width)
        self.width = width
        self.height = height

        self.renderer._scene.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = True
        self.renderer._scene.flags[mujoco.mjtRndFlag.mjRND_REFLECTION] = True

        # 计算每个关节的线性映射: 真实角度范围 → 模型弧度范围
        # model_rad = (input - real_min) / (real_max - real_min) * (model_max - model_min) + model_min
        self.joint_mapping = {}
        for lerobot_name, mj_name in self.JOINT_MAP.items():
            joint_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, mj_name)
            if joint_id < 0:
                continue

            qpos_addr = self.model.jnt_qposadr[joint_id]
            model_min = self.model.jnt_range[joint_id, 0]
            model_max = self.model.jnt_range[joint_id, 1]

            # 计算真实机械臂的角度范围
            if calibration and lerobot_name in calibration:
                cal = calibration[lerobot_name]
                mid = (cal.range_min + cal.range_max) / 2
                if lerobot_name == "gripper":
                    # RANGE_0_100 模式: 0 → 100
                    real_min, real_max = 0.0, 100.0
                else:
                    # DEGREES 模式
                    real_min = (cal.range_min - mid) * 360 / self.MOTOR_RESOLUTION
                    real_max = (cal.range_max - mid) * 360 / self.MOTOR_RESOLUTION
            else:
                # 无标定: 使用原始编码器值 0-4095
                real_min, real_max = 0.0, float(self.MOTOR_RESOLUTION)

            self.joint_mapping[lerobot_name] = {
                "qpos_addr": qpos_addr,
                "real_min": real_min,
                "real_max": real_max,
                "model_min": model_min,
                "model_max": model_max,
                "invert": self.JOINT_INVERT.get(lerobot_name, False),
            }

            invert_str = " (反转)" if self.JOINT_INVERT.get(lerobot_name, False) else ""
            logger.info(
                f"  关节映射 {lerobot_name}→{mj_name}: "
                f"真实[{real_min:.1f}, {real_max:.1f}] → 模型[{np.degrees(model_min):.1f}°, {np.degrees(model_max):.1f}°]{invert_str}"
            )

    def update_joints(self, joints: dict, raw: bool = False):
        """将关节角度写入 MuJoCo (线性映射，支持方向反转)"""
        for lerobot_name, val in joints.items():
            if lerobot_name not in self.joint_mapping:
                continue
            m = self.joint_mapping[lerobot_name]
            # 线性映射: real_range → model_range
            if m["real_max"] != m["real_min"]:
                ratio = (val - m["real_min"]) / (m["real_max"] - m["real_min"])
                ratio = max(0.0, min(1.0, ratio))  # clamp 0-1
                if m["invert"]:
                    ratio = 1.0 - ratio  # 反转方向
                angle_rad = ratio * (m["model_max"] - m["model_min"]) + m["model_min"]
            else:
                angle_rad = m["model_min"]
            self.data.qpos[m["qpos_addr"]] = angle_rad

    def step(self):
        mujoco.mj_forward(self.model, self.data)

    def render(self) -> bytes:
        self.renderer.update_scene(self.data)
        light = self.renderer._scene.lights[0]
        light.diffuse = np.array([1.0, 1.0, 1.0])
        light.specular = np.array([0.6, 0.6, 0.6])
        light.ambient = np.array([0.6, 0.6, 0.6])
        frame = self.renderer.render()
        # MuJoCo 返回 RGB，OpenCV 编码前转换为 BGR，避免颜色失真。
        frame_bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        _, jpeg = cv2.imencode(
            ".jpg", frame_bgr,
            [cv2.IMWRITE_JPEG_QUALITY, 96, cv2.IMWRITE_JPEG_OPTIMIZE, 1],
        )
        return jpeg.tobytes()


def main():
    parser = argparse.ArgumentParser(description="单进程遥操作 + MuJoCo 镜像")
    parser.add_argument("--follower-port", type=str, required=True, help="Follower 串口")
    parser.add_argument("--follower-id", type=str, default="", help="Follower ID")
    parser.add_argument("--leader-port", type=str, required=True, help="Leader 串口")
    parser.add_argument("--leader-id", type=str, default="", help="Leader ID")
    parser.add_argument("--fps", type=int, default=30, help="循环频率")
    parser.add_argument("--viewer", action="store_true", help="打开 MuJoCo 交互式查看器")
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

    # === 连接 Leader ===
    logger.info(f"连接 Leader: port={args.leader_port}")
    leader_bus, leader_has_calib = create_bus(args.leader_port, "so101_leader", args.leader_id)
    leader_bus.connect()
    leader_bus.disable_torque()
    logger.info(f"Leader 连接成功 (仅读取模式, 标定: {'有' if leader_has_calib else '无'})")

    # 无标定时用原始编码器值
    use_raw = not (follower_has_calib and leader_has_calib)
    if use_raw:
        logger.warning("无标定文件，使用原始编码器值 (0-4095)，MuJoCo 将按原始值映射弧度")

    # === 初始化 MuJoCo ===
    follower_calib = follower_bus.calibration
    sim = MuJoCoSim(MODEL_PATH, calibration=follower_calib)
    logger.info(f"MuJoCo 仿真初始化成功: {MODEL_PATH}")

    # 加载 home 关键帧
    if sim.model.nkey > 0:
        mujoco.mj_resetDataKeyframe(sim.model, sim.data, 0)
        mujoco.mj_forward(sim.model, sim.data)
        logger.info("已加载 home 关键帧")

    period = 1.0 / args.fps
    frame_count = 0

    if args.viewer:
        # === 交互式查看器模式 ===
        logger.info("启动 MuJoCo 交互式查看器...")
        logger.info("按 ESC 或关闭窗口退出")

        with mujoco.viewer.launch_passive(sim.model, sim.data) as viewer:
            viewer.opt.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = True
            viewer.opt.flags[mujoco.mjtRndFlag.mjRND_REFLECTION] = True
            viewer.opt.flags[mujoco.mjtRndFlag.mjRND_SKYBOX] = True
            viewer.opt.flags[mujoco.mjtVisFlag.mjVIS_TRANSPARENT] = True

            logger.info("查看器已打开，开始遥操作循环")
            while viewer.is_running():
                loop_start = time.perf_counter()

                # 1. 读取 leader 角度
                leader_joints = read_positions(leader_bus, normalize=not use_raw)

                # 2. 发送 leader 角度到 follower
                goal_pos = {k: v for k, v in leader_joints.items() if k in follower_bus.motors}
                if goal_pos:
                    write_positions(follower_bus, goal_pos, normalize=not use_raw)

                # 3. 读取 follower 实际角度
                follower_joints = read_positions(follower_bus, normalize=not use_raw)

                # 4. 更新 MuJoCo
                sim.update_joints(follower_joints, raw=use_raw)
                sim.step()

                # 5. 同步查看器
                viewer.sync()

                # 6. 输出 JSON
                msg = {
                    "type": "teleop_observation",
                    "leader": leader_joints,
                    "follower": follower_joints,
                    "ts": time.time(),
                }
                print(json.dumps(msg), flush=True)

                # 同时输出网页所需的离屏帧。这样开启原生查看器时，浏览器也能显示仿真画面。
                mujoco_jpeg = sim.render()
                mujoco_msg = {
                    "type": "mujoco_frame",
                    "data": base64.b64encode(mujoco_jpeg).decode("ascii"),
                    "ts": time.time(),
                }
                print(json.dumps(mujoco_msg), flush=True)

                # 等待
                dt = time.perf_counter() - loop_start
                sleep_time = period - dt
                if sleep_time > 0:
                    time.sleep(sleep_time)

                frame_count += 1
                if frame_count % 100 == 0:
                    logger.info(f"已运行 {frame_count} 帧 | leader_pan={leader_joints.get('shoulder_pan', 0):.1f} follower_pan={follower_joints.get('shoulder_pan', 0):.1f}")

    else:
        # === 离屏渲染模式 ===
        logger.info("开始遥操作循环 (离屏渲染)")
        try:
            while True:
                loop_start = time.perf_counter()

                # 1. 读取 leader 角度
                leader_joints = read_positions(leader_bus, normalize=not use_raw)

                # 2. 发送到 follower
                goal_pos = {k: v for k, v in leader_joints.items() if k in follower_bus.motors}
                if goal_pos:
                    write_positions(follower_bus, goal_pos, normalize=not use_raw)

                # 3. 读取 follower 实际角度
                follower_joints = read_positions(follower_bus, normalize=not use_raw)

                # 4. 更新 MuJoCo + 渲染
                sim.update_joints(follower_joints, raw=use_raw)
                sim.step()

                # 5. 输出 JSON
                obs_msg = {
                    "type": "teleop_observation",
                    "leader": leader_joints,
                    "follower": follower_joints,
                    "ts": time.time(),
                }
                print(json.dumps(obs_msg), flush=True)

                # 6. 输出 MuJoCo 帧
                mujoco_jpeg = sim.render()
                mujoco_msg = {
                    "type": "mujoco_frame",
                    "data": base64.b64encode(mujoco_jpeg).decode("ascii"),
                    "ts": time.time(),
                }
                print(json.dumps(mujoco_msg), flush=True)

                # 等待
                dt = time.perf_counter() - loop_start
                sleep_time = period - dt
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
    leader_bus.disconnect()
    logger.info("已断开所有连接")


if __name__ == "__main__":
    main()
