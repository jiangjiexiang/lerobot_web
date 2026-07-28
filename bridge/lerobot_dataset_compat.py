#!/usr/bin/env python3
"""Compatibility boundary for LeRobotDataset 0.4 and 0.5+ writer APIs."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from lerobot.datasets.lerobot_dataset import LeRobotDataset


@dataclass(frozen=True)
class DatasetCapabilities:
    version: str
    resume_api: bool
    streaming_encoding: bool


def capabilities() -> DatasetCapabilities:
    try:
        package_version = version("lerobot")
    except PackageNotFoundError:
        package_version = "unknown"
    create_parameters = inspect.signature(LeRobotDataset.create).parameters
    return DatasetCapabilities(
        version=package_version,
        resume_api=callable(getattr(LeRobotDataset, "resume", None)),
        streaming_encoding="streaming_encoding" in create_parameters,
    )


def _writer_options(
    *,
    image_writer_threads: int,
    streaming_encoding: bool,
    vcodec: str | None,
    target: Any,
) -> dict[str, Any]:
    parameters = inspect.signature(target).parameters
    options: dict[str, Any] = {}
    if "image_writer_threads" in parameters:
        options["image_writer_threads"] = image_writer_threads
    if "streaming_encoding" in parameters:
        options["streaming_encoding"] = streaming_encoding
    if vcodec and "vcodec" in parameters:
        options["vcodec"] = vcodec
    return options


def create_dataset(
    *,
    repo_id: str,
    fps: int,
    root: Path,
    robot_type: str,
    features: dict,
    image_writer_threads: int = 4,
    streaming_encoding: bool = True,
    vcodec: str | None = None,
) -> LeRobotDataset:
    options = _writer_options(
        image_writer_threads=image_writer_threads,
        streaming_encoding=streaming_encoding,
        vcodec=vcodec,
        target=LeRobotDataset.create,
    )
    return LeRobotDataset.create(
        repo_id=repo_id,
        fps=fps,
        root=root,
        robot_type=robot_type,
        features=features,
        use_videos=True,
        **options,
    )


def resume_dataset(
    *,
    repo_id: str,
    root: Path,
    image_writer_threads: int = 4,
    streaming_encoding: bool = True,
    vcodec: str | None = None,
) -> LeRobotDataset:
    resume = getattr(LeRobotDataset, "resume", None)
    if callable(resume):
        options = _writer_options(
            image_writer_threads=image_writer_threads,
            streaming_encoding=streaming_encoding,
            vcodec=vcodec,
            target=resume,
        )
        return resume(repo_id=repo_id, root=root, **options)

    dataset = LeRobotDataset(repo_id, root=root)
    dataset.start_image_writer(num_processes=0, num_threads=image_writer_threads)
    return dataset


def finalize_dataset(dataset: LeRobotDataset) -> None:
    finalize = getattr(dataset, "finalize", None)
    if callable(finalize):
        finalize()
        return
    dataset.stop_image_writer()


def cancel_dataset(dataset: LeRobotDataset) -> None:
    dataset.clear_episode_buffer(delete_images=True)
    finalize_dataset(dataset)
