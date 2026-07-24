#!/usr/bin/env python3
"""独立摄像头推流进程，不依赖机器人遥操作。"""
import argparse
import base64
import json
import time

import cv2


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--camera-index", type=int, default=0)
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--jpeg-quality", type=int, default=82)
    p.add_argument("--width", type=int, default=960)
    p.add_argument("--height", type=int, default=540)
    args = p.parse_args()

    cap = cv2.VideoCapture(args.camera_index, cv2.CAP_V4L2)
    if not cap.isOpened():
        print(json.dumps({"type": "camera_error", "error": f"无法打开摄像头 {args.camera_index}"}), flush=True)
        return 1
    # 优先使用 MJPEG；不指定 FOURCC 时，V4L2 可能回落到 YUYV，
    # 经过 USB/IP 传输后容易出现画面下半部绿色。
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    cap.set(cv2.CAP_PROP_FPS, args.fps)
    # 只保留最新帧，避免 USB 或编码短暂停顿后继续播放缓存中的旧画面。
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    interval = 1.0 / max(1, args.fps)
    try:
        while True:
            started = time.monotonic()
            ok, frame = cap.read()
            if ok and frame is not None and frame.shape[0] > 0 and frame.shape[1] > 0:
                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])
                if ok:
                    print(json.dumps({"type": "camera_frame", "data": base64.b64encode(jpeg).decode("ascii"), "ts": time.time()}), flush=True)
            time.sleep(max(0, interval - (time.monotonic() - started)))
    finally:
        cap.release()


if __name__ == "__main__":
    raise SystemExit(main())
