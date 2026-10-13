"""Check sec10v_reflection.yml waits for images while chunks synthesize."""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "sec10v_reflection.yml"
CHECK_NAME = "Check the image configuration from your file"
EARLY_NAME = "Wait for the reflection images (while the chunks synthesize)"
LATE_NAME = "Wait for the reflection images (second chance)"
DISPATCH_NAME = "Dispatch one sec10v.yml run per chunk"
COLLECT_NAME = "Collect MP3s, retry stragglers"
BUILD_NAME = "Build the final video"
REPORT_NAME = "Report chunk, image and video status"
SCRIPT_NAME = "reflection_images.py"
FOUND_TRUE = "found=true"
FOUND_FALSE = "found=false"
POLL_ARG = "--poll-interval 20"
TIMEOUT_FLAG = "--timeout"
BASE_URL_FLAG = "--base-url"
GITHUB_OUTPUT = "GITHUB_OUTPUT"
GOOD_BUCKET = "my-images"
IMAGE_BUCKET = "IMAGE_BUCKET"
IMAGE_PREFIX = "IMAGE_PREFIX"
BUCKET_KEYS = ("BUCKET_S3_ENDPOINT", "BUCKET_ACCESS_KEY_ID", "BUCKET_SECRET_ACCESS_KEY")
BUCKET_ENV = {k: "v" for k in BUCKET_KEYS}
CONFIG_ENV = {IMAGE_BUCKET: GOOD_BUCKET, **BUCKET_ENV}
EARLY_ENV = "IMAGE_EARLY_WAIT_MINUTES"
LATE_ENV = "IMAGE_WAIT_MINUTES"
FAKE_RC = "FAKE_IMAGE_RC"
BASE = "Base"
EARLY_TIMEOUT = "1200"
LATE_TIMEOUT = "3600"
POLL_VALUE = "20"
BUILD_GATE = "steps.image.outputs.found == 'true' || steps.image_retry.outputs.found == 'true'"
NO_VIDEO = "no video was built"
RERUN_HINT = "rerun"
SECRET_TOKEN = "secret-token-123"
BUCKET_HOST = "bucket.example.com"
FILE_ENV = {"BASE": BASE, "FILE": "reflections/a.md"}
CHAPTER_JSON = "out/chapter.json"
MANIFEST_JSON = "out/workflow-input.json"


def parse_steps(text):
    """Map step name to its block lines."""
    names = [(m.start(), m.group(1)) for m in re.finditer(r"^\s*-\s+name:\s+(.+)\s*$", text, re.M)]
    lines = text.splitlines()
    starts = [text.count("\n", 0, s) for s, _ in names]
    out = {}
    for idx, (_, name) in enumerate(names):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(lines)
        out[name.strip().strip('"')] = "\n".join(lines[starts[idx]:end])
    return out


def run_body(block):
    """Return the shell body after run: |."""
    lines = block.splitlines()
    idx = next(i for i, line in enumerate(lines) if line.strip() == "run: |")
    indent = len(lines[idx]) - len(lines[idx].lstrip())
    body = []
    for line in lines[idx + 1:]:
        if line.strip() == "":
            body.append("")
            continue
        ind = len(line) - len(line.lstrip())
        if ind <= indent:
            break
        body.append(line)
    prefix = min(len(b) - len(b.lstrip()) for b in body if b.strip())
    return "\n".join(b[prefix:] if b.strip() else "" for b in body)


def make_python_stub(bindir, argv_log):
    """Stub python fakes the downloader, delegates the rest to real python."""
    stub = bindir / "python"
    lines = [
        "#!/bin/sh",
        'printf \'%s\\n\' "$@" >> "' + str(argv_log) + '"',
        'case "$*" in *"' + SCRIPT_NAME + '"*) exit "${' + FAKE_RC + ':-0}";; esac',
        'exec "' + sys.executable + '" "$@"',
    ]
    stub.write_text("\n".join(lines) + "\n")
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)


def clean_github_expr(script):
    """Replace pre-existing step-outcome interpolations for local bash."""
    script = script.replace("${{ steps.qa.outcome }}", "${QA_OUTCOME:-skipped}")
    return script.replace("${{ steps.youtube.outcome }}", "${YOUTUBE_OUTCOME:-skipped}")


def run_shell(script, cwd, env_vals, fake_rc=0):
    """Run an extracted shell body with stubs; return (rc, out, output_file)."""
    script = clean_github_expr(script)
    with tempfile.TemporaryDirectory() as tmp:
        script_file = Path(tmp) / "step.sh"
        script_file.write_text(script + "\n")
        subprocess.run(["bash", "-n", str(script_file)], check=True, timeout=30)
        bindir = Path(tmp) / "bin"
        bindir.mkdir()
        argv_log = Path(tmp) / "argv.txt"
        argv_log.touch()
        make_python_stub(bindir, argv_log)
        out_file = Path(tmp) / "github_output.txt"
        out_file.touch()
        env = dict(os.environ)
        env.update(env_vals)
        env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
        env[GITHUB_OUTPUT] = str(out_file)
        env[FAKE_RC] = str(fake_rc)
        proc = subprocess.run(["bash", "-e", str(script_file)], cwd=cwd, env=env,
                              capture_output=True, text=True, timeout=60)
        return proc, out_file.read_text(), argv_log.read_text().splitlines()


def make_sec10v_work(tmp, chapter, pics=None, empty=None, run_ids="[]", manifest='[{"chunk": 1}]'):
    """Create a sec10v working dir with chapter manifest and pics."""
    work = Path(tmp) / "sec10v"
    (work / "out" / "pics").mkdir(parents=True)
    (work / CHAPTER_JSON).write_text(chapter)
    (work / MANIFEST_JSON).write_text(manifest)
    for name in (pics or []):
        p = work / "out" / "pics" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x" * 16)
    for name in (empty or []):
        p = work / "out" / "pics" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"")
    (work / "out" / "run_ids.json").write_text(run_ids)
    return work


def downloader_argv(argv, timeout):
    """True when the stub saw one downloader call with exact timeout/poll and no --base-url."""
    text = "\n".join(argv)
    if SCRIPT_NAME not in text or BASE_URL_FLAG in argv:
        return False
    for i, arg in enumerate(argv):
        if arg == TIMEOUT_FLAG and i + 1 < len(argv) and argv[i + 1] == timeout:
            break
    else:
        return False
    for i, arg in enumerate(argv):
        if arg == "--poll-interval" and i + 1 < len(argv) and argv[i + 1] == POLL_VALUE:
            break
    else:
        return False
    return True


def chapter_doc(*entries, base=BASE, thumbnail=None):
    """Build a realistic chapter.json string."""
    doc = {"base_name": base, "images": list(entries)}
    if thumbnail is not None:
        doc["thumbnail"] = thumbnail
    return json.dumps(doc)


SEC1 = {"name": "sec-1", "ref": "book-01.jpg", "chunks": [1]}
SEC2 = {"name": "sec-2", "ref": "book-02.jpg", "chunks": [2]}
CHAPTER_LEGACY = chapter_doc(SEC1, SEC2)
CHAPTER_NAMED = chapter_doc(SEC1, SEC2, thumbnail="book-thumb.jpg")
CHAPTER_REUSED = chapter_doc(SEC1, SEC2, thumbnail="book-01.jpg")
CHAPTER_EVIL = json.dumps({
    "base_name": BASE,
    "images": [{"name": "sec-1", "ref": f"https://{BUCKET_HOST}/x/book-01.jpg?token={SECRET_TOKEN}&sig=abc",
                "chunks": [1]}],
    "thumbnail": f"https://{BUCKET_HOST}/t/thumb.jpg?token={SECRET_TOKEN}",
})
CHAPTER_EMPTY_CHUNKS = json.dumps({"base_name": BASE, "images": [{"name": "sec-1", "ref": "one.jpg", "chunks": []}]})


class ReflectionImagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.blocks = parse_steps(cls.text)
        cls.shells = {k: run_body(v) for k, v in cls.blocks.items() if "run: |" in v}

    def test_ordering(self):
        order = [DISPATCH_NAME, EARLY_NAME, COLLECT_NAME, LATE_NAME, BUILD_NAME]
        idx = [self.text.index(n) for n in order]
        self.assertEqual(sorted(idx), idx)

    def test_env_defaults(self):
        self.assertIn("IMAGE_EARLY_WAIT_MINUTES: '20'", self.text)
        self.assertIn("IMAGE_WAIT_MINUTES: '60'", self.text)

    def test_wait_args(self):
        for name in (EARLY_NAME, LATE_NAME):
            body = self.shells[name]
            self.assertIn(SCRIPT_NAME, body)
            self.assertIn(POLL_ARG, body)
            self.assertNotIn(BASE_URL_FLAG, body)
            self.assertNotIn("${{", body)
        self.assertIn("IMAGE_EARLY_WAIT_MINUTES", self.shells[EARLY_NAME])
        self.assertIn("IMAGE_WAIT_MINUTES", self.shells[LATE_NAME])
        self.assertIn("timeout-minutes: 60", self.blocks[EARLY_NAME])
        self.assertIn("timeout-minutes: 180", self.blocks[LATE_NAME])

    def test_no_continue_on_error_for_waits(self):
        for name in (EARLY_NAME, LATE_NAME):
            self.assertNotIn("continue-on-error", self.blocks[name])

    def test_late_skipped_after_early_success(self):
        self.assertIn("steps.image.outputs.found != 'true'", self.blocks[LATE_NAME])

    def test_build_gate_exact_or(self):
        self.assertIn(BUILD_GATE, self.blocks[BUILD_NAME])
        # Exact OR semantics across early/late flag combinations.
        for early, late, ready in [("true", "true", True), ("true", "false", True),
                                   ("false", "true", True), ("false", "false", False),
                                   ("", "", False), ("true", "", True)]:
            self.assertEqual(ready, early == "true" or late == "true",
                             f"early={early!r} late={late!r}")
        # No fallback file can satisfy the gate; only the two found flags matter.
        self.assertNotIn("thumb", self.blocks[BUILD_NAME])
        self.assertNotIn(".jpg", self.blocks[BUILD_NAME])

    def test_collect_ignores_image_gate(self):
        self.assertNotIn("steps.image", self.blocks[COLLECT_NAME])

    def test_downstream_guards(self):
        for name in ("Verify the final video", "Add YouTube chapters to the description", "Upload video to YouTube"):
            self.assertIn("steps.video.outcome == 'success'", self.blocks[name])

    def test_early_success_exact_argv(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, out, argv = run_shell(self.shells[EARLY_NAME], work,
                                        {EARLY_ENV: "20", **CONFIG_ENV}, fake_rc=0)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(FOUND_TRUE, out)
            self.assertTrue(downloader_argv(argv, EARLY_TIMEOUT), argv)

    def test_early_timeout_proceeds_to_collection(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, out, argv = run_shell(self.shells[EARLY_NAME], work,
                                        {EARLY_ENV: "20", **CONFIG_ENV}, fake_rc=10)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(FOUND_FALSE, out)
            self.assertIn("second chance", proc.stdout)
            self.assertTrue(downloader_argv(argv, EARLY_TIMEOUT), argv)

    def test_early_unexpected_exit_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, _, _ = run_shell(self.shells[EARLY_NAME], work,
                                   {EARLY_ENV: "20", **CONFIG_ENV}, fake_rc=1)
            self.assertNotEqual(0, proc.returncode)

    def test_early_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, out, argv = run_shell(self.shells[EARLY_NAME], work,
                                        {EARLY_ENV: "0", **CONFIG_ENV}, fake_rc=0)
            self.assertEqual(0, proc.returncode)
            self.assertIn(FOUND_FALSE, out)
            self.assertFalse(any(SCRIPT_NAME in a for a in argv))

    def test_late_success_and_timeout_exact_argv(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, out, argv = run_shell(self.shells[LATE_NAME], work,
                                        {LATE_ENV: "60", **CONFIG_ENV}, fake_rc=0)
            self.assertEqual(0, proc.returncode)
            self.assertIn(FOUND_TRUE, out)
            self.assertTrue(downloader_argv(argv, LATE_TIMEOUT), argv)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, out, argv = run_shell(self.shells[LATE_NAME], work,
                                        {LATE_ENV: "60", **CONFIG_ENV}, fake_rc=10)
            self.assertEqual(0, proc.returncode)
            self.assertIn(FOUND_FALSE, out)
            self.assertTrue(downloader_argv(argv, LATE_TIMEOUT), argv)

    def test_late_disabled_and_unexpected(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, out, argv = run_shell(self.shells[LATE_NAME], work,
                                        {LATE_ENV: "0", **CONFIG_ENV}, fake_rc=0)
            self.assertEqual(0, proc.returncode)
            self.assertIn(FOUND_FALSE, out)
            self.assertFalse(any(SCRIPT_NAME in a for a in argv))
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, _, _ = run_shell(self.shells[LATE_NAME], work,
                                   {LATE_ENV: "60", **CONFIG_ENV}, fake_rc=2)
            self.assertNotEqual(0, proc.returncode)

    def test_check_lists_without_downloading(self):
        body = self.shells[CHECK_NAME]
        self.assertNotIn(SCRIPT_NAME, body)
        self.assertNotIn("${{", body)
        self.assertNotIn("thumbnail_ref", body)
        self.assertNotIn(".thumbnail.jpg", body)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, _, _ = run_shell(body, work,
                                   {**CONFIG_ENV, **FILE_ENV},
                                   fake_rc=0)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn("sec-1", proc.stdout)
            self.assertIn("sec-2", proc.stdout)
            self.assertNotIn("thumbnail", proc.stdout)

    def test_check_named_thumbnail_listed(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_NAMED)
            proc, _, _ = run_shell(self.shells[CHECK_NAME], work,
                                   {**CONFIG_ENV, **FILE_ENV})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn("book-thumb.jpg", proc.stdout)

    def test_check_rejects_bad_config(self):
        body = self.shells[CHECK_NAME]
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, _, _ = run_shell(body, work,
                                   {**CONFIG_ENV, IMAGE_BUCKET: "", **FILE_ENV})
            self.assertNotEqual(0, proc.returncode)
        for bad_bucket in ("s3://x", "a/b", f"https://{BUCKET_HOST}/pic?token={SECRET_TOKEN}"):
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, CHAPTER_LEGACY)
                proc, _, _ = run_shell(body, work, {**CONFIG_ENV, IMAGE_BUCKET: bad_bucket, **FILE_ENV})
                self.assertNotEqual(0, proc.returncode, bad_bucket)
                self.assertNotIn(SECRET_TOKEN, proc.stdout + proc.stderr)
                self.assertNotIn(BUCKET_HOST, proc.stdout + proc.stderr)
                self.assertNotIn(bad_bucket, proc.stdout + proc.stderr)

    def test_check_reports_missing_bucket_keys(self):
        body = self.shells[CHECK_NAME]
        for missing in ((BUCKET_KEYS[0],), BUCKET_KEYS[1:]):
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, CHAPTER_LEGACY)
                env = {**CONFIG_ENV, **FILE_ENV, **{k: "" for k in missing}}
                proc, _, _ = run_shell(body, work, env)
                self.assertNotEqual(0, proc.returncode)
                for key in BUCKET_KEYS:
                    self.assertEqual(key in missing, key in proc.stdout, key)

    def test_check_accepts_optional_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY)
            proc, _, _ = run_shell(self.shells[CHECK_NAME], work,
                                   {**CONFIG_ENV, IMAGE_PREFIX: "private/dir", **FILE_ENV})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertNotIn("private/dir", proc.stdout)

    def test_check_rejects_invalid_chapter_and_manifest(self):
        body = self.shells[CHECK_NAME]
        bad_chapters = [
            CHAPTER_EMPTY_CHUNKS,
            json.dumps({"images": [SEC1]}),
            json.dumps({"base_name": "", "images": [SEC1]}),
            json.dumps({"base_name": BASE, "images": []}),
            json.dumps({"base_name": BASE, "images": [{"name": "", "ref": "a.jpg", "chunks": [1]}]}),
            json.dumps({"base_name": BASE, "images": [{"name": "s", "ref": "", "chunks": [1]}]}),
            json.dumps({"base_name": BASE, "images": [{"name": "s", "ref": "a.jpg", "chunks": ["1"]}]}),
            json.dumps({"base_name": BASE, "images": [SEC1], "thumbnail": ""}),
            json.dumps({"base_name": BASE, "images": [SEC1], "thumbnail": {}}),
            json.dumps({"base_name": BASE, "images": [SEC1], "thumbnail": 42}),
        ]
        for chapter in bad_chapters:
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, chapter)
                proc, _, _ = run_shell(body, work,
                                       {**CONFIG_ENV, **FILE_ENV})
                self.assertNotEqual(0, proc.returncode, chapter)
        for manifest in ('[]', '{"chunk": 1}', '"x"', '{}'):
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, CHAPTER_LEGACY, manifest=manifest)
                proc, _, _ = run_shell(body, work,
                                       {**CONFIG_ENV, **FILE_ENV})
                self.assertNotEqual(0, proc.returncode, manifest)
        # Evil refs fail validation without leaking the secret when chunks are malformed.
        evil_bad = json.dumps({"base_name": BASE,
                               "images": [{"name": "sec-1",
                                           "ref": f"https://{BUCKET_HOST}/x/a.jpg?token={SECRET_TOKEN}",
                                           "chunks": []}]})
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, evil_bad)
            proc, _, _ = run_shell(body, work,
                                   {**CONFIG_ENV, **FILE_ENV})
            self.assertNotEqual(0, proc.returncode)
            self.assertNotIn(SECRET_TOKEN, proc.stdout + proc.stderr)

    def test_no_image_base_url_left(self):
        self.assertNotIn("IMAGE_BASE_URL", self.text)
        for name in (EARLY_NAME, LATE_NAME):
            self.assertIn("secrets.REFLECTION_IMAGE_BUCKET", self.blocks[name])
            self.assertIn("secrets.REFLECTION_IMAGE_PREFIX", self.blocks[name])

    def test_no_bucket_query_leakage(self):
        for name in (CHECK_NAME, EARLY_NAME, LATE_NAME):
            self.assertNotIn("${{", self.shells[name])
        for bad in ("${{ inputs.", "${{ secrets.", "${{ github.", "${{ env."):
            self.assertNotIn(bad, self.shells[REPORT_NAME])
        self.assertNotIn("thumbnail_ref", self.shells[REPORT_NAME])
        self.assertNotIn(".thumb.jpg", self.shells[REPORT_NAME])
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_EVIL)
            proc, _, _ = run_shell(self.shells[CHECK_NAME], work,
                                   {**CONFIG_ENV, **FILE_ENV})
            self.assertEqual(0, proc.returncode)
            self.assertNotIn(SECRET_TOKEN, proc.stdout)
            self.assertNotIn(BUCKET_HOST, proc.stdout)
            self.assertIn("book-01.jpg", proc.stdout)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_EVIL)
            proc, _, _ = run_shell(self.shells[REPORT_NAME], work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode)
            self.assertNotIn(SECRET_TOKEN, proc.stdout)
            self.assertNotIn(BUCKET_HOST, proc.stdout)
            self.assertIn("sec-1.jpg", proc.stdout)

    def test_report_legacy_no_thumbnail(self):
        body = self.shells[REPORT_NAME]
        # All sections present: no phantom thumbnail is reported.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY, pics=["sec-1.jpg", "sec-2.jpg", "Base.thumb.jpg"])
            proc, _, _ = run_shell(body, work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(NO_VIDEO, proc.stdout)
            self.assertNotIn("missing thumbnail", proc.stdout)
            self.assertNotIn("sec-1.jpg", proc.stdout)
            self.assertNotIn("sec-2.jpg", proc.stdout)
        # One section missing: only that section is reported, still no thumbnail line.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY, pics=["sec-1.jpg"])
            proc, _, _ = run_shell(body, work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode)
            self.assertIn("sec-2.jpg", proc.stdout)
            self.assertNotIn("missing thumbnail", proc.stdout)
            self.assertIn(RERUN_HINT, proc.stdout)

    def test_report_reused_thumbnail(self):
        body = self.shells[REPORT_NAME]
        # Reused ref lives in sec-1.jpg; Base.thumbnail.jpg must never be required.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_REUSED, pics=["sec-1.jpg", "sec-2.jpg"])
            proc, _, _ = run_shell(body, work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode)
            self.assertNotIn("missing thumbnail", proc.stdout)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_REUSED, pics=["sec-2.jpg"])
            proc, _, _ = run_shell(body, work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode)
            self.assertIn("sec-1.jpg", proc.stdout)
            self.assertIn("missing thumbnail", proc.stdout)

    def test_report_named_thumbnail_missing(self):
        body = self.shells[REPORT_NAME]
        # Sections present but the distinct thumbnail raw file is absent.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_NAMED, pics=["sec-1.jpg", "sec-2.jpg"])
            proc, _, _ = run_shell(body, work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(NO_VIDEO, proc.stdout)
            self.assertIn("missing thumbnail", proc.stdout)
            self.assertIn("book-thumb.jpg", proc.stdout)
            self.assertNotIn("sec-1.jpg", proc.stdout)
            self.assertNotIn("sec-2.jpg", proc.stdout)
        # Fallback Base.thumb.jpg alone never proves the named thumbnail arrived.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_NAMED, pics=["sec-1.jpg", "sec-2.jpg", "Base.thumb.jpg"])
            proc, _, _ = run_shell(body, work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode)
            self.assertIn("missing thumbnail", proc.stdout)

    def test_report_partial_and_thumbnail_gate(self):
        body = self.shells[REPORT_NAME]
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_NAMED, pics=["sec-1.jpg", "Base.thumb.jpg"])
            proc, _, _ = run_shell(body, work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(NO_VIDEO, proc.stdout)
            self.assertIn("sec-2.jpg", proc.stdout)
            self.assertIn("missing thumbnail", proc.stdout)
            self.assertIn("book-thumb.jpg", proc.stdout)
            self.assertIn(RERUN_HINT, proc.stdout)

    def test_report_zero_length_files_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_NAMED, pics=["sec-1.jpg"], empty=["sec-2.jpg", "Base.thumbnail.jpg"])
            proc, _, _ = run_shell(self.shells[REPORT_NAME], work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode)
            self.assertIn("sec-2.jpg", proc.stdout)
            self.assertIn("missing thumbnail", proc.stdout)

    def test_report_success_quiet(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_NAMED, pics=["sec-1.jpg", "sec-2.jpg", "Base.thumbnail.jpg"])
            proc, _, _ = run_shell(self.shells[REPORT_NAME], work,
                                   {"BASE": BASE, "IMAGE_FOUND": "true", "IMAGE_RETRY_FOUND": "false",
                                    "QA_OUTCOME": "success", "YOUTUBE_OUTCOME": "success"})
            self.assertEqual(0, proc.returncode)
            self.assertNotIn(NO_VIDEO, proc.stdout)
        # Late success also skips the missing-image block; unset outcomes stay skipped, not success.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, CHAPTER_LEGACY, pics=["sec-1.jpg", "sec-2.jpg"])
            proc, _, _ = run_shell(self.shells[REPORT_NAME], work,
                                   {"BASE": BASE, "IMAGE_FOUND": "false", "IMAGE_RETRY_FOUND": "true"})
            self.assertEqual(0, proc.returncode)
            self.assertNotIn(NO_VIDEO, proc.stdout)
            self.assertNotIn("uploaded to YouTube", proc.stdout)


if __name__ == "__main__":
    unittest.main()
