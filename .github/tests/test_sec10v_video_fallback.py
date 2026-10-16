"""Check fallback-only saved-video retries in chapter + reflection workflows."""
import json
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

CHAPTER = Path(__file__).resolve().parents[1] / "workflows" / "sec10v_chapter.yml"
REFLECTION = Path(__file__).resolve().parents[1] / "workflows" / "sec10v_reflection.yml"
RESTORE_NAME = "Restore a video from a failed upload"
UPLOAD_NAME = "Upload video to YouTube"
VERIFY_NAME = "Verify the final video"
QA_RESTORE_NAME = "Restore the saved QA summary"
FALLBACK_GUARD = "steps.fallback.outputs.status == 'miss'"
RESTORED_GUARD = "steps.fallback.outputs.status == 'restored'"
VIDEO_OK = "steps.video.outcome == 'success'"
HELPER = "scripts/video_fallback.py"
AWS_CHECK = "command -v aws"
BUCKET_KEY = "BUCKET_S3_URI"
QA_FILE = "out/${BASE}.qa.md"
POLL_ARG = "--poll-interval 20"
TRANSCRIPT_NAME = "Publish the transcript to the summary"
CHAPTER_EARLY_WAIT = "Wait for the chapter images (while the chunks synthesize)"
CHAPTER_LATE_WAIT = "Wait for the chapter images (second chance)"
CHAPTER_CHECK = "Check the chapter image configuration"
CHAPTER_MUSIC_CHECK = "Check the chapter music ranges"
REFLECTION_EARLY_WAIT = "Wait for the reflection images (while the chunks synthesize)"
REFLECTION_LATE_WAIT = "Wait for the reflection images (second chance)"
QA_SETUP_STEPS = ("Check out whisper.cpp for the final QA",
                  "Get whisper.cpp HEAD SHA",
                  "Restore the whisper.cpp build")
WARM_STEP = "Warm the Chatterbox weights cache"
SAVE_STEP = "Save the Chatterbox weights cache"


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
        if len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line)
    prefix = min(len(b) - len(b.lstrip()) for b in body if b.strip())
    return "\n".join(b[prefix:] if b.strip() else "" for b in body)


def if_expr(block):
    """Return the raw if: expression of a step block."""
    m = re.search(r"^\s*if:\s*(.+)$", block, re.M)
    assert m, "step has no if:"
    return m.group(1).strip()


def eval_upload_if(expr, video_outcome, fallback_status):
    """Evaluate the upload if: for given step outcomes (tiny ||/&& evaluator)."""
    m = re.search(r"\$\{\{\s*(.+?)\s*\}\}", expr, re.S)
    inner = m.group(1) if m else expr
    inner = inner.replace("steps.video.outcome == 'success'", str(video_outcome == "success"))
    inner = inner.replace("steps.fallback.outputs.status == 'restored'",
                          str(fallback_status == "restored"))
    inner = inner.replace("steps.fallback.outputs.status == 'miss'",
                          str(fallback_status == "miss"))
    inner = inner.replace("||", " or ").replace("&&", " and ")
    assert "steps." not in inner, f"unsupported refs left in {inner!r}"
    return eval(inner, {"__builtins__": {}}, {"True": True, "False": False})  # noqa: S307


def run_shell(script, cwd, env_vals, stubs=("python", "aws")):
    """Run a body with stubbed tools; return (proc, argv_calls, summary_text)."""
    script = script.replace("${{ steps.qa.outcome }}", "${QA_OUTCOME:-skipped}")
    script = script.replace("${{ steps.youtube.outcome }}", "${YOUTUBE_OUTCOME:-skipped}")
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "step.sh"
        f.write_text(script + "\n")
        subprocess.run(["bash", "-n", str(f)], check=True, timeout=30)
        bindir = Path(tmp) / "bin"
        bindir.mkdir()
        log = Path(tmp) / "argv.jsonl"
        log.touch()
        for name in stubs:
            p = bindir / name
            if name == "python":
                # JSON argv record keeps hostile values as ONE element; only an
                # upload call honours FAKE_UPLOAD_RC, nothing else is affected.
                stub_text = (
                    "#!/bin/sh\n"
                    'python3 -c \'import json,sys; print(json.dumps(sys.argv[1:]))\' "$@" >> "' + str(log) + '"\n'
                    'case "$*" in *verify_final*)\n'
                    '  echo QA-TABLE > "out/${BASE}.qa.md"\n'
                    '  exit "${FAKE_VERIFY_RC:-0}";;\n'
                    "esac\n"
                    'case "$*" in *video_fallback.py*upload*|*upload*video_fallback.py*)\n'
                    '  if [ -n "${FAKE_SUMMARY_MARKER:-}" ]; then\n'
                    '    printf \'%s\\n\' "$FAKE_SUMMARY_MARKER" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"\n'
                    "  fi\n"
                    '  exit "${FAKE_UPLOAD_RC:-0}";;\n'
                    "esac\n"
                    "exit 0\n"
                )
                p.write_text(stub_text)
            else:
                p.write_text("#!/bin/sh\nexit 0\n")
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
        out = Path(tmp) / "out.txt"
        out.touch()
        env = dict(os.environ)
        env.update(env_vals)
        env["PATH"] = str(bindir) + os.pathsep + env.get("PATH", "")
        env["GITHUB_OUTPUT"] = str(out)
        env["GITHUB_STEP_SUMMARY"] = str(Path(tmp) / "summary.md")
        Path(env["GITHUB_STEP_SUMMARY"]).touch()
        proc = subprocess.run(["bash", "-e", str(f)], cwd=cwd, env=env,
                              capture_output=True, text=True, timeout=60)
        calls = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
        return proc, calls, Path(env["GITHUB_STEP_SUMMARY"]).read_text()


def make_sec10v(tmp):
    """Create a sec10v working dir with chapter manifest and helper marker."""
    work = Path(tmp) / "sec10v"
    (work / "out" / "seo").mkdir(parents=True)
    (work / "out" / "pics").mkdir(parents=True)
    (work / "scripts").mkdir(parents=True)
    (work / "scripts" / HELPER.split("/", 1)[1]).write_text("x")
    (work / "out" / "chapter.json").write_text('{"base_name": "B"}')
    (work / "out" / "run_ids.json").write_text("[]")
    return work


def upload_calls(calls):
    """Return argv lists that invoked the upload wrapper."""
    return [c for c in calls if HELPER in c and "upload" in c]


class FallbackCommonTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chapter_text = CHAPTER.read_text()
        cls.reflection_text = REFLECTION.read_text()
        cls.chapter = parse_steps(cls.chapter_text)
        cls.reflection = parse_steps(cls.reflection_text)

    def test_restore_step_present_after_transcript(self):
        for text, blocks in ((self.chapter_text, self.chapter), (self.reflection_text, self.reflection)):
            self.assertIn(RESTORE_NAME, blocks)
            body = run_body(blocks[RESTORE_NAME])
            self.assertIn("id: fallback", blocks[RESTORE_NAME])
            self.assertIn(HELPER, body)
            self.assertIn("restore", body)
            self.assertIn(AWS_CHECK, body)
            self.assertIn(BUCKET_KEY, blocks[RESTORE_NAME])
            self.assertNotIn("continue-on-error", blocks[RESTORE_NAME])
            self.assertLess(text.index("Write the YouTube transcript"), text.index(RESTORE_NAME))

    def test_restore_before_expensive_work(self):
        # Step order, not raw text (headers mention script names too).
        chapter_order = list(self.chapter.keys())
        reflection_order = list(self.reflection.keys())
        chapter_expensive = ["Reuse audio from a previous run of this chapter",
                             "Decide what still needs doing", "Build the final video"]
        for name in chapter_expensive:
            self.assertLess(chapter_order.index(RESTORE_NAME), chapter_order.index(name), name)
        reflection_expensive = ["Dispatch one sec10v.yml run per chunk",
                                "Collect MP3s, retry stragglers", "Build the final video"]
        for name in reflection_expensive:
            self.assertLess(reflection_order.index(RESTORE_NAME), reflection_order.index(name), name)

    def test_expensive_steps_gated_on_miss(self):
        chapter_gated = ["Reuse audio from a previous run of this chapter",
                         "Decide what still needs doing",
                         "Install ffmpeg", CHAPTER_CHECK, CHAPTER_MUSIC_CHECK,
                         "Restore the Chatterbox weights cache",
                         WARM_STEP, SAVE_STEP,
                         "Dispatch one sec10v.yml run per chunk",
                         CHAPTER_EARLY_WAIT,
                         "Collect MP3s, retry stragglers", CHAPTER_LATE_WAIT,
                         "Build the final video"]
        for name in chapter_gated:
            with self.subTest(workflow="chapter", step=name):
                self.assertIn(FALLBACK_GUARD, self.chapter[name], name)
                self.assertNotIn("!= 'miss'", self.chapter[name], name)
        reflection_gated = ["Install ffmpeg", "Check the image configuration from your file",
                            "Restore the Chatterbox weights cache", WARM_STEP, SAVE_STEP,
                            "Dispatch one sec10v.yml run per chunk",
                            REFLECTION_EARLY_WAIT,
                            "Collect MP3s, retry stragglers", REFLECTION_LATE_WAIT,
                            "Build the final video"]
        for name in reflection_gated:
            with self.subTest(workflow="reflection", step=name):
                self.assertIn(FALLBACK_GUARD, self.reflection[name], name)
                self.assertNotIn("!= 'miss'", self.reflection[name], name)
        # Build keeps parenthesised OR of image flags.
        for blocks in (self.chapter, self.reflection):
            b = blocks["Build the final video"]
            self.assertIn(FALLBACK_GUARD, b)
            self.assertIn("steps.image.outputs.found == 'true'", b)
            self.assertIn("steps.image_retry.outputs.found == 'true'", b)
        # Second waits keep original gate plus miss.
        self.assertIn("steps.image.outputs.found != 'true'", self.chapter[CHAPTER_LATE_WAIT])
        self.assertIn("steps.image.outputs.found != 'true'", self.reflection[REFLECTION_LATE_WAIT])
        # Polling args retained.
        self.assertIn(POLL_ARG, self.chapter_text)
        self.assertIn(POLL_ARG, self.reflection_text)

    def test_qa_setup_guarded_by_new_video_only(self):
        for blocks in (self.chapter, self.reflection):
            for name in QA_SETUP_STEPS:
                with self.subTest(step=name):
                    self.assertIn(VIDEO_OK, blocks[name])
                    self.assertNotIn(FALLBACK_GUARD, blocks[name])
                    self.assertNotIn(RESTORED_GUARD, blocks[name])

    def test_no_early_storage_writes(self):
        for text, blocks in ((self.chapter_text, self.chapter), (self.reflection_text, self.reflection)):
            for name, block in blocks.items():
                if name in (RESTORE_NAME, UPLOAD_NAME):
                    continue
                self.assertNotIn(BUCKET_KEY, block, name)
                if "run: |" in block:
                    self.assertNotIn("video_fallback.py", run_body(block), name)

    def test_upload_wraps_helper_and_fails_visibly(self):
        for blocks in (self.chapter, self.reflection):
            block = blocks[UPLOAD_NAME]
            body = run_body(block)
            expr = if_expr(block)
            self.assertIn(VIDEO_OK, expr)
            self.assertIn(RESTORED_GUARD, expr)
            self.assertNotIn("uploaded", expr)
            self.assertIn("||", expr)
            self.assertIn("video_fallback.py", body)
            self.assertIn("upload", body)
            self.assertIn("--video", body)
            self.assertIn("--seo", body)
            self.assertIn("--fallback-title", body)
            self.assertIn("--out-dir out", body)
            self.assertIn(AWS_CHECK, body)
            self.assertIn(BUCKET_KEY, block)
            self.assertNotIn("continue-on-error", block)
            self.assertNotIn("youtube_upload.py", body)
            self.assertNotIn("|| true", body)
            # Enabled on built or restored, never on receipt/empty with skipped video.
            self.assertTrue(eval_upload_if(expr, "success", "miss"))
            self.assertTrue(eval_upload_if(expr, "skipped", "restored"))
            self.assertFalse(eval_upload_if(expr, "skipped", "uploaded"))
            self.assertFalse(eval_upload_if(expr, "skipped", "miss"))
            self.assertFalse(eval_upload_if(expr, "skipped", ""))
        # Thumbnail preserved: both workflows forward the dedicated thumbnail.
        self.assertIn("--thumbnail", run_body(self.reflection[UPLOAD_NAME]))
        self.assertIn("--thumbnail", run_body(self.chapter[UPLOAD_NAME]))

    def test_upload_failure_propagates_and_forwards(self):
        book = 'Evil Book"; $(touch pwned); echo "x'
        title = "Ch 1; `id` $HOME"
        for blocks, want_thumb in ((self.chapter, True), (self.reflection, True)):
            body = run_body(blocks[UPLOAD_NAME])
            for rc in (1, 10):
                with tempfile.TemporaryDirectory() as tmp, self.subTest(rc=rc, thumb=want_thumb):
                    work = make_sec10v(tmp)
                    (work / "out" / "B.final.mp4").write_bytes(b"v" * 16)
                    (work / "out" / "seo" / "B.seo.md").write_text("seo")
                    (work / "out" / "pics" / "B.thumb.jpg").write_bytes(b"t" * 16)
                    proc, calls, summary = run_shell(
                        body, work,
                        {"BASE": "B", "BOOK_TITLE": book, "CHAPTER_TITLE": title,
                         "PYTHONPATH": "scripts", "FAKE_UPLOAD_RC": str(rc),
                         "FAKE_SUMMARY_MARKER": "UPLOAD-FAILED-MARKER"})
                    self.assertEqual(rc, proc.returncode, proc.stderr)
                    self.assertIn("UPLOAD-FAILED-MARKER", summary)
                    ups = upload_calls(calls)
                    self.assertEqual(1, len(ups), calls)
                    argv = ups[0]
                    self.assertIn("out/B.final.mp4", argv)
                    self.assertIn("out/seo/B.seo.md", argv)
                    self.assertIn("--out-dir", argv)
                    self.assertEqual("out", argv[argv.index("--out-dir") + 1])
                    titles = [a for a in argv if "Evil Book" in a]
                    self.assertEqual(1, len(titles), argv)
                    self.assertIn(title, titles[0])
                    self.assertEqual(want_thumb, "--thumbnail" in argv)
                    if want_thumb:
                        self.assertIn("out/pics/B.thumb.jpg", argv)
                    self.assertFalse((work / "pwned").exists())
            with tempfile.TemporaryDirectory() as tmp, self.subTest(rc=0, thumb=want_thumb):
                work = make_sec10v(tmp)
                (work / "out" / "B.final.mp4").write_bytes(b"v" * 16)
                (work / "out" / "seo" / "B.seo.md").write_text("seo")
                (work / "out" / "pics" / "B.thumb.jpg").write_bytes(b"t" * 16)
                proc, calls, _ = run_shell(
                    body, work,
                    {"BASE": "B", "BOOK_TITLE": book, "CHAPTER_TITLE": title,
                     "PYTHONPATH": "scripts", "FAKE_UPLOAD_RC": "0"})
                self.assertEqual(0, proc.returncode, proc.stderr)
                self.assertEqual(1, len(upload_calls(calls)), calls)

    def test_qa_saved_and_restored(self):
        for blocks in (self.chapter, self.reflection):
            body = run_body(blocks[VERIFY_NAME])
            self.assertIn(QA_FILE, body)
            self.assertIn('>> "$GITHUB_STEP_SUMMARY"', body)
            self.assertIn('exit "$rc"', body)
            self.assertIn("continue-on-error", blocks[VERIFY_NAME])
            rblock = blocks[QA_RESTORE_NAME]
            self.assertIn(RESTORED_GUARD, rblock)
            rbody = run_body(rblock)
            self.assertIn(QA_FILE, rbody)
            self.assertIn('>> "$GITHUB_STEP_SUMMARY"', rbody)
            self.assertNotIn("ffprobe", rbody)
            self.assertNotIn("whisper", rbody.lower())
        # Failing QA still appends then exits nonzero.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v(tmp)
            body = run_body(self.chapter[VERIFY_NAME])
            body = body.replace("${{ github.workspace }}/whisper.cpp/build/bin/whisper-cli", "/tmp/x")
            body = body.replace("${{ github.workspace }}/whisper.cpp/models/ggml-small.en.bin", "/tmp/y")
            proc, _, summary = run_shell(body, work, {"BASE": "B", "PYTHONPATH": "scripts", "FAKE_VERIFY_RC": "10"})
            self.assertNotEqual(0, proc.returncode)
            self.assertIn("QA-TABLE", summary)

    def test_report_and_transcript_branches(self):
        for blocks in (self.chapter, self.reflection):
            report = next(v for k, v in blocks.items() if k.startswith("Report "))
            self.assertIn("FALLBACK_STATUS", report)
            rbody = run_body(report)
            self.assertIn('"restored"', rbody)
            self.assertIn('"uploaded"', rbody)
            self.assertIn("no synthesis", rbody)
            self.assertIn("already uploaded", rbody)
            tbody = run_body(blocks[TRANSCRIPT_NAME])
            self.assertIn("always()", blocks[TRANSCRIPT_NAME])
            self.assertIn("FALLBACK_STATUS", blocks[TRANSCRIPT_NAME])
            self.assertIn('"uploaded"', tbody)
        # Restored report does not claim missing images/chunks.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v(tmp)
            (work / "out" / "chapter.json").write_text('{"base_name": "B", "images": []}')
            for blocks in (self.chapter, self.reflection):
                report = next(v for k, v in blocks.items() if k.startswith("Report "))
                proc, _, _ = run_shell(run_body(report), work,
                                       {"BASE": "B", "FALLBACK_STATUS": "restored",
                                        "IMAGE_AVAILABLE": "false", "IMAGE_FOUND": "false",
                                        "IMAGE_RETRY_FOUND": "false", "YOUTUBE_OUTCOME": "success"})
                self.assertEqual(0, proc.returncode)
                self.assertNotIn("missing", proc.stdout)
                self.assertNotIn("still pending", proc.stdout)

    def test_fresh_inputs_and_force(self):
        self.assertIn("fresh:", self.reflection_text)
        fresh = re.search(r"fresh:\n(?:.*\n){0,6}.*default: false", self.reflection_text)
        self.assertIsNotNone(fresh, "reflection fresh input must default to false")
        self.assertIn("--force", run_body(self.chapter[RESTORE_NAME]))
        self.assertIn("--force", run_body(self.reflection[RESTORE_NAME]))
        self.assertIn('"$FRESH" = "true"', run_body(self.chapter[RESTORE_NAME]))
        self.assertIn("saved failed-upload", self.chapter_text)
        self.assertIn("saved failed-upload", self.reflection_text)

    def test_restore_quoting_and_kinds(self):
        crbody = run_body(self.chapter[RESTORE_NAME])
        self.assertIn("--kind chapter", crbody)
        self.assertIn('--source-id "$FILE"', crbody)
        self.assertIn('--source-file "$GITHUB_WORKSPACE/$FILE"', crbody)
        self.assertNotIn("--image-ref", crbody)
        self.assertNotIn("${{", crbody)
        rrbody = run_body(self.reflection[RESTORE_NAME])
        self.assertIn("--kind reflection", rrbody)
        self.assertIn('--source-id "$FILE"', rrbody)
        self.assertIn('"$GITHUB_WORKSPACE/$FILE"', rrbody)
        self.assertIn("sec10v_reflection.yml", rrbody)
        self.assertNotIn("${{", rrbody)
        # Hostile chapter paths pass through quoted env without execution or loss.
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v(tmp)
            evil = 'x"; $(touch pwned); echo "y'
            proc, calls, _ = run_shell(crbody, work,
                                       {"FILE": evil, "FRESH": "false",
                                        "GITHUB_WORKSPACE": str(Path(tmp)), "PYTHONPATH": "scripts"})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertFalse((work / "pwned").exists())
            restores = [c for c in calls if HELPER in c and "restore" in c]
            self.assertEqual(1, len(restores), calls)
            argv = restores[0]
            self.assertIn(evil, argv)
            self.assertEqual(str(Path(tmp) / evil), argv[argv.index("--source-file") + 1])
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v(tmp)
            evil = 'x"; $(touch pwned); echo "y'
            proc, calls, _ = run_shell(rrbody, work,
                                       {"FILE": evil, "FRESH": "true",
                                        "GITHUB_WORKSPACE": str(Path(tmp)), "PYTHONPATH": "scripts"})
            self.assertEqual(0, proc.returncode, proc.stderr)
            flat = [a for c in calls for a in c]
            self.assertIn("--force", flat)
            self.assertIn(evil, flat)

    def test_concurrency(self):
        chapter_doc = yaml.safe_load(self.chapter_text)
        group = chapter_doc["jobs"]["chapter"]["concurrency"]["group"]
        self.assertEqual("${{ github.workflow }}-${{ matrix.file }}", group)
        self.assertIs(chapter_doc["jobs"]["chapter"]["concurrency"]["cancel-in-progress"], False)
        reflection_doc = yaml.safe_load(self.reflection_text)
        rgroup = reflection_doc["jobs"]["reflection"]["concurrency"]["group"]
        self.assertIn("matrix.file", rgroup)
        self.assertIs(reflection_doc["jobs"]["reflection"]["concurrency"]["cancel-in-progress"], False)

    def test_quota_claim_updated(self):
        self.assertNotIn("1600", self.chapter_text)
        self.assertNotIn("~6 chapters/day", self.chapter_text)
        self.assertIn("100", self.chapter_text)


if __name__ == "__main__":
    unittest.main()
