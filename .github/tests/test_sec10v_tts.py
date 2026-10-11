"""Check sec10v.yml selects --reflection for Reflection.* only."""
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "sec10v.yml"
STEP_RE = re.compile(r"^(\s*)-\s+name:\s+Run TTS generation \((attempt 1|retry)\)\s*$")
WANT_IF = 'if [[ "$OUTPUT_NAME" == "Reflection" || "$OUTPUT_NAME" == Reflection.* ]]; then args+=(--reflection); fi'
WANT_ENV = "OUTPUT_NAME: ${{ github.event.inputs.output_name }}"


def extract_steps(text):
    lines = text.splitlines()
    out = {}
    for i, line in enumerate(lines):
        m = STEP_RE.match(line)
        if not m:
            continue
        indent = len(line) - len(line.lstrip())
        chunk = "\n".join(lines[i:i + 40])
        assert WANT_ENV in chunk, "OUTPUT_NAME env missing"
        run_idx = next(j for j in range(i + 1, min(i + 20, len(lines))) if lines[j].strip() == "run: |")
        run_indent = len(lines[run_idx]) - len(lines[run_idx].lstrip())
        body = []
        for line2 in lines[run_idx + 1:]:
            if line2.strip() == "":
                body.append("")
                continue
            ind2 = len(line2) - len(line2.lstrip())
            if ind2 <= run_indent:
                break
            body.append(line2)
        assert indent < run_indent < ind2 or body, "bad indentation"
        prefix = min(len(b) - len(b.lstrip()) for b in body if b.strip())
        script = "\n".join(b[prefix:] if b.strip() else "" for b in body)
        assert WANT_IF in script, "--reflection selector missing"
        assert "${{" not in script, "raw input interpolated in shell"
        assert "python scripts/audiobook.py" in script
        out[m.group(2)] = script
    assert set(out) == {"attempt 1", "retry"}, "both TTS blocks required"
    return out


def run_script(script, env_vals):
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "work"
        work.mkdir()
        (work / "out").mkdir()
        bindir = Path(tmp) / "bin"
        bindir.mkdir()
        argv_log = Path(tmp) / "argv.txt"
        argv_log.touch()
        py_sh = bindir / "python"
        py_sh.write_text('#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$FAKE_ARGV_LOG"\nmkdir -p out\n: > out/audiobook.mp3\n')
        ff_sh = bindir / "ffprobe"
        ff_sh.write_text("#!/bin/sh\nexit 0\n")
        for p in (py_sh, ff_sh):
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
        script_file = Path(tmp) / "step.sh"
        script_file.write_text(script + "\n")
        subprocess.run(["bash", "-n", str(script_file)], check=True, timeout=30)
        env = dict(os.environ)
        env.update(env_vals)
        env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
        env["FAKE_ARGV_LOG"] = str(argv_log)
        subprocess.run(["bash", str(script_file)], check=True, cwd=work, env=env, timeout=30)
        assert (work / "out" / "audiobook.mp3").is_file(), "fake TTS did not run"
        assert not (work / "pwned").exists(), "command interpolation executed"
        return argv_log.read_text().splitlines()


class TtsReflectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.steps = extract_steps(WORKFLOW.read_text())

    def argv_for(self, step, tts="hello", rate="1.0", voice="", name="Book.01"):
        return run_script(self.steps[step], {"TTS_TEXT": tts, "AUDIO_RATE": rate, "VOICE": voice, "OUTPUT_NAME": name})

    def test_exact_and_prefix_match(self):
        for name, want in [("Reflection", True), ("Reflection.Book.01", True),
                           ("Book.01", False), ("Reflectionish.01", False),
                           ("VoiceTest.Reflection.Sample", False)]:
            for step in ("attempt 1", "retry"):
                with self.subTest(name=name, step=step):
                    argv = self.argv_for(step, name=name)
                    self.assertEqual(want, "--reflection" in argv)

    def test_forwarding_and_parity(self):
        evil_text = 'hi"; $(touch pwned); echo "x`id`y\'$HOME'
        evil_name = "Book.01; $(touch pwned)"
        for step in ("attempt 1", "retry"):
            argv = self.argv_for(step, tts=evil_text, rate="0.9",
                                 voice="_live/v.wav", name=evil_name)
            self.assertIn(evil_text, argv)
            self.assertIn("0.9", argv)
            self.assertIn("_live/v.wav", argv)
            self.assertNotIn("--reflection", argv)
        a1 = self.argv_for("attempt 1", tts="hello", rate="1.0", voice="v.wav", name="Reflection.Book.01")
        rt = self.argv_for("retry", tts="hello", rate="1.0", voice="v.wav", name="Reflection.Book.01")
        self.assertEqual(a1, rt)
        self.assertIn("--reflection", a1)
        novoice = self.argv_for("attempt 1", voice="", name="Reflection")
        self.assertNotIn("--voice", novoice)


if __name__ == "__main__":
    unittest.main()
