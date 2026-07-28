from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    arguments = [
        DeclareLaunchArgument("driver", default_value="external"),
        DeclareLaunchArgument("command_source", default_value="ros"),
        DeclareLaunchArgument("leader_state_topic", default_value="/leader/joint_states"),
        DeclareLaunchArgument("follower_state_topic", default_value="/follower/joint_states"),
        DeclareLaunchArgument("camera1_topic", default_value="/camera1/image_raw/compressed"),
        DeclareLaunchArgument("camera2_topic", default_value="/camera2/image_raw/compressed"),
        DeclareLaunchArgument(
            "command_topic",
            default_value="/follower/joint_trajectory_controller/joint_trajectory",
        ),
    ]
    bridge = Node(
        package="lerobot_ros2_bridge",
        executable="web_bridge",
        name="lerobot_web_bridge",
        output="screen",
        arguments=[
            "--driver",
            LaunchConfiguration("driver"),
            "--command-source",
            LaunchConfiguration("command_source"),
            "--leader-state-topic",
            LaunchConfiguration("leader_state_topic"),
            "--follower-state-topic",
            LaunchConfiguration("follower_state_topic"),
            "--command-topic",
            LaunchConfiguration("command_topic"),
            "--camera1-topic",
            LaunchConfiguration("camera1_topic"),
            "--camera2-topic",
            LaunchConfiguration("camera2_topic"),
        ],
    )
    return LaunchDescription(arguments + [bridge])
