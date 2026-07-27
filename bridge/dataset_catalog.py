#!/usr/bin/env python3
"""Read LeRobot v3 dataset metadata for the web dataset workspace."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


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
    parser.add_argument("command", choices=("list", "detail"))
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
        result = dataset_detail(dataset_root)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
