"""Check sec10v_chapter.yml reads chapter images from the S3 bucket, not IMAGE_BASE_URL."""
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_sec10v_reflection_images import parse_steps, run_body  # noqa: E402

WORKFLOWS = Path(__file__).resolve().parents[1] / "workflows"
CHAPTER = WORKFLOWS / "sec10v_chapter.yml"
REFLECTION = WORKFLOWS / "sec10v_reflection.yml"
DETECT_NAME = "Detect existing background image"
EARLY_NAME = "Wait for the background image (while the chunks synthesize)"
LATE_NAME = "Wait for the background image (second chance)"
PROMPT_NAME = "🚨 IMAGE PROMPT READY — copy from this step"
FETCH_SCRIPT = "fetch_image.py"
FAKE_RC = "FAKE_FETCH_RC"
FOUND_TRUE = "found=true"
FOUND_FALSE = "found=false"
BUCKET_SECRET = "secrets.CHAPTER_IMAGE_BUCKET"
IMAGE_URL = "https://img.example/a.jpg"
BUCKET_KEYS = ("BUCKET_S3_ENDPOINT", "BUCKET_ACCESS_KEY_ID", "BUCKET_SECRET_ACCESS_KEY")
BASE_ENV = {"BASE": "Base", "IMAGE_URL": "", "IMAGE_BUCKET": "", "IMAGE_EARLY_WAIT_MINUTES": "20",
            "IMAGE_WAIT_MINUTES": "60"}


def run_step(script, env_vals, fake_rc=0):
    """Run a step body with a fake python; return (proc, github_output, fetch_argv)."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        step = tmp / "step.sh"
        step.write_text(script + "\n")
        subprocess.run(["bash", "-n", str(step)], check=True, timeout=30)
        (tmp / "out" / "pics").mkdir(parents=True)
        bindir = tmp / "bin"
        bindir.mkdir()
        argv_log = tmp / "argv.txt"
        argv_log.touch()
        stub = bindir / "python"
        stub.write_text("#!/bin/sh\n"
                        f'case "$*" in *{FETCH_SCRIPT}*) printf \'%s\\n\' "$@" > "{argv_log}"; exit "${FAKE_RC}";; esac\n'
                        f'exec "{sys.executable}" "$@"\n')
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
        out_file = tmp / "github_output.txt"
        out_file.touch()
        env = {**os.environ, **BASE_ENV, **env_vals}
        env["PATH"] = f"{bindir}{os.pathsep}{env['PATH']}"
        env["GITHUB_OUTPUT"] = str(out_file)
        env[FAKE_RC] = str(fake_rc)
        proc = subprocess.run(["bash", "-e", str(step)], cwd=tmp, env=env,
                              capture_output=True, text=True, timeout=60)
        return proc, out_file.read_text(), argv_log.read_text().splitlines()


class ChapterImagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = CHAPTER.read_text()
        cls.blocks = parse_steps(cls.text)
        cls.shells = {k: run_body(v) for k, v in cls.blocks.items() if "run: |" in v}

    def test_no_image_base_url_anywhere(self):
        for path in (CHAPTER, REFLECTION):
            self.assertNotIn("IMAGE_BASE_URL", path.read_text(), path.name)

    def test_steps_map_secrets_to_script_env(self):
        for name in (DETECT_NAME, EARLY_NAME, LATE_NAME):
            block = self.blocks[name]
            self.assertIn(f"IMAGE_BUCKET: ${{{{ {BUCKET_SECRET} }}}}", block)
            self.assertIn("IMAGE_PREFIX: ${{ secrets.CHAPTER_IMAGE_PREFIX }}", block)
            for key in BUCKET_KEYS:
                self.assertIn(f"{key}: ${{{{ secrets.{key} }}}}", block)
            self.assertNotIn("${{", self.shells[name])
        self.assertIn("PYTHONPATH: scripts", self.blocks[DETECT_NAME])
        self.assertIn("set the CHAPTER_IMAGE_BUCKET secret", self.shells[PROMPT_NAME])

    def test_detect_url_supplied(self):
        proc, out, argv = run_step(self.shells[DETECT_NAME], {"IMAGE_URL": IMAGE_URL})
        self.assertEqual(0, proc.returncode, proc.stderr)
        self.assertIn(FOUND_TRUE, out)
        self.assertEqual([], argv)

    def test_detect_probe_maps_exit_codes(self):
        for rc, found, warned in ((0, FOUND_TRUE, False), (10, FOUND_FALSE, False),
                                  (1, FOUND_FALSE, True), (3, FOUND_FALSE, True)):
            proc, out, argv = run_step(self.shells[DETECT_NAME], {"IMAGE_BUCKET": "b"}, fake_rc=rc)
            self.assertEqual(0, proc.returncode, f"rc={rc}: {proc.stderr}")
            self.assertIn(found, out, rc)
            self.assertEqual(["scripts/fetch_image.py", "--base-name", "Base", "--probe"], argv)
            self.assertEqual(warned, f"could not check the image bucket (exit {rc})" in proc.stdout, rc)

    def test_detect_without_bucket_never_probes(self):
        proc, out, argv = run_step(self.shells[DETECT_NAME], {})
        self.assertEqual(0, proc.returncode)
        self.assertIn(FOUND_FALSE, out)
        self.assertEqual([], argv)

    def test_waits_skip_without_url_or_bucket(self):
        for name in (EARLY_NAME, LATE_NAME):
            proc, out, argv = run_step(self.shells[name], {})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(FOUND_FALSE, out)
            self.assertEqual([], argv)
        proc, _, _ = run_step(self.shells[LATE_NAME], {})
        self.assertIn("no CHAPTER_IMAGE_BUCKET secret and no image_url input", proc.stdout)

    def test_waits_pass_url_when_set(self):
        for name in (EARLY_NAME, LATE_NAME):
            proc, out, argv = run_step(self.shells[name], {"IMAGE_URL": IMAGE_URL})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(FOUND_TRUE, out)
            self.assertIn("--url", argv)
            self.assertEqual(IMAGE_URL, argv[argv.index("--url") + 1])
            self.assertNotIn("--base-url", argv)

    def test_waits_use_env_s3_without_source_flag(self):
        for name in (EARLY_NAME, LATE_NAME):
            proc, out, argv = run_step(self.shells[name], {"IMAGE_BUCKET": "b"})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(FOUND_TRUE, out)
            self.assertNotIn("--url", argv)
            self.assertNotIn("--base-url", argv)
            self.assertIn("--base-name", argv)


if __name__ == "__main__":
    unittest.main()
