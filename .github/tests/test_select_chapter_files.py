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
KEEP = "chapters/keep.md"
MASTER_ONLY = "chapters/master-only.md"
SHARED = "chapters/shared.md"
FEATURE_NEW = "chapters/feature-new.md"

sys.path.insert(0, str(SCRIPT.parent))
import select_chapter_files  # noqa: E402  (the module under test, for its camel_case)

camel_case = select_chapter_files.camel_case


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if result.returncode != 0 and args[:2] != ("cat-file", "-e"):
        raise AssertionError(f"git {' '.join(args)}: {result.stderr}")
    return result.stdout.strip()


class Repo:
    """A throwaway git repo that chapter files can be added to between commits."""

    def __init__(self, files=(".keep",)):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "t@example.com")
        git(self.root, "config", "user.name", "t")
        git(self.root, "checkout", "-q", "-b", "master")
        for path in files:
            self.write(path)
        self.base = self.commit("base")

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
        return self.head()

    def head(self):
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

    def test_zero_and_missing_before_fall_back(self):
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

    def first_parent_merge(self):
        """Two chapters, a side branch that changes one and adds one, master moving on, and a
        --no-ff merge. Returns (first_parent, merge, changed) for a two-parent head."""
        self.repo.write(KEEP)
        self.repo.write(SHARED, "one\n")
        self.repo.commit("chapters exist")
        git(self.repo.root, "checkout", "-q", "-b", "feature")
        self.repo.write(SHARED, "two\n")
        self.repo.write(FEATURE_NEW)
        side = self.repo.commit("feature")
        git(self.repo.root, "checkout", "-q", "master")
        self.repo.write(MASTER_ONLY)
        first = self.repo.commit("master moves on")
        git(self.repo.root, "merge", "-q", "--no-ff", "-m", "merge feature", side)
        merge = self.repo.head()
        parents = git(self.repo.root, "rev-list", "--parents", "-n", "1", merge).split()
        self.assertEqual(3, len(parents), parents)
        return first, merge, {SHARED, FEATURE_NEW}

    def test_missing_empty_and_zero_before_select_merge_changes(self):
        # A push whose `before` is unusable (new branch, force push) still selects the chapters a
        # merge brought in, instead of silently selecting nothing.
        _, merge, changed = self.first_parent_merge()
        for before in ("", ZERO, "deadbeef" * 5):
            with self.subTest(before=before[:8]):
                proc, files = self.push(before, merge)
                self.assertEqual(0, proc.returncode, proc.stderr)
                self.assertCountEqual(files, changed)  # a merge lists no file once per parent
                # Present and unchanged on the first parent: already built, never re-selected.
                self.assertNotIn(KEEP, files)
                self.assertNotIn(MASTER_ONLY, files)

    def test_valid_before_selects_the_same_merge_changes(self):
        first, merge, changed = self.first_parent_merge()
        proc, files = self.push(first, merge)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertCountEqual(files, changed)

    def test_merge_rename_selects_the_new_path(self):
        self.repo.write("chapters/old.md")
        self.repo.commit("chapter exists")
        git(self.repo.root, "checkout", "-q", "-b", "feature")
        git(self.repo.root, "mv", "chapters/old.md", "chapters/new.md")
        side = self.repo.commit("rename")
        git(self.repo.root, "checkout", "-q", "master")
        self.repo.write(MASTER_ONLY)
        first = self.repo.commit("master moves on")
        git(self.repo.root, "merge", "-q", "--no-ff", "-m", "merge feature", side)
        merge = self.repo.head()
        for before in (ZERO, first):
            with self.subTest(before=before[:8]):
                proc, files = self.push(before, merge)
                self.assertEqual(0, proc.returncode, proc.stderr)
                self.assertEqual(["chapters/new.md"], files)  # the deleted old path is dropped

    def test_true_root_commit_selects_its_own_chapter(self):
        # Repo() commits `.keep` first, so only this repo's first commit is a real root commit.
        root_repo = Repo(files=("chapters/a.md",))
        self.addCleanup(root_repo.close)
        self.assertEqual(1, len(git(root_repo.root, "rev-list", "--parents", "-n", "1",
                                    root_repo.base).split()))
        for before in ("", ZERO, "deadbeef" * 5):
            with self.subTest(before=before[:8]):
                proc, files = root_repo.run(event="push", before=before, sha=root_repo.base)
                self.assertEqual(0, proc.returncode, proc.stderr)
                self.assertEqual(["chapters/a.md"], files)

    def test_unresolvable_head_is_not_an_empty_selection(self):
        # A head git cannot resolve is a broken push, not "no chapter changed".
        proc, files = self.push(ZERO, "deadbeef" * 5)
        self.assertNotEqual(0, proc.returncode)
        self.assertIsNone(files)
        proc, files = self.push(ZERO, "")
        self.assertNotEqual(0, proc.returncode)
        self.assertIsNone(files)

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
        # A working symlink (target relative to the link's own directory), not a dangling one.
        self.repo.symlink("chapters/link.md", "real.md")
        self.assertTrue((self.repo.root / "chapters" / "link.md").is_file())
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
        self.repo.symlink("chapters/link.md", "real.md")
        self.assertTrue((self.repo.root / "chapters" / "link.md").is_file())
        self.repo.commit()
        proc, _ = self.repo.run(event="workflow_dispatch", file="chapters/link.md")
        self.assertNotEqual(0, proc.returncode)

    def test_lexical_aliases_rejected(self):
        # A '.' or empty component names the same file but skips the per-file lock/identity.
        self.repo.write("chapters/real/a.md")
        self.repo.commit()
        for alias in ("chapters/./real/a.md", "chapters/real//a.md", "chapters/real/../real/a.md",
                      " chapters/real/a.md", "chapters/real/a.md "):
            with self.subTest(file=alias):
                proc, _ = self.repo.run(event="workflow_dispatch", file=alias)
                self.assertNotEqual(0, proc.returncode, alias)

    def test_directory_symlink_to_same_content_skipped(self):
        # chapters/alias -> real resolves inside the repo, but is still not a source identity.
        self.repo.write("chapters/real/a.md")
        self.repo.symlink("chapters/alias", "real")
        head = self.repo.commit()
        proc, files = self.push(ZERO, head)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertNotIn("chapters/alias/a.md", files)
        proc, _ = self.repo.run(event="workflow_dispatch", file="chapters/alias/a.md")
        self.assertNotEqual(0, proc.returncode)

    def test_directory_symlink_outside_root_skipped(self):
        with tempfile.TemporaryDirectory() as outside:
            (Path(outside) / "a.md").write_text("body\n")
            self.repo.symlink("chapters/alias", outside)
            self.repo.commit()
            proc, _ = self.repo.run(event="workflow_dispatch", file="chapters/alias/a.md")
            self.assertNotEqual(0, proc.returncode)

    def test_chapters_root_symlink_skipped(self):
        self.repo.write("real-chapters/a.md")
        self.repo.symlink("chapters", "real-chapters")
        head = self.repo.commit()
        proc, files = self.push(ZERO, head)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertEqual([], files)
        proc, _ = self.repo.run(event="workflow_dispatch", file="chapters/a.md")
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

    def test_case_folding_collides(self):
        # The preparer's slug_to_camel capitalises (FOO→Foo, fooBar→Foobar); the selector must
        # fold the same way or two files would fan out to one Chapter.<Name>.
        for left, right in (("FOO.md", "foo.md"), ("fooBar.md", "foobar.md")):
            with self.subTest(left=left, right=right):
                self.repo.write(f"chapters/{left}")
                self.repo.write(f"chapters/{right}")
                head = self.repo.commit()
                proc, _ = self.push(ZERO, head)
                self.assertNotEqual(0, proc.returncode)
        # Both names separated by a dot or a dash reach the same slug segment.
        self.assertEqual("Chapter.12", self.slug("1.2"))
        self.assertEqual("Chapter.12", self.slug("1-2"))
        self.assertEqual("Chapter.Chapter12", self.slug("chapter-1-2"))
        self.assertEqual("Chapter.TheBlueCross", self.slug("the_blue_cross"))

    def slug(self, stem):
        return "Chapter." + camel_case(stem)

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
