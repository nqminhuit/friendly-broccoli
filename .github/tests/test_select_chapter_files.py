"""Check .github/scripts/select_chapter_files.py selects and validates chapter files."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "select_chapter_files.py"
ZERO = "0" * 40


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if result.returncode != 0 and args[:2] != ("cat-file", "-e"):
        raise AssertionError(f"git {' '.join(args)}: {result.stderr}")
    return result.stdout.strip()


class Repo:
    """A throwaway git repo that chapter files can be added to between commits."""

    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "t@example.com")
        git(self.root, "config", "user.name", "t")
        git(self.root, "checkout", "-q", "-b", "master")
        self.write(".keep", "x")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", "base")
        self.base = git(self.root, "rev-parse", "HEAD")

    def write(self, path, text="body\n"):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def symlink(self, path, target):
        link = self.root / path
        link.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, link)

    def commit(self, message="c"):
        git(self.root, "add", "-A")
        git(self.root, "commit", "-q", "-m", message)
        return git(self.root, "rev-parse", "HEAD")

    def run(self, **kwargs):
        out = self.root / "github_output.txt"
        out.write_text("")
        args = [sys.executable, str(SCRIPT), "--repo", str(self.root), "--output", str(out)]
        for key, value in kwargs.items():
            args += [f"--{key.replace('_', '-')}", value]
        proc = subprocess.run(args, capture_output=True, text=True)
        files = None
        for line in out.read_text().splitlines():
            if line.startswith("files="):
                files = json.loads(line[len("files="):])
        return proc, files

    def close(self):
        self._tmp.cleanup()


class SelectChapterFilesTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.addCleanup(self.repo.close)

    def push(self, before, sha):
        return self.repo.run(event="push", before=before, sha=sha)

    def test_added_modified_and_same_commit(self):
        self.repo.write("chapters/a.md")
        self.repo.write("chapters/b.md")
        head = self.repo.commit()
        proc, files = self.push(self.repo.base, head)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual({"chapters/a.md", "chapters/b.md"}, set(files))

    def test_root_and_missing_before_fall_back(self):
        self.repo.write("chapters/a.md")
        head = self.repo.commit()
        for before in (ZERO, "deadbeef" * 5):
            with self.subTest(before=before[:8]):
                proc, files = self.push(before, head)
                self.assertEqual(0, proc.returncode, proc.stderr)
                self.assertEqual(["chapters/a.md"], files)

    def test_modified_only(self):
        self.repo.write("chapters/a.md", "one\n")
        first = self.repo.commit()
        self.repo.write("chapters/a.md", "two\n")
        second = self.repo.commit()
        proc, files = self.push(first, second)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual(["chapters/a.md"], files)

    def test_deleted_ignored_and_rename_becomes_add(self):
        self.repo.write("chapters/a.md")
        first = self.repo.commit()
        git(self.repo.root, "rm", "-q", "chapters/a.md")
        second = self.repo.commit()
        _, files = self.push(first, second)
        self.assertEqual([], files)
        self.repo.write("chapters/a.md")
        third = self.repo.commit()
        git(self.repo.root, "mv", "chapters/a.md", "chapters/b.md")
        fourth = self.repo.commit()
        _, files = self.push(third, fourth)
        self.assertEqual(["chapters/b.md"], files)

    def test_nested_and_multi(self):
        self.repo.write("chapters/one/a.md")
        self.repo.write("chapters/two/deep/b.md")
        head = self.repo.commit()
        _, files = self.push(ZERO, head)
        self.assertEqual({"chapters/one/a.md", "chapters/two/deep/b.md"}, set(files))

    def test_excluded_and_prompt_files(self):
        self.repo.write("chapters/README.md")
        self.repo.write("chapters/AGENTS.md")
        self.repo.write("chapters/sub/README.md")
        self.repo.write("chapters/sub/AGENTS.md")
        self.repo.write("chapters/a-prompts.txt")
        self.repo.write("chapters/a.txt")
        head = self.repo.commit()
        proc, files = self.push(ZERO, head)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual([], files)

    def test_hostile_and_symlink_paths_skipped(self):
        self.repo.write("chapters/evil; touch pwned.md")
        self.repo.write("chapters/a b.md")
        self.repo.write("chapters/real.md")
        self.repo.write(".hidden")
        self.repo.symlink("chapters/link.md", "chapters/real.md")
        head = self.repo.commit()
        proc, files = self.push(ZERO, head)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual(["chapters/real.md"], files)
        self.assertFalse((self.repo.root / "pwned").exists())

    def test_manual_valid_file(self):
        self.repo.write("chapters/a.md")
        self.repo.commit()
        proc, files = self.repo.run(event="workflow_dispatch", file="chapters/a.md")
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual(["chapters/a.md"], files)

    def test_manual_rejects_bad_paths(self):
        self.repo.write("chapters/a.md")
        self.repo.write("chapters/README.md")
        self.repo.commit()
        for bad in ("chapters/missing.md", "../../evil.md", "chapters/../../evil.md",
                    "chapters/README.md", "chapters/AGENTS.md", "chapters/a.txt",
                    "chapters/bad name.md"):
            with self.subTest(file=bad):
                proc, _ = self.repo.run(event="workflow_dispatch", file=bad)
                self.assertNotEqual(0, proc.returncode, bad)

    def test_manual_rejects_symlink(self):
        self.repo.write("chapters/real.md")
        self.repo.symlink("chapters/link.md", "chapters/real.md")
        self.repo.commit()
        proc, _ = self.repo.run(event="workflow_dispatch", file="chapters/link.md")
        self.assertNotEqual(0, proc.returncode)

    def test_collision_refused(self):
        self.repo.write("chapters/the-blue-cross.md")
        self.repo.write("chapters/the_blue_cross.md")
        head = self.repo.commit()
        proc, _ = self.push(ZERO, head)
        self.assertNotEqual(0, proc.returncode)
        self.assertIn("Chapter.TheBlueCross", proc.stderr)
        # The collision blocks even a manual dispatch of just one of the files.
        proc, _ = self.repo.run(event="workflow_dispatch", file="chapters/the-blue-cross.md")
        self.assertNotEqual(0, proc.returncode)

    def test_nested_same_basename_collides(self):
        self.repo.write("chapters/one/common.md")
        self.repo.write("chapters/two/common.md")
        head = self.repo.commit()
        proc, _ = self.push(ZERO, head)
        self.assertNotEqual(0, proc.returncode)
        self.assertIn("Chapter.Common", proc.stderr)

    def test_no_collision_for_distinct_names(self):
        self.repo.write("chapters/one/a.md")
        self.repo.write("chapters/two/b.md")
        head = self.repo.commit()
        proc, files = self.push(ZERO, head)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual({"chapters/one/a.md", "chapters/two/b.md"}, set(files))

    def test_output_json_and_empty(self):
        proc, files = self.repo.run(event="workflow_dispatch", file="")
        self.assertNotEqual(0, proc.returncode)
        proc, files = self.push(ZERO, self.repo.base)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual([], files)

    def test_no_output_file_prints_to_stdout(self):
        self.repo.write("chapters/a.md")
        head = self.repo.commit()
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--repo", str(self.repo.root),
             "--event", "push", "--before", ZERO, "--sha", head],
            capture_output=True, text=True)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual(["chapters/a.md"], json.loads(proc.stdout.split("files=", 1)[1].strip()))


if __name__ == "__main__":
    unittest.main()
