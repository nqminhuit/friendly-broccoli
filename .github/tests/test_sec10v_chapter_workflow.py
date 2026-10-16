"""Exercise the sec10v_chapter.yml shell bodies: prepare args, env export, render guards, matrix."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_sec10v_reflection_images import parse_steps, run_body  # noqa: E402

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "sec10v_chapter.yml"
PREPARE_NAME = "Prepare the chapter from your file"
CAPABILITY_NAME = "Check the chapter preparer version"
SHOW_NAME = "Show workflow inputs"
BUILD_NAME = "Build the final video"
UPLOAD_NAME = "Upload video to YouTube"
DISPATCH_NAME = "Dispatch one sec10v.yml run per chunk"
COLLECT_NAME = "Collect MP3s, retry stragglers"
RESTORE_NAME = "Restore a video from a failed upload"
MUSIC_CHECK_NAME = "Check the chapter music ranges"
WARM_STEP = "Warm the Chatterbox weights cache"
VOICE_FROM_FILE = "(from file)"
REAL_VOICE = "_live/stacie.mp3"
FILE = "chapters/the-blue-cross.md"
STATIC = {"base_name": "Chapter.TheBlueCross", "book_title": "Book", "chapter_title": "The Blue Cross",
          "author": "G. K. Chesterton", "voice": "_live/v.mp3", "video_motion": "static",
          "video_framerate": "5", "fade_in_seconds": "0", "fade_out_seconds": "0"}
KEN_BURNS = {**STATIC, "video_motion": "ken-burns", "video_framerate": "30",
             "fade_in_seconds": "1", "fade_out_seconds": "1.5"}
MISMATCHED = {**STATIC, "video_motion": "ken-burns", "video_framerate": "5"}
PREPARE_FAKE = 'case "$*" in *prepare_markdown_chapter.py*) exit 0;; esac'


def python_stub(fake, delegate=True):
    return f"#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$ARGV_LOG\"\n{fake}\nexec \"$REAL_PYTHON\" \"$@\"\n" if delegate \
        else f"#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$ARGV_LOG\"\n{fake}\nexit 0\n"


def run_shell(script, cwd, env_vals, fake=":", delegate=True):
    """Run an extracted body with python/aws stubs; return (proc, argv lines, env file)."""
    with tempfile.TemporaryDirectory() as tmp:
        bindir = Path(tmp) / "bin"
        bindir.mkdir()
        argv_log = Path(tmp) / "argv.txt"
        argv_log.touch()
        stub = bindir / "python"
        stub.write_text(python_stub(fake, delegate))
        aws = bindir / "aws"
        aws.write_text("#!/bin/sh\nexit 0\n")
        for path in (stub, aws):
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        step = Path(tmp) / "step.sh"
        step.write_text(script + "\n")
        subprocess.run(["bash", "-n", str(step)], check=True, timeout=30)
        env = dict(os.environ)
        env.update(env_vals)
        env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
        env["ARGV_LOG"] = str(argv_log)
        env["REAL_PYTHON"] = sys.executable
        env["GITHUB_ENV"] = str(Path(tmp) / "github_env.txt")
        Path(env["GITHUB_ENV"]).touch()
        env["GITHUB_STEP_SUMMARY"] = str(Path(tmp) / "summary.md")
        Path(env["GITHUB_STEP_SUMMARY"]).touch()
        env["GITHUB_OUTPUT"] = str(Path(tmp) / "output.txt")
        Path(env["GITHUB_OUTPUT"]).touch()
        proc = subprocess.run(["bash", "-e", str(step)], cwd=cwd, env=env,
                              capture_output=True, text=True, timeout=60)
        argv = argv_log.read_text().splitlines()
        return proc, argv, Path(env["GITHUB_ENV"]).read_text()


def make_work(tmp, chapter):
    work = Path(tmp) / "sec10v"
    (work / "out" / "text").mkdir(parents=True)
    (work / "out" / "pics").mkdir(parents=True)
    (work / "scripts").mkdir(parents=True)
    (work / "scripts" / "video_fallback.py").write_text("x")
    (work / "out" / "chapter.json").write_text(json.dumps(chapter))
    (work / "out" / "text" / "x.txt").write_text("text")
    (work / "out" / "workflow-input.json").write_text('[{"chunk": 1}]')
    (work / "out" / "B.final.mp4").write_bytes(b"v" * 16)
    return work


class ChapterWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.doc = yaml.safe_load(cls.text)
        cls.blocks = parse_steps(cls.text)
        cls.shells = {k: run_body(v) for k, v in cls.blocks.items() if "run: |" in v}

    def test_env_defaults(self):
        env = self.doc["env"]
        self.assertEqual("20", env["IMAGE_EARLY_WAIT_MINUTES"])
        self.assertEqual("60", env["IMAGE_WAIT_MINUTES"])
        self.assertEqual("60", env["MAX_CHUNKS"])
        self.assertEqual(VOICE_FROM_FILE, env["VOICE_FROM_FILE"])
        for banned in ("GEMINI_MODEL", "INTRO_AUDIO", "OUTRO_AUDIO", "VIDEO_FRAMERATE", "VIDEO_MOTION"):
            self.assertNotIn(banned, env, banned)

    def test_matrix_and_files_serialization(self):
        job = self.doc["jobs"]["chapter"]
        self.assertEqual("${{ matrix.file }}", job["name"])
        self.assertEqual("${{ fromJSON(needs.files.outputs.files) }}", job["strategy"]["matrix"]["file"])
        self.assertEqual(1, job["strategy"]["max-parallel"])
        self.assertIs(job["strategy"]["fail-fast"], False)
        self.assertEqual("needs.files.outputs.files != '[]'", job["if"])
        self.assertIn("${{ steps.list.outputs.files }}", self.doc["jobs"]["files"]["outputs"]["files"])
        # Nothing globs every chapter: only the selected files build.
        self.assertNotIn("ls chapters", self.text)

    def test_capability_check(self):
        body = self.shells[CAPABILITY_NAME]
        self.assertIn("from prepare_markdown_chapter import MARKDOWN_CHAPTER_VERSION", body)
        self.assertIn("MARKDOWN_CHAPTER_VERSION < 1", body)
        self.assertIn("use a newer sec10v_ref", body)

    def test_prepare_args_and_env_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_work(tmp, STATIC)
            env = {"GITHUB_WORKSPACE": tmp, "FILE": FILE, "MAX_CHUNKS": "60",
                   "VOICE_OVERRIDE": VOICE_FROM_FILE, "VOICE_FROM_FILE": VOICE_FROM_FILE}
            proc, argv, github_env = run_shell(self.shells[PREPARE_NAME], work, env, fake=PREPARE_FAKE)
            self.assertEqual(0, proc.returncode, proc.stderr)
            script = [i for i, a in enumerate(argv) if a == "scripts/prepare_markdown_chapter.py"]
            self.assertEqual(1, len(script), argv)
            start = script[0]
            self.assertEqual(f"{tmp}/{FILE}", argv[argv.index("--script-file") + 1])
            self.assertEqual("60", argv[argv.index("--max-chunks") + 1])
            self.assertNotIn("--voice", argv[start:start + 6])
            for line in ("BASE=Chapter.TheBlueCross", "BOOK_TITLE=Book", "CHAPTER_TITLE=The Blue Cross",
                         "AUTHOR=G. K. Chesterton", "VOICE=_live/v.mp3", "VIDEO_MOTION=static",
                         "VIDEO_FRAMERATE=5", "FADE_IN_SECONDS=0", "FADE_OUT_SECONDS=0"):
                self.assertIn(line, github_env, line)

    def test_prepare_voice_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_work(tmp, KEN_BURNS)
            env = {"GITHUB_WORKSPACE": tmp, "FILE": FILE, "MAX_CHUNKS": "60",
                   "VOICE_OVERRIDE": REAL_VOICE, "VOICE_FROM_FILE": VOICE_FROM_FILE}
            proc, argv, github_env = run_shell(self.shells[PREPARE_NAME], work, env, fake=PREPARE_FAKE)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertEqual(REAL_VOICE, argv[argv.index("--voice") + 1])
            for line in ("VIDEO_MOTION=ken-burns", "VIDEO_FRAMERATE=30",
                         "FADE_IN_SECONDS=1", "FADE_OUT_SECONDS=1.5"):
                self.assertIn(line, github_env, line)

    def test_prepare_rejects_mismatched_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_work(tmp, MISMATCHED)
            env = {"GITHUB_WORKSPACE": tmp, "FILE": FILE, "MAX_CHUNKS": "60",
                   "VOICE_OVERRIDE": VOICE_FROM_FILE, "VOICE_FROM_FILE": VOICE_FROM_FILE}
            proc, _, github_env = run_shell(self.shells[PREPARE_NAME], work, env, fake=PREPARE_FAKE)
            self.assertNotEqual(0, proc.returncode)
            self.assertNotIn("VIDEO_MOTION=ken-burns", github_env)

    def test_show_inputs_is_env_safe(self):
        evil = 'x"; $(touch pwned); echo "y'
        with tempfile.TemporaryDirectory() as tmp:
            work = make_work(tmp, STATIC)
            env = {"FILE": evil, "SEC10V_REF": "master", "VOICE_OVERRIDE": VOICE_FROM_FILE,
                   "FRESH": "false", "EVENT": "push"}
            proc, _, _ = run_shell(self.shells[SHOW_NAME], work, env)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertFalse((work / "pwned").exists())
        self.assertNotIn("${{", self.shells[SHOW_NAME])

    def test_audio_and_render_guards(self):
        needs_tts = "steps.tts.outputs.needs_tts == 'true'"
        for name in (WARM_STEP, "Restore the Chatterbox weights cache",
                     "Save the Chatterbox weights cache", DISPATCH_NAME, COLLECT_NAME):
            self.assertIn(needs_tts, self.blocks[name], name)
        self.assertIn("== 'miss'", self.blocks[BUILD_NAME])
        self.assertIn("steps.image.outputs.found == 'true'", self.blocks[BUILD_NAME])
        self.assertIn("steps.image_retry.outputs.found == 'true'", self.blocks[BUILD_NAME])
        # The image wait still runs when no TTS is needed, so a cached run can render.
        self.assertNotIn(needs_tts, self.blocks["Wait for the chapter images (while the chunks synthesize)"])

    def test_music_check_ordering_and_guard(self):
        order = list(self.blocks)
        self.assertLess(order.index(RESTORE_NAME), order.index("Install ffmpeg"))
        self.assertLess(order.index("Install ffmpeg"), order.index(MUSIC_CHECK_NAME))
        for later in (WARM_STEP, DISPATCH_NAME):
            self.assertLess(order.index(MUSIC_CHECK_NAME), order.index(later), later)
        block = self.blocks[MUSIC_CHECK_NAME]
        self.assertIn("steps.fallback.outputs.status == 'miss'", block)
        # A cached-narration run still renders its music, so the check must not use needs_tts.
        self.assertNotIn("needs_tts", block)

    def test_music_check_is_validation_only(self):
        body = self.shells[MUSIC_CHECK_NAME]
        self.assertIn("--check-music", body)
        # Never the normal prepare: no chunk cap, no manifest/output rewriting, no env export.
        for banned in ("--max-chunks", "out/", "GITHUB_ENV"):
            self.assertNotIn(banned, body, banned)

    def test_music_check_args_and_voice_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_work(tmp, STATIC)
            env = {"GITHUB_WORKSPACE": tmp, "FILE": FILE,
                   "VOICE_OVERRIDE": VOICE_FROM_FILE, "VOICE_FROM_FILE": VOICE_FROM_FILE}
            proc, argv, github_env = run_shell(self.shells[MUSIC_CHECK_NAME], work, env, fake=PREPARE_FAKE)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn("scripts/prepare_markdown_chapter.py", argv)
            self.assertEqual(f"{tmp}/{FILE}", argv[argv.index("--script-file") + 1])
            self.assertIn("--check-music", argv)
            self.assertNotIn("--max-chunks", argv)
            # The sentinel is not a real voice and must not be forwarded.
            self.assertNotIn("--voice", argv)
            self.assertEqual("", github_env)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_work(tmp, STATIC)
            env = {"GITHUB_WORKSPACE": tmp, "FILE": FILE,
                   "VOICE_OVERRIDE": REAL_VOICE, "VOICE_FROM_FILE": VOICE_FROM_FILE}
            proc, argv, _ = run_shell(self.shells[MUSIC_CHECK_NAME], work, env, fake=PREPARE_FAKE)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertEqual(REAL_VOICE, argv[argv.index("--voice") + 1])

    def test_music_check_failure_fails_the_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_work(tmp, STATIC)
            env = {"GITHUB_WORKSPACE": tmp, "FILE": FILE,
                   "VOICE_OVERRIDE": VOICE_FROM_FILE, "VOICE_FROM_FILE": VOICE_FROM_FILE}
            fake = 'case "$*" in *--check-music*) exit 4;; esac'
            proc, _, _ = run_shell(self.shells[MUSIC_CHECK_NAME], work, env, fake=fake, delegate=False)
            self.assertEqual(4, proc.returncode)

    def test_tts_decision_only_sets_needs_tts(self):
        body = self.shells["Decide what still needs doing"]
        self.assertIn("needs_tts=false", body)
        self.assertIn("needs_tts=true", body)
        self.assertNotIn("creative", body)
        self.assertNotIn("out/prompts", body)

    def test_build_motion_flags(self):
        for chapter, want in ((STATIC, False), (KEN_BURNS, True)):
            with tempfile.TemporaryDirectory() as tmp, self.subTest(motion=chapter["video_motion"]):
                work = make_work(tmp, chapter)
                env = {"BASE": chapter["base_name"], "VIDEO_MOTION": chapter["video_motion"],
                       "VIDEO_FRAMERATE": chapter["video_framerate"],
                       "FADE_IN_SECONDS": chapter["fade_in_seconds"],
                       "FADE_OUT_SECONDS": chapter["fade_out_seconds"], "PYTHONPATH": "scripts"}
                proc, argv, _ = run_shell(self.shells[BUILD_NAME], work, env, delegate=False)
                self.assertEqual(0, proc.returncode, proc.stderr)
                self.assertIn("scripts/automate_audiobook.py", argv)
                self.assertEqual(want, "--ken-burns" in argv)
                self.assertEqual(chapter["video_framerate"], argv[argv.index("--framerate") + 1])
                self.assertEqual(chapter["fade_out_seconds"], argv[argv.index("--fade-out") + 1])
                self.assertEqual("out/segment-images.json", argv[argv.index("--segment-images") + 1])
                self.assertNotIn("--crossfade", argv)
                self.assertNotIn("--intro-audio", argv)
                self.assertNotIn("--outro-audio", argv)

    def test_upload_forwards_dedicated_thumbnail(self):
        body = self.shells[UPLOAD_NAME]
        self.assertIn('--thumbnail "$thumbnail"', body)
        self.assertIn('thumbnail="out/pics/${BASE}.thumb.jpg"', body)
        self.assertIn('[ ! -s "$thumbnail" ]', body)
        self.assertIn('--fallback-title "${BOOK_TITLE} — ${CHAPTER_TITLE}"', body)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_work(tmp, STATIC)
            (work / "out" / "seo").mkdir()
            (work / "out" / "seo" / "B.seo.md").write_text("seo")
            proc, argv, _ = run_shell(self.shells[UPLOAD_NAME], work,
                                         {"BASE": "B", "BOOK_TITLE": "Book", "CHAPTER_TITLE": "Ch",
                                          "PYTHONPATH": "scripts"}, delegate=False)
            self.assertNotEqual(0, proc.returncode, "missing thumbnail must not upload")
            (work / "out" / "pics" / "B.thumb.jpg").write_bytes(b"t" * 16)
            proc, argv, _ = run_shell(self.shells[UPLOAD_NAME], work,
                                         {"BASE": "B", "BOOK_TITLE": "Book", "CHAPTER_TITLE": "Ch",
                                          "PYTHONPATH": "scripts"}, delegate=False)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn("out/pics/B.thumb.jpg", argv)
            self.assertIn("--thumbnail", argv)

    def test_exact_file_source_identity(self):
        body = self.shells[RESTORE_NAME]
        self.assertIn('--source-id "$FILE"', body)
        self.assertIn('--source-file "$GITHUB_WORKSPACE/$FILE"', body)
        self.assertIn("--kind chapter", body)
        self.assertIn("sec10v_chapter.yml", body)
        self.assertNotIn("--image-ref", body)
        self.assertNotIn("${{", body)

    def test_no_gemini_or_url_dependencies(self):
        lowered = self.text.lower()
        for banned in ("gemini", "se_url", "image_url", "aiohttp", "google.generativeai"):
            self.assertNotIn(banned, lowered, banned)
        for want in ("pip install requests", "python-version: '3.13'"):
            self.assertIn(want, self.text)


if __name__ == "__main__":
    unittest.main()
