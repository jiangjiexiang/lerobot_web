#!/usr/bin/env python3
"""
MuJoCo SO-101 测试脚本
测试模型加载、离屏渲染、关节控制。

用法:
    # 测试离屏渲染（保存一帧到文件）
    python test_mujoco.py

    # 打开交互式查看器（需要 GUI 支持）
    python test_mujoco.py --viewer

    # 测试关节运动动画
    python test_mujoco.py --animate
"""

import argparse
import os
import sys
import time

import cv2
import mujoco
import mujoco.viewer
import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "menagerie_so_arm100", "scene.xml")

# lerobot 电机名称 -> MuJoCo 关节名称 (Menagerie SO-ARM100)
JOINT_MAP = {
    "shoulder_pan": "Rotation",
    "shoulder_lift": "Pitch",
    "elbow_flex": "Elbow",
    "wrist_flex": "Wrist_Pitch",
    "wrist_roll": "Wrist_Roll",
    "gripper": "Jaw",
}


def test_load_model():
    """测试加载模型"""
    print(f"加载模型: {MODEL_PATH}")
    model = mujoco.MjModel.from_xml_path(MODEL_PATH)
    data = mujoco.MjData(model)
    print(f"  模型加载成功!")
    print(f"  关节数: {model.nq}")
    print(f"  执行器数: {model.nu}")
    print(f"  几何体数: {model.ngeom}")
    print(f"  刚体数: {model.nbody}")

    # 列出所有关节
    print("\n  关节列表:")
    for i in range(model.nq):
        joint_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, i)
        print(f"    [{i}] {joint_name}")

    return model, data


def test_offscreen_render(model, data, output_path="test_frame.png"):
    """测试离屏渲染（美化版）"""
    print(f"\n测试离屏渲染...")
    renderer = mujoco.Renderer(model, height=480, width=640)
    
    # 白色机械臂
    for i in range(model.ngeom):
        model.geom_rgba[i] = [0.95, 0.95, 0.95, 1.0]
    for i in range(model.ngeom):
        if model.geom_type[i] == mujoco.mjtGeom.mjGEOM_PLANE:
            model.geom_rgba[i] = [0.3, 0.3, 0.3, 1.0]
    
    mujoco.mj_forward(model, data)
    renderer.update_scene(data)
    
    # 阴影
    renderer._scene.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = True
    
    # 灯光增强
    light = renderer._scene.lights[0]
    light.diffuse = np.array([1.0, 1.0, 1.0])
    light.specular = np.array([0.6, 0.6, 0.6])
    light.ambient = np.array([0.6, 0.6, 0.6])
    
    frame = renderer.render()
    
    # 后处理：黑色背景替换为浅蓝灰色渐变
    mask = (frame.sum(axis=2) < 30)
    for y in range(frame.shape[0]):
        alpha = y / frame.shape[0]
        bg_row = np.array([195 + int(30*alpha), 210 + int(25*alpha), 220 + int(20*alpha)], dtype=np.uint8)
        row_mask = mask[y]
        frame[y, row_mask] = bg_row
    
    cv2.imwrite(output_path, frame)
    print(f"  帧已保存到: {output_path}")
    print(f"  帧尺寸: {frame.shape}")
    renderer.close()
    return frame


def test_joint_control(model, data):
    """测试关节控制"""
    print("\n测试关节控制...")

    # 获取关节 qpos 地址
    joint_info = {}
    for lerobot_name, mj_name in JOINT_MAP.items():
        joint_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, mj_name)
        if joint_id >= 0:
            qpos_addr = model.jnt_qposadr[joint_id]
            joint_info[lerobot_name] = {
                "mj_name": mj_name,
                "joint_id": joint_id,
                "qpos_addr": qpos_addr,
            }
            print(f"  {lerobot_name} -> joint_id={joint_id}, qpos_addr={qpos_addr}")

    # 设置一些测试角度（度）
    test_angles = {
        "shoulder_pan": 45.0,
        "shoulder_lift": -30.0,
        "elbow_flex": 60.0,
        "wrist_flex": -20.0,
        "wrist_roll": 0.0,
        "gripper": 0.0,
    }

    print(f"\n设置测试角度: {test_angles}")
    for name, angle_deg in test_angles.items():
        if name in joint_info:
            info = joint_info[name]
            angle_rad = np.radians(angle_deg)
            data.qpos[info["qpos_addr"]] = angle_rad

    mujoco.mj_forward(model, data)
    print("  角度已设置")

    # 打印当前关节位置
    print("\n当前关节位置 (弧度):")
    for name, info in joint_info.items():
        print(f"  {name}: {data.qpos[info['qpos_addr']]:.4f} rad = {np.degrees(data.qpos[info['qpos_addr']]):.2f} deg")

    return joint_info


def test_animate(model, data, duration=5.0):
    """测试关节运动动画（离屏渲染）"""
    print(f"\n测试关节运动动画 ({duration}秒)...")
    renderer = mujoco.Renderer(model, height=480, width=640)

    joint_info = {}
    for lerobot_name, mj_name in JOINT_MAP.items():
        joint_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, mj_name)
        if joint_id >= 0:
            qpos_addr = model.jnt_qposadr[joint_id]
            joint_info[lerobot_name] = {"qpos_addr": qpos_addr}

    fps = 30
    total_frames = int(duration * fps)
    output_dir = os.path.join(os.path.dirname(__file__), "test_frames")
    os.makedirs(output_dir, exist_ok=True)

    print(f"  渲染 {total_frames} 帧...")
    start = time.perf_counter()

    for frame_idx in range(total_frames):
        t = frame_idx / fps

        # shoulder_pan 左右摆动
        angle = 45.0 * np.sin(2 * np.pi * t / duration)
        if "shoulder_pan" in joint_info:
            data.qpos[joint_info["shoulder_pan"]["qpos_addr"]] = np.radians(angle)

        # shoulder_lift 上下摆动
        angle2 = 30.0 * np.sin(2 * np.pi * t / duration + np.pi / 4)
        if "shoulder_lift" in joint_info:
            data.qpos[joint_info["shoulder_lift"]["qpos_addr"]] = np.radians(angle2)

        mujoco.mj_forward(model, data)
        renderer.update_scene(data)
        frame = renderer.render()

        # 保存部分帧
        if frame_idx % 10 == 0:
            path = os.path.join(output_dir, f"frame_{frame_idx:04d}.png")
            cv2.imwrite(path, frame)

    elapsed = time.perf_counter() - start
    print(f"  完成! {total_frames} 帧, 耗时 {elapsed:.2f}s ({total_frames/elapsed:.1f} fps)")
    print(f"  帧保存在: {output_dir}/")
    renderer.close()


def test_viewer(model, data):
    """打开交互式查看器（美化版）"""
    print("\n打开 MuJoCo 交互式查看器...")
    print("按 ESC 或关闭窗口退出")

    # 设置初始角度
    joint_info = {}
    for lerobot_name, mj_name in JOINT_MAP.items():
        joint_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, mj_name)
        if joint_id >= 0:
            qpos_addr = model.jnt_qposadr[joint_id]
            joint_info[lerobot_name] = {"qpos_addr": qpos_addr}

    initial_angles = {
        "shoulder_pan": 0.0,
        "shoulder_lift": -45.0,
        "elbow_flex": 90.0,
        "wrist_flex": -45.0,
        "wrist_roll": 0.0,
        "gripper": 50.0,
    }
    for name, angle_deg in initial_angles.items():
        if name in joint_info:
            data.qpos[joint_info[name]["qpos_addr"]] = np.radians(angle_deg)

    # 白色机械臂
    for i in range(model.ngeom):
        model.geom_rgba[i] = [0.92, 0.92, 0.92, 1.0]

    # 地面改为浅灰色网格
    for i in range(model.ngeom):
        if model.geom_type[i] == mujoco.mjtGeom.mjGEOM_PLANE:
            model.geom_rgba[i] = [0.85, 0.85, 0.85, 1.0]

    mujoco.mj_forward(model, data)

    with mujoco.viewer.launch_passive(model, data) as viewer:
        # 渲染标志：阴影+反射
        viewer.opt.flags[mujoco.mjtRndFlag.mjRND_SHADOW] = True
        viewer.opt.flags[mujoco.mjtRndFlag.mjRND_REFLECTION] = True
        viewer.opt.flags[mujoco.mjtRndFlag.mjRND_SKYBOX] = True
        viewer.opt.flags[mujoco.mjtVisFlag.mjVIS_TRANSPARENT] = True

        print("查看器已打开（美化模式）")
        while viewer.is_running():
            step_start = time.perf_counter()
            mujoco.mj_step(model, data)
            viewer.sync()
            time.sleep(max(0, 0.033 - (time.perf_counter() - step_start)))


def main():
    parser = argparse.ArgumentParser(description="MuJoCo SO-101 测试")
    parser.add_argument("--viewer", action="store_true", help="打开交互式查看器")
    parser.add_argument("--animate", action="store_true", help="测试关节运动动画")
    parser.add_argument("--output", type=str, default="test_frame.png", help="离屏渲染输出文件")
    args = parser.parse_args()

    # 测试加载模型
    model, data = test_load_model()

    # 测试关节控制
    test_joint_control(model, data)

    # 测试离屏渲染
    test_offscreen_render(model, data, args.output)

    if args.animate:
        test_animate(model, data)

    if args.viewer:
        test_viewer(model, data)

    print("\n所有测试通过!")


if __name__ == "__main__":
    main()
