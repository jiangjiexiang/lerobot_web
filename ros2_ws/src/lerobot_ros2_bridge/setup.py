from glob import glob
from setuptools import find_packages, setup

package_name = "lerobot_ros2_bridge"
driver_script = "../../../bridge/teleop_mujoco.py"

setup(
    name=package_name,
    version="0.2.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", glob("launch/*.launch.py")),
        ("share/" + package_name + "/config", glob("config/*.yaml")),
        ("share/" + package_name + "/driver", [driver_script]),
    ],
    install_requires=["setuptools"],
    tests_require=["pytest"],
    zip_safe=True,
    maintainer="LeRobot Web Maintainer",
    maintainer_email="maintainer@example.com",
    description="ROS 2 topic adapter for LeRobot Web.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "web_bridge = lerobot_ros2_bridge.web_bridge:main",
        ],
    },
)
