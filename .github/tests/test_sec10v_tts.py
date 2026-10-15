"""Check sec10v.yml selects --reflection for Reflection.* only and forwards tts_names."""
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
WANT_NAMES_ENV = "TTS_NAMES: ${{ github.event.inputs.tts_names }}"
EVAL_RE = re.compile(r"\beval\b")
IDENTITY_STEP = "Write audio reuse identity"
VERIFY_STEPS = ("Verify TTS output (attempt 1)", "Verify TTS output (retry)")
TTS_NAMES_KEY = "tts_names"
TTS_NAMES_FLAG = "--tts-names-json"
TTS_NAMES_JSON = '["Israel Gow", "New York", "O\'Brien $(touch pwned)", "A;B"]'
NO_NAMES = "[]"
NO_NAMES_SPACED = "[ ]"
SPOKEN_TEXT = "Israel Gow walked to New York."
BASE_NAME = "Book.01"
IDENTITY_SEED = f"out/{BASE_NAME}.mp3"
IDENTITY_SIDECAR = f"{BASE_NAME}.audio.json"
TTS_FAKE = "mkdir -p out\n: > out/audiobook.mp3\n"
IDENTITY_FAKE = ': > "out/$OUTPUT_NAME.audio.json"\n'
FFPROBE_FAKE = "#!/bin/sh\nexit 0\n"


def indent_of(line):
    return len(line) - len(line.lstrip())


def script_from_step(lines, idx):
    run_idx = next(j for j in range(idx + 1, min(idx + 20, len(lines))) if lines[j].strip() == "run: |")
    run_indent = indent_of(lines[run_idx])
    body = []
    for line in lines[run_idx + 1:]:
        if line.strip() == "":
            body.append("")
            continue
        if indent_of(line) <= run_indent:
            break
        body.append(line)
    assert body, "empty run block"
    prefix = min(indent_of(b) for b in body if b.strip())
    return "\n".join(b[prefix:] if b.strip() else "" for b in body)


def checked_script(script):
    assert "${{" not in script, "raw input interpolated in shell"
    assert not EVAL_RE.search(script), "eval used"
    return script


def named_script(text, name):
    lines = text.splitlines()
    idx = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {name}")
    return checked_script(script_from_step(lines, idx))


def step_block(text, name):
    lines = text.splitlines()
    idx = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {name}")
    end = next((j for j in range(idx + 1, len(lines)) if lines[j].startswith("      - name:")), len(lines))
    return "\n".join(lines[idx:end])


def input_block(text, name):
    lines = text.splitlines()
    idx = lines.index(f"      {name}:")
    block = [lines[idx]]
    for line in lines[idx + 1:]:
        if line.strip() and indent_of(line) < 8:
            break
        block.append(line)
    return "\n".join(block)


def extract_steps(text):
    lines = text.splitlines()
    out = {}
    for i, line in enumerate(lines):
        m = STEP_RE.match(line)
        if not m:
            continue
        chunk = "\n".join(lines[i:i + 40])
        assert WANT_ENV in chunk, "OUTPUT_NAME env missing"
        assert WANT_NAMES_ENV in chunk, "TTS_NAMES env missing"
        script = checked_script(script_from_step(lines, i))
        assert WANT_IF in script, "--reflection selector missing"
        assert "python scripts/audiobook.py" in script
        out[m.group(2)] = script
    assert set(out) == {"attempt 1", "retry"}, "both TTS blocks required"
    return out


def flag_value(argv):
    assert argv.count(TTS_NAMES_FLAG) == 1, "flag must appear exactly once"
    return argv[argv.index(TTS_NAMES_FLAG) + 1]


def run_step(script, env_vals, fake_python, seeds=()):
    """Run an extracted step with fake python/ffprobe; return (argv lines, out/ names)."""
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "work"
        (work / "out").mkdir(parents=True)
        for rel in seeds:
            (work / rel).touch()
        bindir = Path(tmp) / "bin"
        bindir.mkdir()
        argv_log = Path(tmp) / "argv.txt"
        argv_log.touch()
        py_sh = bindir / "python"
        py_sh.write_text('#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$FAKE_ARGV_LOG"\n' + fake_python)
        ff_sh = bindir / "ffprobe"
        ff_sh.write_text(FFPROBE_FAKE)
        for p in (py_sh, ff_sh):
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
        script_file = Path(tmp) / "step.sh"
        script_file.write_text(script + "\n")
        subprocess.run(["bash", "-n", str(script_file)], check=True, timeout=30)
        env = dict(os.environ)
        env.pop("TTS_NAMES", None)
        env.update(env_vals)
        env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
        env["FAKE_ARGV_LOG"] = str(argv_log)
        subprocess.run(["bash", "-e", "-o", "pipefail", str(script_file)], check=True, cwd=work, env=env, timeout=30)
        assert not (work / "pwned").exists(), "command interpolation executed"
        outputs = sorted(p.name for p in (work / "out").iterdir())
        return argv_log.read_text().splitlines(), outputs


class TtsReflectionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.steps = extract_steps(cls.text)
        cls.identity = named_script(cls.text, IDENTITY_STEP)

    def argv_for(self, step, tts="hello", rate="1.0", voice="", name=BASE_NAME, names=None):
        env = {"TTS_TEXT": tts, "AUDIO_RATE": rate, "VOICE": voice, "OUTPUT_NAME": name}
        if names is not None:
            env["TTS_NAMES"] = names
        argv, outputs = run_step(self.steps[step], env, TTS_FAKE)
        self.assertIn("audiobook.mp3", outputs, "fake TTS did not run")
        return argv

    def identity_argv(self, names=None):
        env = {"TTS_TEXT": SPOKEN_TEXT, "VOICE": "", "AUDIO_RATE": "1.0", "OUTPUT_NAME": BASE_NAME}
        if names is not None:
            env["TTS_NAMES"] = names
        argv, outputs = run_step(self.identity, env, IDENTITY_FAKE, seeds=(IDENTITY_SEED,))
        self.assertIn(IDENTITY_SIDECAR, outputs, "fake identity did not run")
        return argv

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

    def test_tts_names_forwarded_verbatim_and_identical(self):
        a1 = self.argv_for("attempt 1", names=TTS_NAMES_JSON)
        rt = self.argv_for("retry", names=TTS_NAMES_JSON)
        self.assertEqual(a1, rt)
        self.assertEqual(flag_value(a1), TTS_NAMES_JSON)

    def test_dotted_initials_reach_generation_retry_and_identity_unchanged(self):
        names = '["G. K. Chesterton"]'
        spoken = "G. K. Chesterton wrote about Father Brown."
        for step in ("attempt 1", "retry"):
            with self.subTest(step=step):
                argv = self.argv_for(step, tts=spoken, names=names)
                self.assertEqual(flag_value(argv), names)
                self.assertEqual(argv[argv.index("--tts") + 1], spoken)
        self.assertEqual(flag_value(self.identity_argv(names=names)), names)

    def test_tts_names_absent_or_empty_is_no_op(self):
        for step in ("attempt 1", "retry"):
            baseline = self.argv_for(step)
            self.assertNotIn(TTS_NAMES_FLAG, baseline)
            for names in ("", NO_NAMES):
                with self.subTest(step=step, names=names):
                    self.assertEqual(self.argv_for(step, names=names), baseline)

    def test_tts_names_whitespace_array_forwarded_unchanged(self):
        for step in ("attempt 1", "retry"):
            with self.subTest(step=step):
                self.assertEqual(flag_value(self.argv_for(step, names=NO_NAMES_SPACED)), NO_NAMES_SPACED)
        self.assertEqual(flag_value(self.identity_argv(names=NO_NAMES_SPACED)), NO_NAMES_SPACED)

    def test_tts_names_leaves_text_and_reflection_flag_unchanged(self):
        argv = self.argv_for("attempt 1", tts=SPOKEN_TEXT, name="Reflection.Book.01", names=TTS_NAMES_JSON)
        self.assertEqual(argv[argv.index("--tts") + 1], SPOKEN_TEXT)
        self.assertIn("--reflection", argv)
        self.assertNotIn("IsraelGow", "\n".join(argv))

    def test_identity_receives_same_names_flag(self):
        names = flag_value(self.argv_for("attempt 1", names=TTS_NAMES_JSON))
        self.assertEqual(flag_value(self.identity_argv(names=TTS_NAMES_JSON)), names)

    def test_identity_default_is_no_op(self):
        baseline = self.identity_argv()
        self.assertNotIn(TTS_NAMES_FLAG, baseline)
        for names in ("", NO_NAMES):
            with self.subTest(names=names):
                self.assertEqual(self.identity_argv(names=names), baseline)

    def test_workflow_declares_tts_names_input(self):
        block = input_block(self.text, TTS_NAMES_KEY)
        for want in ("required: false", "type: string", "default: '[]'"):
            self.assertIn(want, block)

    def test_verification_does_not_read_names(self):
        for step in VERIFY_STEPS:
            self.assertNotIn("TTS_NAMES", step_block(self.text, step))
        self.assertIn('printf \'%s\\n\' "$TTS_TEXT" > expected_text.txt', step_block(self.text, VERIFY_STEPS[0]))


if __name__ == "__main__":
    unittest.main()
