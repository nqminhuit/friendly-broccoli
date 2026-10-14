"""Check optional pause QA sidecar rename and upload."""
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "sec10v.yml"
RENAME_NAME = "Rename output to custom name"
PAUSE_UPLOAD_NAME = "Upload pause QA sidecar"
AUDIO_UPLOAD_NAME = "Upload audio artifacts"
IDENTITY_UPLOAD_NAME = "Upload audio identity sidecar"
SRC_MP3 = "out/audiobook.mp3"
SRC_QA = "out/audiobook.pause-qa.json"
WARN_MARK = "pause QA sidecar could not be renamed"
PAUSE_PATH = "sec10v/out/${{ inputs.output_name }}.pause-qa.json"
UPLOAD_ACTION = "actions/upload-artifact@v7"
PWNED = "pwned"
BOOK = "Book.01"


def parse_steps(text):
    """Map step name to its block lines."""
    names = [(m.start(), m.group(1)) for m in re.finditer(r"^\s*-\s+name:\s+(.+)\s*$", text, re.M)]
    lines = text.splitlines()
    starts = [text.count("\n", 0, s) for s, _ in names]
    out = {}
    for idx, (_, name) in enumerate(names):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(lines)
        out[name.strip()] = "\n".join(lines[starts[idx]:end])
    return out


def run_body(block):
    """Return shell body after run: |."""
    lines = block.splitlines()
    idx = next(i for i, line in enumerate(lines) if line.strip() == "run: |")
    indent = len(lines[idx]) - len(lines[idx].lstrip())
    body = []
    for line in lines[idx + 1:]:
        if line.strip() == "":
            body.append("")
            continue
        if len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line)
    prefix = min(len(b) - len(b.lstrip()) for b in body if b.strip())
    return "\n".join(b[prefix:] if b.strip() else "" for b in body)


def run_rename(script, files, output_name, fake_mv=None):
    """Run rename body with pipefail; return proc, names, pwned flag."""
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "sec10v"
        (work / "out").mkdir(parents=True)
        for rel, data in files.items():
            (work / rel).write_bytes(data)
        bindir = Path(tmp) / "bin"
        bindir.mkdir()
        if fake_mv is not None:
            stub = bindir / "mv"
            stub.write_text(fake_mv)
            stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
        step = Path(tmp) / "step.sh"
        step.write_text(script + "\n")
        subprocess.run(["bash", "-n", str(step)], check=True, timeout=30)
        env = dict(os.environ)
        env["OUTPUT_NAME"] = output_name
        if fake_mv is not None:
            env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
        proc = subprocess.run(["bash", "-e", "-o", "pipefail", str(step)], cwd=work, env=env,
                              capture_output=True, text=True, timeout=30)
        listed = sorted(p.name for p in (work / "out").iterdir())
        pwned = (work / PWNED).exists() or (work / "out" / PWNED).exists()
        return proc, listed, pwned


class PauseQaTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.steps = parse_steps(cls.text)
        cls.rename = run_body(cls.steps[RENAME_NAME])

    def test_rename_uses_env_no_interpolation(self):
        self.assertIn("OUTPUT_NAME: ${{ github.event.inputs.output_name }}", self.steps[RENAME_NAME])
        self.assertNotIn("${{", self.rename)
        self.assertIn(SRC_QA, self.rename)
        self.assertIn(WARN_MARK, self.rename)

    def test_rename_success(self):
        proc, listed, _ = run_rename(self.rename, {SRC_MP3: b"a", SRC_QA: b"{}"}, BOOK)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertIn(BOOK + ".mp3", listed)
        self.assertIn(BOOK + ".pause-qa.json", listed)

    def test_rename_absence_normal(self):
        proc, listed, _ = run_rename(self.rename, {SRC_MP3: b"a"}, BOOK)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertIn(BOOK + ".mp3", listed)
        self.assertNotIn(WARN_MARK, proc.stdout + proc.stderr)

    def test_rename_failure_nonfatal(self):
        fake = "#!/bin/sh\ncase \"$*\" in *pause-qa*) echo \"" + WARN_MARK + "\"; exit 1;; esac\nexec /bin/mv \"$@\"\n"
        proc, listed, _ = run_rename(self.rename, {SRC_MP3: b"a", SRC_QA: b"{}"}, BOOK, fake_mv=fake)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertIn(BOOK + ".mp3", listed)
        self.assertIn(WARN_MARK, proc.stdout + proc.stderr)

    def test_rename_quote_safe(self):
        evil = 'Book.01; $(touch pwned) "q\'x'
        proc, listed, pwned = run_rename(self.rename, {SRC_MP3: b"a", SRC_QA: b"{}"}, evil)
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertIn(evil + ".mp3", listed)
        self.assertIn(evil + ".pause-qa.json", listed)
        self.assertFalse(pwned)

    def test_upload_contract(self):
        block = self.steps[PAUSE_UPLOAD_NAME]
        self.assertIn(UPLOAD_ACTION, block)
        self.assertIn(PAUSE_PATH, block)
        self.assertIn("continue-on-error: true", block)
        self.assertIn("if-no-files-found: ignore", block)
        self.assertIn("retention-days: 1", block)
        self.assertIn("archive: false", block)
        self.assertNotIn("model", block.lower())
        audio = self.steps[AUDIO_UPLOAD_NAME]
        self.assertIn(UPLOAD_ACTION, audio)
        self.assertIn("if-no-files-found: error", audio)
        identity = self.steps[IDENTITY_UPLOAD_NAME]
        self.assertIn(UPLOAD_ACTION, identity)
        self.assertIn("if-no-files-found: error", identity)


if __name__ == "__main__":
    unittest.main()
