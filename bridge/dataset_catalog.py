#!/usr/bin/env python3
"""Read LeRobot v3 dataset metadata for the web dataset workspace."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

try:
    import cv2
except ImportError:  # Quality scanning remains available without video decoding.
    cv2 = None


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def dataset_dirs(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(
        (item for item in root.iterdir() if item.is_dir() and (item / "meta" / "info.json").is_file()),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )


def camera_keys(info: dict) -> list[str]:
    return [key for key, feature in info.get("features", {}).items() if feature.get("dtype") in ("video", "image")]


def review_summary(dataset_root: Path) -> dict:
    reviews = read_json(dataset_root / ".lerobot-web" / "reviews.json", {}).get("episodes", {})
    summary = {"unreviewed": 0, "approved": 0, "rejected": 0}
    for review in reviews.values():
        status = review.get("status", "unreviewed")
        if status in summary:
            summary[status] += 1
    return summary


def dataset_summary(dataset_root: Path) -> dict:
    info = read_json(dataset_root / "meta" / "info.json", {})
    modified = datetime.fromtimestamp(dataset_root.stat().st_mtime, tz=timezone.utc).isoformat()
    total_episodes = int(info.get("total_episodes", 0))
    reviews = review_summary(dataset_root)
    reviews["unreviewed"] = max(reviews["unreviewed"], total_episodes - reviews["approved"] - reviews["rejected"])
    return {
        "name": dataset_root.name,
        "robotType": info.get("robot_type"),
        "fps": info.get("fps", 0),
        "totalEpisodes": total_episodes,
        "totalFrames": int(info.get("total_frames", 0)),
        "cameras": camera_keys(info),
        "modifiedAt": modified,
        "reviews": reviews,
    }


def format_video_path(template: str, video_key: str, row: dict) -> str | None:
    chunk = row.get(f"videos/{video_key}/chunk_index")
    file_index = row.get(f"videos/{video_key}/file_index")
    if chunk is None or file_index is None:
        return None
    return template.format(video_key=video_key, chunk_index=int(chunk), file_index=int(file_index))


def normalize_tasks(value) -> list[str]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value]


def episode_quality(row: dict, cameras: list[str], videos: dict, fps: float) -> dict:
    frames = int(row.get("length", 0))
    flags = []
    missing = [camera for camera in cameras if camera not in videos]
    if frames <= 0:
        flags.append({"code": "empty_episode", "level": "error", "label": "没有有效帧"})
    elif frames < max(5, round(fps)):
        flags.append({"code": "short_episode", "level": "warning", "label": "片段短于 1 秒"})
    if missing:
        flags.append({
            "code": "missing_video",
            "level": "error",
            "label": f"缺少 {len(missing)} 路视频",
            "channels": missing,
        })
    score = max(0, 100 - sum(35 if flag["level"] == "error" else 15 for flag in flags))
    return {"score": score, "flags": flags, "cameraCoverage": len(videos), "expectedCameras": len(cameras)}


def video_quality(path: Path) -> dict:
    if cv2 is None:
        return {"readable": None, "meanBrightness": None, "frameDiff": None, "flags": [{"code": "decoder_unavailable", "level": "warning", "label": "未安装 OpenCV，无法抽样视频"}]}
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        return {"readable": False, "meanBrightness": None, "frameDiff": None, "flags": [{"code": "video_unreadable", "level": "error", "label": "视频无法打开"}]}
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    positions = sorted(set([0, max(0, frame_count // 2), max(0, frame_count - 1)]))
    brightness = []
    differences = []
    previous = None
    for position in positions:
        capture.set(cv2.CAP_PROP_POS_FRAMES, position)
        ok, frame = capture.read()
        if not ok or frame is None:
            continue
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        brightness.append(float(gray.mean()))
        if previous is not None:
            differences.append(float(cv2.absdiff(gray, previous).mean()))
        previous = gray
    capture.release()
    flags = []
    mean_brightness = sum(brightness) / len(brightness) if brightness else None
    mean_diff = sum(differences) / len(differences) if differences else None
    if not brightness:
        flags.append({"code": "video_unreadable", "level": "error", "label": "视频没有可读取帧"})
    elif mean_brightness < 2:
        flags.append({"code": "black_screen", "level": "error", "label": "抽样帧接近全黑"})
    elif mean_brightness < 8:
        flags.append({"code": "low_brightness", "level": "warning", "label": "抽样帧亮度偏低"})
    if len(differences) >= 2 and mean_diff < 0.5:
        flags.append({"code": "frozen_video", "level": "warning", "label": "抽样帧几乎没有变化"})
    return {"readable": bool(brightness), "meanBrightness": round(mean_brightness, 2) if mean_brightness is not None else None, "frameDiff": round(mean_diff, 3) if mean_diff is not None else None, "flags": flags}


def trajectory_quality(frame: pd.DataFrame) -> dict:
    flags = []
    values = []
    for column in ("observation.state", "action"):
        if column not in frame:
            continue
        for value in frame[column].tolist():
            if hasattr(value, "tolist"):
                value = value.tolist()
            if isinstance(value, (list, tuple)):
                values.append([float(item) for item in value])
    if len(values) >= 2:
        import numpy as np
        matrix = np.asarray(values, dtype=float)
        jumps = np.max(np.abs(np.diff(matrix, axis=0)), axis=1)
        median_jump = float(np.median(jumps))
        largest_jump = float(np.max(jumps))
        if largest_jump > 1.0 and largest_jump > max(0.2, median_jump * 8):
            flags.append({"code": "trajectory_jump", "level": "warning", "label": "状态/动作存在突变", "maxJump": round(largest_jump, 4)})
        if not np.isfinite(matrix).all():
            flags.append({"code": "trajectory_non_finite", "level": "error", "label": "状态/动作包含非有限数值"})
        return {"samples": len(values), "maxJump": round(largest_jump, 4), "medianJump": round(median_jump, 4), "flags": flags}
    return {"samples": len(values), "maxJump": None, "medianJump": None, "flags": [{"code": "trajectory_missing", "level": "warning", "label": "缺少状态/动作序列"}]}


def dataset_quality(dataset_root: Path) -> dict:
    info = read_json(dataset_root / "meta" / "info.json", {})
    detail = dataset_detail(dataset_root)
    episode_meta = {item["episode"]: item for item in detail["episodes"]}
    data_files = sorted((dataset_root / "data").glob("**/*.parquet"))
    frame = pd.concat((pd.read_parquet(file) for file in data_files), ignore_index=True) if data_files else pd.DataFrame()
    episodes = []
    signatures = {}
    for episode in range(int(info.get("total_episodes", 0))):
        metadata = episode_meta.get(episode, {"episode": episode, "frames": 0, "videos": {}, "quality": {"flags": []}})
        flags = list(metadata.get("quality", {}).get("flags", []))
        video_checks = {}
        for camera, relative in metadata.get("videos", {}).items():
            check = video_quality(dataset_root / relative); video_checks[camera] = check; flags.extend(check["flags"])
        episode_frame = frame[frame.get("episode_index", pd.Series(dtype=int)) == episode] if not frame.empty and "episode_index" in frame else pd.DataFrame()
        trajectory = trajectory_quality(episode_frame)
        flags.extend(trajectory["flags"])
        if not episode_frame.empty:
            signature_columns = [column for column in ("observation.state", "action") if column in episode_frame]
            signature_values = []
            for index in [0, len(episode_frame) // 2, len(episode_frame) - 1]:
                for column in signature_columns:
                    value = episode_frame.iloc[index][column]
                    if hasattr(value, "tolist"):
                        value = value.tolist()
                    signature_values.append(tuple(round(float(item), 4) for item in value) if isinstance(value, (list, tuple)) else str(value))
            signature = repr(signature_values)
            signatures.setdefault(signature, []).append(episode)
        episodes.append({"episode": episode, "frames": metadata.get("frames", 0), "flags": flags, "videoChecks": video_checks, "trajectory": trajectory, "score": max(0, 100 - sum(35 if flag.get("level") == "error" else 15 for flag in flags))})
    duplicate_episodes = []
    for values in signatures.values():
        if len(values) > 1:
            duplicate_episodes.append(values)
            for episode in values:
                episodes[episode]["flags"].append({"code": "duplicate_risk", "level": "warning", "label": "轨迹首中尾签名重复", "episodes": values})
                episodes[episode]["score"] = max(0, episodes[episode]["score"] - 15)
    all_flags = [flag for episode in episodes for flag in episode["flags"]]
    return {"dataset": dataset_summary(dataset_root), "episodes": episodes, "summary": {"episodes": len(episodes), "errors": sum(flag.get("level") == "error" for flag in all_flags), "warnings": sum(flag.get("level") == "warning" for flag in all_flags), "duplicateGroups": len(duplicate_episodes), "passed": not any(flag.get("level") == "error" for flag in all_flags)}}


def dataset_detail(dataset_root: Path) -> dict:
    info = read_json(dataset_root / "meta" / "info.json", {})
    reviews = read_json(dataset_root / ".lerobot-web" / "reviews.json", {}).get("episodes", {})
    parquet_files = sorted((dataset_root / "meta" / "episodes").glob("**/*.parquet"))
    rows = []
    if parquet_files:
        frame = pd.concat((pd.read_parquet(file) for file in parquet_files), ignore_index=True)
        frame = frame.sort_values("episode_index")
        video_template = info.get("video_path")
        cameras = camera_keys(info)
        fps = float(info.get("fps", 1) or 1)
        for raw in frame.to_dict(orient="records"):
            episode = int(raw["episode_index"])
            videos = {}
            if video_template:
                for camera in cameras:
                    relative = format_video_path(video_template, camera, raw)
                    if relative and (dataset_root / relative).is_file():
                        videos[camera] = relative
            review = reviews.get(str(episode), {"status": "unreviewed", "tags": [], "notes": ""})
            review.setdefault("status", "unreviewed")
            review.setdefault("tags", [])
            review.setdefault("notes", "")
            review.setdefault("assignee", "")
            review.setdefault("reviewer", "")
            review.setdefault("qualityFlags", [])
            rows.append({
                "episode": episode,
                "frames": int(raw.get("length", 0)),
                "duration": round(int(raw.get("length", 0)) / fps, 3),
                "tasks": normalize_tasks(raw.get("tasks")),
                "videos": videos,
                "quality": episode_quality(raw, cameras, videos, fps),
                "review": review,
            })
    return {"dataset": dataset_summary(dataset_root), "episodes": rows}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("list", "detail", "quality"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--dataset")
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()

    if args.command == "list":
        result = {"root": str(root), "datasets": [dataset_summary(item) for item in dataset_dirs(root)]}
    else:
        if not args.dataset or not args.dataset.replace("-", "").replace("_", "").replace(".", "").isalnum():
            raise ValueError("无效的数据集名称")
        dataset_root = (root / args.dataset).resolve()
        if dataset_root.parent != root or not (dataset_root / "meta" / "info.json").is_file():
            raise FileNotFoundError(f"找不到数据集: {args.dataset}")
        result = dataset_quality(dataset_root) if args.command == "quality" else dataset_detail(dataset_root)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
