#!/usr/bin/env python3
"""
Robot Bridge - Follower 端桥接进程
连接 SO101 Follower 机械臂 + MuJoCo 仿真 + 摄像头采集
通过 stdio JSON 与 Node.js 进程通信。

输出格式 (stdout):
  - {"type": "observation", "joints": {...}, "ts": ...}
  - {"type": "camera_frame", "data": "<base64 JPEG>", "ts": ...}
  - {"type": "mujoco_frame", "data": "<base64 JPEG>", "ts": ...}

输入格式 (stdin):
  - {"type": "action", "joints": {...}}

用法:
    python robot_bridge.py --port /dev/ttyACM0 --robot-id R12253102 [--fps 30]
"""

import argparse
import base64
import json
import logging
import os
import sys
import threading
import time

import cv2
import draccus
import mujoco
import mujoco.viewer
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../lerobot/src"))

from lerobot.motors import Motor, MotorCalibration, MotorNormMode
from lerobot.motors.feetech import FeetechMotorsBus, OperatingMode

logging.basicConfig(level=logging.INFO, format="[RobotBridge] %(message)s")
logger = logging.getLogger(__name__)

MOTOR_NAMES = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "menagerie_so_arm100", "scene.xml")


def load_calibration(robot_id: str) -> dict:
    """从 lerobot 标准路径加载标定文件"""
    calib_path = os.path.expanduser(f"~/.lerobot/calibration/so101_follower/{robot_id}.json")
    if os.path.exists(calib_path):
        print(f"[RobotBridge] 加载标定文件: {calib_path}")
        with open(calib_path) as f:
            return draccus.load(dict, f)
    else:
        print(f"[RobotBridge] 警告: 标定文件不存在: {calib_path}")
        return {}


def create_follower_bus(port: str, robot_id: str) -> FeetechMotorsBus:
    """创建 follower 机械臂的 MotorsBus"""
    motors = {
        "shoulder_pan": Motor(1, "sts3215", MotorNormMode.DEGREES),
        "shoulder_lift": Motor(2, "sts3215", MotorNormMode.DEGREES),
        "elbow_flex": Motor(3, "sts3215", MotorNormMode.DEGREES),
        "wrist_flex": Motor(4, "sts3215", MotorNormMode.DEGREES),
        "wrist_roll": Motor(5, "sts3215", MotorNormMode.DEGREES),
        "gripper": Motor(6, "sts3215", MotorNormMode.RANGE_0_100),
    }
    calibration = load_calibration(robot_id)
    return FeetechMotorsBus(port=port, motors=motors, calibration=calibration)


class MuJoCoSim:
    """MuJoCo 仿真管理器"""

    def __init__(self, model_path: str, width: int = 320, height: int = 240):
        self.model = mujoco.MjModel.from_xml_path(model_path)
        self.data = mujoco.MjData(self.model)
        self.renderer = mujoco.Renderer(self.model, height=height, width=width)
        self.width = width
        self.height = height

        # 美化：白色机械臂
        for i in range(self.model.ngeom):
            self.model.geom_rgba[i] = [0.92, 0.92, 0.92, 1.0]
        # 地面深灰色
        for i in range(self.model.ngeom):
            if self.model.geom_type[i] == mujoco.mjtGeom.mjGEOM_PLANE:
                self.model.geom_rgba[i] = [0.3, 0.3, 0.3, 1.0]

        # 关节名称映射 (lerobot name -> MuJoCo Menagerie joint name)
        self.joint_map = {
            "shoulder_pan": "Rotation",
            "shoulder_lift": "Pitch",
            "elbow_flex": "Elbow",
            "wrist_flex": "Wrist_Pitch",
            "wrist_roll": "Wrist_Roll",
            "gripper": "Jaw",
        }

        # 渲染选项：阴影+反射
        self.renderer._scene.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = True
        self.renderer._scene.flags[mujoco.mjtRndFlag.mjRND_REFLECTION] = True

    def update_joints(self, joints: dict):
        """将 lerobot 关节角度写入 MuJoCo 仿真"""
        for lerobot_name, mj_name in self.joint_map.items():
            if lerobot_name in joints:
                joint_id = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_JOINT, mj_name)
                if joint_id >= 0:
                    qpos_addr = self.model.jnt_qposadr[joint_id]
                    # 将角度转换为弧度 (lerobot 输出为角度)
                    angle_rad = np.radians(joints[lerobot_name])
                    self.data.qpos[qpos_addr] = angle_rad

    def step(self):
        """推进仿真一步"""
        mujoco.mj_forward(self.model, self.data)

    def render(self) -> bytes:
        """渲染当前帧并返回 JPEG 字节（美化版）"""
        self.renderer.update_scene(self.data)
        # 设置灯光
        light = self.renderer._scene.lights[0]
        light.diffuse = np.array([1.0, 1.0, 1.0])
        light.specular = np.array([0.6, 0.6, 0.6])
        light.ambient = np.array([0.6, 0.6, 0.6])
        
        frame = self.renderer.render()
        
        # 后处理：黑色背景替换为浅蓝灰色渐变
        bg_color = np.array([195, 210, 220], dtype=np.uint8)
        mask = (frame.sum(axis=2) < 30)
        for y in range(frame.shape[0]):
            alpha = y / frame.shape[0]
            bg_row = np.array([195 + int(30*alpha), 210 + int(25*alpha), 220 + int(20*alpha)], dtype=np.uint8)
            row_mask = mask[y]
            frame[y, row_mask] = bg_row
        
        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return jpeg.tobytes()


class CameraCapture:
    """摄像头采集器"""

    def __init__(self, camera_index: int = 0, width: int = 640, height: int = 480):
        self.cap = cv2.VideoCapture(camera_index)
        if self.cap.isOpened():
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.available = self.cap.isOpened()
        if not self.available:
            logger.warning(f"摄像头 {camera_index} 不可用，将跳过摄像头帧")

    def read_frame(self) -> bytes | None:
        """读取一帧并返回 JPEG 字节"""
        if not self.available:
            return None
        ret, frame = self.cap.read()
        if not ret:
            return None
        _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return jpeg.tobytes()

    def release(self):
        if self.cap.isOpened():
            self.cap.release()


def stdin_reader_thread(input_queue: list):
    """从 stdin 读取控制指令的线程"""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            input_queue.append(msg)
        except json.JSONDecodeError:
            logger.warning(f"收到无效 JSON: {line[:100]}")


def main():
    parser = argparse.ArgumentParser(description="Robot Bridge - Follower 端桥接")
    parser.add_argument("--port", type=str, required=True, help="串口路径，如 /dev/ttyACM0")
    parser.add_argument("--robot-id", type=str, default="", help="Follower 机械臂 ID")
    parser.add_argument("--fps", type=int, default=30, help="循环频率 (默认 30)")
    parser.add_argument("--camera-index", type=int, default=0, help="摄像头设备索引 (默认 0)")
    parser.add_argument("--no-camera", action="store_true", help="禁用摄像头")
    parser.add_argument("--no-mujoco", action="store_true", help="禁用 MuJoCo 仿真")
    args = parser.parse_args()

    # 连接 follower 机械臂
    logger.info(f"连接 Follower 机械臂: port={args.port}")
    bus = create_follower_bus(args.port, args.robot_id)
    bus.connect()
    logger.info("Follower 连接成功")

    # 配置电机
    bus.disable_torque()
    for motor in MOTOR_NAMES:
        bus.write("Operating_Mode", motor, OperatingMode.POSITION.value)
        bus.write("P_Coefficient", motor, 16)
        bus.write("I_Coefficient", motor, 0)
        bus.write("D_Coefficient", motor, 0)
    logger.info("Follower 电机配置完成")

    # 初始化 MuJoCo
    sim = None
    if not args.no_mujoco and os.path.exists(MODEL_PATH):
        try:
            sim = MuJoCoSim(MODEL_PATH)
            logger.info(f"MuJoCo 仿真初始化成功: {MODEL_PATH}")
        except Exception as e:
            logger.warning(f"MuJoCo 初始化失败: {e}")
    elif not args.no_mujoco:
        logger.warning(f"MuJoCo 模型文件不存在: {MODEL_PATH}")

    # 初始化摄像头
    camera = None
    if not args.no_camera:
        camera = CameraCapture(args.camera_index)
        if camera.available:
            logger.info(f"摄像头 {args.camera_index} 初始化成功")
        else:
            camera = None

    # 启动 stdin 读取线程
    input_queue: list[dict] = []
    stdin_thread = threading.Thread(target=stdin_reader_thread, args=(input_queue,), daemon=True)
    stdin_thread.start()
    logger.info("stdin 读取线程已启动，等待控制指令...")

    period = 1.0 / args.fps
    frame_count = 0

    try:
        while True:
            loop_start = time.perf_counter()

            # 1. 读取 follower 关节角度
            # 如果没有标定，使用原始编码器值（normalize=False）
            try:
                positions = bus.sync_read("Present_Position")
            except RuntimeError:
                # 没有标定时，读取原始值
                positions = bus.sync_read("Present_Position", normalize=False)
            joints = {name: float(val) for name, val in positions.items()}

            # 输出关节角度
            obs_msg = {"type": "observation", "joints": joints, "ts": time.time()}
            print(json.dumps(obs_msg), flush=True)

            # 2. 更新 MuJoCo 并渲染
            if sim is not None:
                sim.update_joints(joints)
                sim.step()
                mujoco_jpeg = sim.render()
                mujoco_msg = {
                    "type": "mujoco_frame",
                    "data": base64.b64encode(mujoco_jpeg).decode("ascii"),
                    "ts": time.time(),
                }
                print(json.dumps(mujoco_msg), flush=True)

            # 3. 采集摄像头帧
            if camera is not None:
                cam_jpeg = camera.read_frame()
                if cam_jpeg is not None:
                    cam_msg = {
                        "type": "camera_frame",
                        "data": base64.b64encode(cam_jpeg).decode("ascii"),
                        "ts": time.time(),
                    }
                    print(json.dumps(cam_msg), flush=True)

            # 4. 处理控制指令
            while input_queue:
                cmd = input_queue.pop(0)
                if cmd.get("type") == "action":
                    goal_pos = cmd.get("joints", {})
                    # 过滤掉不存在的电机
                    goal_pos = {k: v for k, v in goal_pos.items() if k in bus.motors}
                    if goal_pos:
                        bus.sync_write("Goal_Position", goal_pos)

            # 5. 精确等待
            dt = time.perf_counter() - loop_start
            sleep_time = period - dt
            if sleep_time > 0:
                time.sleep(sleep_time)

            frame_count += 1
            if frame_count % 100 == 0:
                logger.info(f"已运行 {frame_count} 帧")

    except KeyboardInterrupt:
        logger.info("Robot Bridge 退出")
    finally:
        if camera:
            camera.release()
        bus.disconnect()
        logger.info("Follower 已断开")


if __name__ == "__main__":
    main()
