#!/usr/bin/env python3
"""将 SO-101 URDF 转换为 MuJoCo MJCF 格式"""
import xml.etree.ElementTree as ET
import os
import math

URDF_PATH = os.path.join(os.path.dirname(__file__), "so101.urdf")
MJCF_PATH = os.path.join(os.path.dirname(__file__), "so101.xml")
ASSETS_DIR = os.path.join(os.path.dirname(__file__), "assets")

tree = ET.parse(URDF_PATH)
root = tree.getroot()

# 收集所有 link 和 joint
links = {}
joints = []

for link in root.findall("link"):
    name = link.get("name")
    visuals = []
    for vis in link.findall("visual"):
        origin = vis.find("origin")
        geom = vis.find("geometry")
        mesh = geom.find("mesh") if geom is not None else None
        mat_elem = vis.find("material")
        
        xyz = [0, 0, 0]
        rpy = [0, 0, 0]
        if origin is not None:
            xyz = list(map(float, origin.get("xyz", "0 0 0").split()))
            rpy = list(map(float, origin.get("rpy", "0 0 0").split()))
        
        color = [1, 1, 1, 1]
        if mat_elem is not None:
            c = mat_elem.find("color")
            if c is not None:
                color = list(map(float, c.get("rgba", "1 1 1 1").split()))
        
        mesh_file = None
        if mesh is not None:
            mesh_file = mesh.get("filename", "")
        
        visuals.append({
            "xyz": xyz, "rpy": rpy, "color": color, "mesh": mesh_file
        })
    
    links[name] = visuals

for joint in root.findall("joint"):
    name = joint.get("name")
    jtype = joint.get("type")
    origin = joint.find("origin")
    parent = joint.find("parent").get("link")
    child = joint.find("child").get("link")
    axis = joint.find("axis")
    limit = joint.find("limit")
    
    xyz = [0, 0, 0]
    rpy = [0, 0, 0]
    if origin is not None:
        xyz = list(map(float, origin.get("xyz", "0 0 0").split()))
        rpy = list(map(float, origin.get("rpy", "0 0 0").split()))
    
    axis_xyz = [0, 0, 1]
    if axis is not None:
        axis_xyz = list(map(float, axis.get("xyz", "0 0 1").split()))
    
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
        "lower": lower, "upper": upper
    })

# 构建 MJCF
mjcf_lines = []
mjcf_lines.append('<?xml version="1.0" encoding="utf-8"?>')
mjcf_lines.append('<mujoco model="so101">')
mjcf_lines.append('  <compiler angle="radian" meshdir="assets"/>')
mjcf_lines.append('')
mjcf_lines.append('  <asset>')

# 添加 mesh
mesh_names = set()
for link_name, visuals in links.items():
    for vis in visuals:
        if vis["mesh"]:
            fname = os.path.basename(vis["mesh"])
            if fname not in mesh_names:
                mesh_names.add(fname)
                mjcf_lines.append(f'    <mesh name="{fname.replace(".stl", "")}" file="{fname}"/>')

mjcf_lines.append('  </asset>')
mjcf_lines.append('')
mjcf_lines.append('  <worldbody>')
mjcf_lines.append('    <light diffuse=".5 .5 .5" pos="0 0 3" dir="0 0 -1"/>')
mjcf_lines.append('    <geom type="plane" size="1 1 0.1" rgba=".9 .9 .9 1"/>')

# 构建 body 树
# 找到根 link (base_link)
# 建立 parent->children 映射
children_map = {}
for j in joints:
    if j["type"] != "fixed":
        children_map.setdefault(j["parent"], []).append(j)

# 递归生成 body
def gen_body(link_name, indent):
    prefix = "  " * indent
    visuals = links.get(link_name, [])
    
    # 添加该 link 的 visual geoms
    for vis in visuals:
        color_str = f"{vis['color'][0]} {vis['color'][1]} {vis['color'][2]} {vis['color'][3]}"
        xyz_str = f"{vis['xyz'][0]} {vis['xyz'][1]} {vis['xyz'][2]}"
        rpy_str = f"{vis['rpy'][0]} {vis['rpy'][1]} {vis['rpy'][2]}"
        if vis["mesh"]:
            mesh_name = os.path.basename(vis["mesh"]).replace(".stl", "")
            mjcf_lines.append(f'{prefix}  <geom type="mesh" mesh="{mesh_name}" pos="{xyz_str}" euler="{rpy_str}" rgba="{color_str}"/>')
    
    # 添加子 joint + body
    for j in children_map.get(link_name, []):
        xyz_str = f"{j['xyz'][0]} {j['xyz'][1]} {j['xyz'][2]}"
        rpy_str = f"{j['rpy'][0]} {j['rpy'][1]} {j['rpy'][2]}"
        axis_str = f"{j['axis'][0]} {j['axis'][1]} {j['axis'][2]}"
        
        if j["type"] == "fixed":
            # 固定关节：只添加子 body 的 geoms，不创建新 body
            gen_body(j["child"], indent)
        else:
            mjcf_lines.append(f'{prefix}  <body name="{j["child"]}" pos="{xyz_str}" euler="{rpy_str}">')
            mjcf_lines.append(f'{prefix}    <joint name="{j["name"]}" type="hinge" axis="{axis_str}" range="{j["lower"]} {j["upper"]}" damping="0.1"/>')
            gen_body(j["child"], indent + 2)
            mjcf_lines.append(f'{prefix}  </body>')

# 从 base_link 开始
gen_body("base_link", 2)

mjcf_lines.append('  </worldbody>')
mjcf_lines.append('')
mjcf_lines.append('  <actuator>')
for j in joints:
    if j["type"] == "revolute":
        mjcf_lines.append(f'    <position name="{j["name"]}_pos" joint="{j["name"]}" kp="30"/>')
mjcf_lines.append('  </actuator>')
mjcf_lines.append('')
mjcf_lines.append('</mujoco>')

with open(MJCF_PATH, "w") as f:
    f.write("\n".join(mjcf_lines) + "\n")

print(f"MJCF 已生成: {MJCF_PATH}")
print(f"  Mesh 数量: {len(mesh_names)}")
print(f"  关节数量: {sum(1 for j in joints if j['type'] == 'revolute')}")
