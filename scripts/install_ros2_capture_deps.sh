#!/bin/bash
set -e

ROS_DISTRO="${ROS_DISTRO:-humble}"
sudo apt-get update
sudo apt-get install -y \
  "ros-$ROS_DISTRO-message-filters" \
  "ros-$ROS_DISTRO-image-transport" \
  "ros-$ROS_DISTRO-compressed-image-transport" \
  "ros-$ROS_DISTRO-rosbag2-storage-mcap"

echo "ROS 2 capture dependencies installed for $ROS_DISTRO"
