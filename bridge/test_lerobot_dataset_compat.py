#!/usr/bin/env python3

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge import lerobot_dataset_compat as compat


class OldDataset:
    def __init__(self, repo_id, root):
        self.repo_id = repo_id
        self.root = root
        self.started = False
        self.stopped = False

    @classmethod
    def create(cls, repo_id, fps, features, root, robot_type, use_videos, image_writer_threads):
        return cls(repo_id, root)

    def start_image_writer(self, num_processes=0, num_threads=4):
        self.started = True

    def stop_image_writer(self):
        self.stopped = True

    def clear_episode_buffer(self, delete_images=True):
        self.cleared = delete_images


class NewDataset:
    create_options = None
    resume_options = None

    @classmethod
    def create(
        cls, repo_id, fps, features, root, robot_type, use_videos,
        image_writer_threads, streaming_encoding, vcodec,
    ):
        cls.create_options = (streaming_encoding, vcodec)
        return cls()

    @classmethod
    def resume(
        cls, repo_id, root, image_writer_threads, streaming_encoding, vcodec,
    ):
        cls.resume_options = (streaming_encoding, vcodec)
        return cls()

    def finalize(self):
        self.finalized = True

    def clear_episode_buffer(self, delete_images=True):
        self.cleared = delete_images


class DatasetCompatibilityTests(unittest.TestCase):
    def test_old_dataset_resume_and_stop_writer(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            compat, "LeRobotDataset", OldDataset
        ):
            dataset = compat.resume_dataset(repo_id="local/demo", root=Path(directory))
            self.assertTrue(dataset.started)
            compat.finalize_dataset(dataset)
            self.assertTrue(dataset.stopped)

    def test_new_dataset_streaming_create_resume_and_finalize(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(
            compat, "LeRobotDataset", NewDataset
        ):
            created = compat.create_dataset(
                repo_id="local/demo",
                fps=30,
                root=Path(directory),
                robot_type="so101_follower",
                features={},
                streaming_encoding=True,
                vcodec="h264",
            )
            self.assertEqual(NewDataset.create_options, (True, "h264"))
            compat.finalize_dataset(created)
            self.assertTrue(created.finalized)

            resumed = compat.resume_dataset(
                repo_id="local/demo",
                root=Path(directory),
                streaming_encoding=True,
                vcodec="h264",
            )
            self.assertEqual(NewDataset.resume_options, (True, "h264"))
            compat.cancel_dataset(resumed)
            self.assertTrue(resumed.cleared)
            self.assertTrue(resumed.finalized)


if __name__ == "__main__":
    unittest.main()
