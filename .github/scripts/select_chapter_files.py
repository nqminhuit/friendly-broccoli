#!/usr/bin/env python3
"""Select the chapters/…/<name>.md files to build from a push diff or a manual dispatch.

Pushes are held to the same path rule the matrix and the CLI use, so an arbitrary filename can
never reach a shell or the matrix JSON. Name collisions are refused before anything is fanned out.
"""
import argparse
import json
import os
import re
import subprocess
import sys

VALID = re.compile(r"^chapters/[A-Za-z0-9._/-]+\.md$")
EXCLUDED_NAMES = frozenset({"README.md", "AGENTS.md"})


def camel_case(stem):
    """Chapter.<CamelCase(file-stem)>. Exactly sec10v prepare_chapter.slug_to_camel, so a
    stem the preparer folds (FOO→Foo, fooBar→Foobar) cannot slip past the collision check."""
    return "".join(part.capitalize() for part in re.split(r"[^A-Za-z0-9]+", stem) if part)


def chapter_base_name(path):
    return "Chapter." + camel_case(os.path.splitext(os.path.basename(path))[0])


def is_excluded(path):
    return os.path.basename(path) in EXCLUDED_NAMES


def is_valid(path):
    """A canonical repo-relative chapters/…/<name>.md path: no empty, '.' or '..' components.
    Unstripped input is rejected too, so a lexical alias never reaches the per-file lock."""
    if not VALID.match(path):
        return False
    return all(part and part not in (".", "..") for part in path.split("/"))


def is_regular_file(root, path):
    """True only when no component under chapters/ (chapters itself included) is a symlink and
    the file resolves inside the repository. A directory symlink to the same content is thus no
    way around the per-file source identity."""
    current = root
    for part in path.split("/"):
        current = os.path.join(current, part)
        if os.path.islink(current):
            return False
    return os.path.isfile(current) and os.path.realpath(current).startswith(os.path.realpath(root) + os.sep)


def git(root, *args):
    return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)


def first_parent(root, sha):
    """The first parent of `sha`, or None for a true root commit. A `sha` that is no commit,
    or a history git cannot read, is fatal — never silently an empty selection."""
    commit = git(root, "rev-parse", "--verify", "--quiet", sha + "^{commit}")
    if commit.returncode != 0:
        raise SystemExit(f"❌ {sha or '(empty sha)'} is not a commit in this repository")
    parent = git(root, "rev-parse", "--verify", "--quiet", sha + "^1")
    if parent.returncode != 0 and parent.stderr.strip():
        raise SystemExit(f"❌ git could not read the history of {sha}: {parent.stderr.strip()}")
    return parent.stdout.strip() or None


def changed_paths(root, before, sha):
    """The added/modified chapter files between `before` and `sha`; with no usable `before`
    (new branch, force push), `sha` against its first parent, or the empty tree for a root."""
    if (
        before
        and not re.fullmatch(r"0+", before)
        and git(root, "cat-file", "-e", before + "^{commit}").returncode == 0
    ):
        # --no-renames: a renamed file shows as delete + add, so the new name is built.
        result = git(root, "diff", "--name-only", "--no-renames", "--diff-filter=AM",
                     before, sha, "--", "chapters/*.md")
    else:
        # First parent only, so a merge still selects the chapters it brought in: -m/all-parents
        # would list a file once per parent and re-select chapters the first parent already built.
        parent = first_parent(root, sha)
        listing = ("--name-only", "--no-renames", "--diff-filter=AM")
        if parent is None:
            # A true root commit has no parent; --root compares it against the empty tree.
            result = git(root, "diff-tree", "--root", "--no-commit-id", "-r",
                         *listing, sha, "--", "chapters/*.md")
        else:
            result = git(root, "diff", *listing, parent, sha, "--", "chapters/*.md")
    if result.returncode != 0:
        raise SystemExit(f"❌ git could not list the changed files: {result.stderr.strip()}")
    return [line for line in result.stdout.splitlines() if line]


def check_collisions(root):
    """Refuse to fan out when two eligible files would generate the same Chapter.<Name>."""
    seen = {}
    chapters = os.path.join(root, "chapters")
    for dirpath, dirnames, filenames in os.walk(chapters):
        dirnames[:] = [name for name in dirnames if name != ".git"]
        for name in filenames:
            if not name.endswith(".md"):
                continue
            path = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
            if is_excluded(path) or not is_valid(path) or not is_regular_file(root, path):
                continue
            seen.setdefault(chapter_base_name(path), []).append(path)
    collisions = {base: paths for base, paths in seen.items() if len(paths) > 1}
    if collisions:
        lines = ["❌ chapter name collision(s) — two files would generate the same base name:"]
        for base, paths in sorted(collisions.items()):
            lines.append(f"  {base}: {', '.join(sorted(paths))}")
        raise SystemExit("\n".join(lines))


def select(args):
    root = os.path.abspath(args.repo)
    manual = args.event == "workflow_dispatch"
    if manual and not args.file.strip():
        print("❌ the file input is required for a manual dispatch", file=sys.stderr)
        raise SystemExit(1)
    candidates = [args.file] if manual else changed_paths(root, args.before, args.sha)
    chosen = []
    for path in candidates:
        if not path.strip():
            continue
        reason = None
        if is_excluded(path):
            reason = f"❌ {path} — README.md and AGENTS.md are never built"
        elif not is_valid(path):
            reason = f"❌ {path} is not a chapters/…/<name>.md path"
        elif not is_regular_file(root, path):
            reason = f"❌ {path} is not a regular file inside the repository"
        if reason is None:
            chosen.append(path)
        elif manual:
            print(reason, file=sys.stderr)
            raise SystemExit(1)
        else:
            print(f"⚠️ skipping {path} — not a buildable chapter file")
    check_collisions(root)
    return chosen


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", default="", help="github.event_name")
    parser.add_argument("--file", default="", help="workflow_dispatch file input")
    parser.add_argument("--before", default="", help="github.event.before")
    parser.add_argument("--sha", default="", help="github.sha")
    parser.add_argument("--repo", default=".", help="repository root")
    parser.add_argument("--output", default="", help="write files=<json> here (e.g. $GITHUB_OUTPUT)")
    args = parser.parse_args(argv)

    chosen = select(args)
    if chosen:
        print("🔨 " + "\n🔨 ".join(chosen))
    else:
        print("⏭️ no chapter file to build")
    line = f"files={json.dumps(chosen)}\n"
    if args.output:
        with open(args.output, "a", encoding="utf-8") as handle:
            handle.write(line)
    else:
        sys.stdout.write(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
