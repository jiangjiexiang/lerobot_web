#!/usr/bin/env python3
"""
使用 mujoco 的 mjcf 库从 URDF 生成正确的 MJCF。
通过解析 URDF 的变换链，正确计算每个 geom 在 body 局部坐标系中的位置。
"""
import xml.etree.ElementTree as ET
import os
import math
import numpy as np

URDF_PATH = os.path.join(os.path.dirname(__file__), "so101.urdf")
MJCF_PATH = os.path.join(os.path.dirname(__file__), "so101.xml")

def rpy_to_rot(rpy):
    """RPY (xyz) to rotation matrix"""
    r, p, y = rpy
    cr, sr = math.cos(r), math.sin(r)
    cp, sp = math.cos(p), math.sin(p)
    cy, sy = math.cos(y), math.sin(y)
    return np.array([
        [cy*cp, cy*sp*sr - sy*cr, cy*sp*cr + sy*sr],
        [sy*cp, sy*sp*sr + cy*cr, sy*sp*cr - cy*sr],
        [-sp,   cp*sr,            cp*cr]
    ])

def rot_to_rpy(R):
    """Rotation matrix to RPY (xyz)"""
    sy = math.sqrt(R[0,0]**2 + R[1,0]**2)
    if sy > 1e-6:
        rpy = np.array([
            math.atan2(R[2,1], R[2,2]),
            math.atan2(-R[2,0], sy),
            math.atan2(R[1,0], R[0,0])
        ])
    else:
        rpy = np.array([
            math.atan2(-R[1,2], R[1,1]),
            math.atan2(-R[2,0], sy),
            0
        ])
    return rpy

def transform_mul(T1, T2):
    """Multiply two 4x4 transforms"""
    return T1 @ T2

def make_transform(xyz, rpy):
    """Create 4x4 transform from xyz + rpy"""
    R = rpy_to_rot(rpy)
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = xyz
    return T

def decompose_transform(T):
    """Decompose 4x4 transform to xyz + rpy"""
    xyz = T[:3, 3]
    rpy = rot_to_rpy(T[:3, :3])
    return xyz, rpy

# 解析 URDF
tree = ET.parse(URDF_PATH)
root = tree.getroot()

# 收集 links
links = {}
for link in root.findall("link"):
    name = link.get("name")
    visuals = []
    for vis in link.findall("visual"):
        origin = vis.find("origin")
        geom = vis.find("geometry")
        mesh = geom.find("mesh") if geom is not None else None
        mat_elem = vis.find("material")
        
        xyz = np.zeros(3)
        rpy = np.zeros(3)
        if origin is not None:
            xyz = np.array(list(map(float, origin.get("xyz", "0 0 0").split())))
            rpy = np.array(list(map(float, origin.get("rpy", "0 0 0").split())))
        
        color = np.array([1, 1, 1, 1])
        if mat_elem is not None:
            c = mat_elem.find("color")
            if c is not None:
                color = np.array(list(map(float, c.get("rgba", "1 1 1 1").split())))
        
        mesh_file = None
        if mesh is not None:
            mesh_file = mesh.get("filename", "")
        
        visuals.append({
            "xyz": xyz, "rpy": rpy, "color": color, "mesh": mesh_file,
            "T_local": make_transform(xyz, rpy)
        })
    
    links[name] = visuals

# 收集 joints
joints = []
for joint in root.findall("joint"):
    name = joint.get("name")
    jtype = joint.get("type")
    origin = joint.find("origin")
    parent = joint.find("parent").get("link")
    child = joint.find("child").get("link")
    axis = joint.find("axis")
    limit = joint.find("limit")
    
    xyz = np.zeros(3)
    rpy = np.zeros(3)
    if origin is not None:
        xyz = np.array(list(map(float, origin.get("xyz", "0 0 0").split())))
        rpy = np.array(list(map(float, origin.get("rpy", "0 0 0").split())))
    
    axis_xyz = np.array([0, 0, 1])
    if axis is not None:
        axis_xyz = np.array(list(map(float, axis.get("xyz", "0 0 1").split())))
    
    lower = -3.14
    upper = 3.14
    if limit is not None:
        lower = float(limit.get("lower", "-3.14"))
        upper = float(limit.get("upper", "3.14"))
    
    joints.append({
        "name": name, "type": jtype,
        "xyz": xyz, "rpy": rpy,
        "parent": parent, "child": child,
        "axis": axis_xyz,
        "lower": lower, "upper": upper,
        "T_joint": make_transform(xyz, rpy)
    })

# 构建 link 到 joint 的映射 (parent_link -> joint -> child_link)
# 计算每个 link 相对于 base_link 的世界变换
# 然后计算每个 visual geom 相对于其 link 的 body frame 的变换

# 建立 joint 查找: child_link -> joint
child_to_joint = {}
for j in joints:
    child_to_joint[j["child"]] = j

# 计算每个 link 相对于 base 的变换
link_T_world = {"base_link": np.eye(4)}

def get_link_T_world(link_name):
    if link_name in link_T_world:
        return link_T_world[link_name]
    j = child_to_joint.get(link_name)
    if j is None:
        return np.eye(4)
    parent_T = get_link_T_world(j["parent"])
    T = transform_mul(parent_T, j["T_joint"])
    link_T_world[link_name] = T
    return T

# 计算每个 link 的 body frame (在 MuJoCo 中，body frame = joint 变换后的 frame)
# 对于 base_link，body frame = world frame
# 对于其他 link，body frame = parent_body_frame * joint_transform

# 在 MuJoCo 中:
# - worldbody 下的第一个 body (base_link) 没有 pos/euler (或在原点)
# - 子 body 的 pos/euler = joint 的 xyz/rpy
# - body 内的 geom pos/euler = visual 在 link frame 中的位置

# 关键: URDF 中 visual 的 xyz/rpy 是相对于 link frame 的
# MuJoCo 中 geom 的 pos/euler 是相对于 body frame 的
# 如果 body frame = link frame，则直接使用

# 在 URDF 中，link frame 由 joint 定义:
# link_frame = parent_link_frame * joint_transform
# 在 MuJoCo 中，body frame 也是:
# body_frame = parent_body_frame * body_pos/euler

# 所以如果 body_pos/euler = joint xyz/rpy，则 body frame = link frame
# 那么 geom pos/euler = visual xyz/rpy (直接使用)

# 但是！URDF 中 base_link 的 visual 位置是相对于 base_link frame 的
# 在 MuJoCo 中，如果 base_link body 在原点，则 geom 位置直接使用

# 问题可能出在: URDF 的 base_link 有 visual 偏移，但 MuJoCo 的 base body 在原点
# 这些 visual 偏移应该保留

# 让我直接生成 MJCF，使用 URDF 的 joint 变换作为 body pos/euler
# visual 偏移直接作为 geom pos/euler

# 收集所有 mesh
mesh_names = set()
for link_name, visuals in links.items():
    for vis in visuals:
        if vis["mesh"]:
            fname = os.path.basename(vis["mesh"])
            mesh_names.add(fname)

# 建立 parent -> children joints 映射
children_map = {}
for j in joints:
    children_map.setdefault(j["parent"], []).append(j)

# 生成 MJCF
lines = []
lines.append('<?xml version="1.0" encoding="utf-8"?>')
lines.append('<mujoco model="so101">')
lines.append('  <compiler angle="radian" meshdir="assets"/>')
lines.append('')
lines.append('  <asset>')
for fname in sorted(mesh_names):
    name = fname.replace(".stl", "")
    lines.append(f'    <mesh name="{name}" file="{fname}"/>')
lines.append('  </asset>')
lines.append('')
lines.append('  <worldbody>')
lines.append('    <light diffuse=".5 .5 .5" pos="0 0 3" dir="0 0 -1"/>')
lines.append('    <geom type="plane" size="1 1 0.1" rgba=".9 .9 .9 1"/>')

def gen_body(link_name, indent):
    prefix = "  " * indent
    visuals = links.get(link_name, [])
    
    # 添加该 link 的 visual geoms
    for vis in visuals:
        color = vis["color"]
        color_str = f"{color[0]} {color[1]} {color[2]} {color[3]}"
        xyz = vis["xyz"]
        rpy = vis["rpy"]
        xyz_str = f"{xyz[0]:.6f} {xyz[1]:.6f} {xyz[2]:.6f}"
        rpy_str = f"{rpy[0]:.6f} {rpy[1]:.6f} {rpy[2]:.6f}"
        if vis["mesh"]:
            mesh_name = os.path.basename(vis["mesh"]).replace(".stl", "")
            lines.append(f'{prefix}  <geom type="mesh" mesh="{mesh_name}" pos="{xyz_str}" euler="{rpy_str}" rgba="{color_str}"/>')
    
    # 子 joints
    for j in children_map.get(link_name, []):
        if j["type"] == "fixed":
            # 固定关节: 将子 link 的 geoms 合并到当前 body
            # 需要变换子 link 的 visual 到当前 body 的坐标系
            T_joint = j["T_joint"]
            child_visuals = links.get(j["child"], [])
            for vis in child_visuals:
                # 变换: T_body * T_joint * T_visual_local
                T_vis_local = vis["T_local"]
                T_world_vis = T_joint @ T_vis_local
                xyz, rpy = decompose_transform(T_world_vis)
                color = vis["color"]
                color_str = f"{color[0]} {color[1]} {color[2]} {color[3]}"
                xyz_str = f"{xyz[0]:.6f} {xyz[1]:.6f} {xyz[2]:.6f}"
                rpy_str = f"{rpy[0]:.6f} {rpy[1]:.6f} {rpy[2]:.6f}"
                if vis["mesh"]:
                    mesh_name = os.path.basename(vis["mesh"]).replace(".stl", "")
                    lines.append(f'{prefix}  <geom type="mesh" mesh="{mesh_name}" pos="{xyz_str}" euler="{rpy_str}" rgba="{color_str}"/>')
            # 递归处理 fixed joint 的子 link 的子 joints
            gen_body(j["child"], indent)
        else:
            xyz = j["xyz"]
            rpy = j["rpy"]
            xyz_str = f"{xyz[0]:.6f} {xyz[1]:.6f} {xyz[2]:.6f}"
            rpy_str = f"{rpy[0]:.6f} {rpy[1]:.6f} {rpy[2]:.6f}"
            axis = j["axis"]
            axis_str = f"{axis[0]} {axis[1]} {axis[2]}"
            
            lines.append(f'{prefix}  <body name="{j["child"]}" pos="{xyz_str}" euler="{rpy_str}">')
            lines.append(f'{prefix}    <joint name="{j["name"]}" type="hinge" axis="{axis_str}" range="{j["lower"]} {j["upper"]}" damping="0.1"/>')
            gen_body(j["child"], indent + 2)
            lines.append(f'{prefix}  </body>')

gen_body("base_link", 2)

lines.append('  </worldbody>')
lines.append('')
lines.append('  <actuator>')
for j in joints:
    if j["type"] == "revolute":
        lines.append(f'    <position name="{j["name"]}_pos" joint="{j["name"]}" kp="30"/>')
lines.append('  </actuator>')
lines.append('')
lines.append('</mujoco>')

with open(MJCF_PATH, "w") as f:
    f.write("\n".join(lines) + "\n")

print(f"MJCF 已生成: {MJCF_PATH}")
print(f"  Mesh 数量: {len(mesh_names)}")
print(f"  关节数量: {sum(1 for j in joints if j['type'] == 'revolute')}")
