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
    """Chapter.<CamelCase(file-stem)>: split on non-alphanumerics, capitalise each part."""
    parts = re.split(r"[^A-Za-z0-9]+", stem)
    return "".join(part[:1].upper() + part[1:] for part in parts if part)


def chapter_base_name(path):
    return "Chapter." + camel_case(os.path.splitext(os.path.basename(path))[0])


def is_excluded(path):
    return os.path.basename(path) in EXCLUDED_NAMES


def is_valid(path):
    return bool(VALID.match(path)) and ".." not in path.split("/")


def is_regular_file(root, path):
    absolute = os.path.join(root, path)
    if not os.path.isfile(absolute) or os.path.islink(absolute):
        return False
    return os.path.realpath(absolute).startswith(os.path.realpath(root) + os.sep)


def git(root, *args):
    return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True)


def changed_paths(root, before, sha):
    """The added/modified chapter files between `before` and `sha`, or of `sha` alone."""
    if re.fullmatch(r"0+", before or ""):
        use_root = True
    elif not before:
        use_root = True
    else:
        use_root = git(root, "cat-file", "-e", before + "^{commit}").returncode != 0
    if use_root:
        # A new branch or a force push: there is no usable `before`, so take the head commit's files.
        result = git(root, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r",
                     "--no-renames", "--diff-filter=AM", sha, "--", "chapters/*.md")
    else:
        # --no-renames: a renamed file shows as delete + add, so the new name is built.
        result = git(root, "diff", "--name-only", "--no-renames", "--diff-filter=AM",
                     before, sha, "--", "chapters/*.md")
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
    for raw in candidates:
        path = raw.strip()
        if not path:
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
