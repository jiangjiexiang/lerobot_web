#!/usr/bin/env python3
"""独立摄像头推流进程，不依赖机器人遥操作。"""
import argparse
import base64
import json
import time

import cv2


def emit(message: dict) -> None:
    print(json.dumps(message, ensure_ascii=False), flush=True)


def open_camera(args):
    cap = cv2.VideoCapture(args.camera_index, cv2.CAP_V4L2)
    if not cap.isOpened():
        cap.release()
        return None, None
    requested_formats = ("MJPG", "YUYV")
    selected = None
    for fourcc in requested_formats:
        if cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*fourcc)):
            selected = fourcc
            break
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    cap.set(cv2.CAP_PROP_FPS, args.fps)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    actual_code = int(cap.get(cv2.CAP_PROP_FOURCC))
    actual_fourcc = "".join(chr((actual_code >> (8 * index)) & 0xFF) for index in range(4))
    properties = {
        "fourcc": actual_fourcc.strip("\x00") or selected or "unknown",
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "fps": float(cap.get(cv2.CAP_PROP_FPS)),
    }
    return cap, properties


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--camera-index", type=int, default=0)
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--jpeg-quality", type=int, default=82)
    p.add_argument("--width", type=int, default=1280)
    p.add_argument("--height", type=int, default=720)
    p.add_argument("--max-read-failures", type=int, default=10)
    p.add_argument("--reconnect-delay", type=float, default=1.0)
    args = p.parse_args()

    cv2.setNumThreads(1)
    cap = None
    reconnects = 0
    failures = 0
    frames = 0
    total_frames = 0
    status_started = time.monotonic()
    interval = 1.0 / max(1, args.fps)
    try:
        while True:
            if cap is None:
                cap, properties = open_camera(args)
                if cap is None:
                    emit({
                        "type": "camera_error",
                        "error": f"无法打开摄像头 {args.camera_index}，将在 {args.reconnect_delay:.1f}s 后重试",
                        "recovering": True,
                    })
                    time.sleep(args.reconnect_delay)
                    reconnects += 1
                    continue
                failures = 0
                emit({
                    "type": "camera_ready",
                    "camera_index": args.camera_index,
                    "reconnects": reconnects,
                    **properties,
                })

            started = time.monotonic()
            ok, frame = cap.read()
            if ok and frame is not None and frame.shape[0] > 0 and frame.shape[1] > 0:
                failures = 0
                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])
                if ok:
                    frames += 1
                    total_frames += 1
                    emit({
                        "type": "camera_frame",
                        "data": base64.b64encode(jpeg).decode("ascii"),
                        "ts": time.time(),
                        "sequence": total_frames,
                    })
            else:
                failures += 1
                if failures >= args.max_read_failures:
                    emit({
                        "type": "camera_error",
                        "error": f"摄像头 {args.camera_index} 连续读取失败 {failures} 次，正在重连",
                        "recovering": True,
                    })
                    cap.release()
                    cap = None
                    reconnects += 1
                    time.sleep(args.reconnect_delay)
                    continue
            elapsed = time.monotonic() - status_started
            if elapsed >= 2.0:
                emit({
                    "type": "camera_status",
                    "camera_index": args.camera_index,
                    "measured_fps": frames / elapsed,
                    "read_failures": failures,
                    "reconnects": reconnects,
                })
                frames = 0
                status_started = time.monotonic()
            time.sleep(max(0, interval - (time.monotonic() - started)))
    finally:
        if cap is not None:
            cap.release()


if __name__ == "__main__":
    raise SystemExit(main())
