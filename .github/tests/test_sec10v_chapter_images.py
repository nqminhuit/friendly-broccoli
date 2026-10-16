"""Check sec10v_chapter.yml validates the chapter manifest and reads images from the S3 bucket."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_sec10v_reflection_images import (  # noqa: E402
    FOUND_FALSE, FOUND_TRUE, SCRIPT_NAME, SECRET_TOKEN, BUCKET_HOST, POLL_ARG, BASE_URL_FLAG,
    parse_steps, run_body, run_shell, downloader_argv, make_sec10v_work, chapter_doc, SEC1, SEC2,
    BASE, EARLY_ENV, LATE_ENV, CONFIG_ENV, BUCKET_KEYS,
)

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "sec10v_chapter.yml"
REFLECTION = Path(__file__).resolve().parents[1] / "workflows" / "sec10v_reflection.yml"
CHECK_NAME = "Check the chapter image configuration"
EARLY_NAME = "Wait for the chapter images (while the chunks synthesize)"
LATE_NAME = "Wait for the chapter images (second chance)"
BUILD_NAME = "Build the final video"
REPORT_NAME = "Report chunk, image and video status"
DISPATCH_NAME = "Dispatch one sec10v.yml run per chunk"
EARLY_TIMEOUT = "1200"
LATE_TIMEOUT = "3600"
GOOD_BUCKET = "my-chapters"
CHAPTER_BUCKET = "secrets.CHAPTER_IMAGE_BUCKET"
CHAPTER_PREFIX = "secrets.CHAPTER_IMAGE_PREFIX"
BUILD_GATE = "steps.image.outputs.found == 'true' || steps.image_retry.outputs.found == 'true'"

GOOD_DOC = chapter_doc(SEC1, SEC2, thumbnail="book-thumb.jpg")


class ChapterImagesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.blocks = parse_steps(cls.text)
        cls.shells = {k: run_body(v) for k, v in cls.blocks.items() if "run: |" in v}

    def test_no_image_base_url_anywhere(self):
        for path in (WORKFLOW, REFLECTION):
            self.assertNotIn("IMAGE_BASE_URL", path.read_text(), path.name)

    def test_steps_map_chapter_secrets_to_script_env(self):
        for name in (CHECK_NAME, EARLY_NAME, LATE_NAME):
            block = self.blocks[name]
            self.assertIn(f"IMAGE_BUCKET: ${{{{ {CHAPTER_BUCKET} }}}}", block)
            self.assertIn(f"IMAGE_PREFIX: ${{{{ {CHAPTER_PREFIX} }}}}", block)
            for key in BUCKET_KEYS:
                self.assertIn(f"{key}: ${{{{ secrets.{key} }}}}", block)
            self.assertNotIn("${{", self.shells[name])
        self.assertIn("PYTHONPATH: scripts", self.blocks[CHECK_NAME])
        # The chapter workflow must not read the reflection bucket.
        self.assertNotIn("REFLECTION_IMAGE_BUCKET", self.text)

    def test_check_lists_multi_image_and_thumbnail(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, GOOD_DOC)
            proc, _, _ = run_shell(self.shells[CHECK_NAME], work, {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET})
            self.assertEqual(0, proc.returncode, proc.stderr)
            for want in ("sec-1", "sec-2", "book-thumb.jpg", "2 image(s)"):
                self.assertIn(want, proc.stdout)

    def test_check_rejects_bad_manifests(self):
        bad = [
            chapter_doc(),                                             # no images
            chapter_doc(SEC1),                                         # no dedicated thumbnail
            json.dumps({"base_name": BASE, "images": [SEC1], "thumbnail": ""}),
            json.dumps({"base_name": BASE, "images": [SEC1], "thumbnail": 42}),
            json.dumps({"base_name": BASE, "images": [SEC1], "thumbnail": SEC1["ref"]}),  # reused ref
            json.dumps({"base_name": "", "images": [SEC1], "thumbnail": "t.jpg"}),
            json.dumps({"base_name": BASE, "images": [{"name": "s", "ref": "", "chunks": [1]}],
                        "thumbnail": "t.jpg"}),
            json.dumps({"base_name": BASE, "images": [{"name": "s", "ref": "a.jpg", "chunks": []}],
                        "thumbnail": "t.jpg"}),
            json.dumps({"base_name": BASE, "images": [{"name": "s", "ref": "a.jpg", "chunks": ["1"]}],
                        "thumbnail": "t.jpg"}),
            json.dumps({"base_name": BASE, "images": [{"name": "s", "ref": "https://x/a.jpg", "chunks": [1]}],
                        "thumbnail": "t.jpg"}),
            json.dumps({"base_name": BASE, "images": [{"name": "s", "ref": "../a.jpg", "chunks": [1]}],
                        "thumbnail": "t.jpg"}),
            json.dumps({"base_name": BASE, "images": [{"name": "s", "ref": "/a.jpg", "chunks": [1]}],
                        "thumbnail": "t.jpg"}),
        ]
        for chapter in bad:
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, chapter)
                proc, _, _ = run_shell(self.shells[CHECK_NAME], work,
                                       {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET})
                self.assertNotEqual(0, proc.returncode, chapter)

    def test_check_rejects_bad_manifest_file(self):
        for manifest in ('[]', '{"chunk": 1}', '"x"', '{}'):
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, GOOD_DOC, manifest=manifest)
                proc, _, _ = run_shell(self.shells[CHECK_NAME], work,
                                       {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET})
                self.assertNotEqual(0, proc.returncode, manifest)

    def test_check_rejects_missing_bucket_and_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, GOOD_DOC)
            proc, _, _ = run_shell(self.shells[CHECK_NAME], work, {**CONFIG_ENV, "IMAGE_BUCKET": ""})
            self.assertNotEqual(0, proc.returncode)
        for missing in ((BUCKET_KEYS[0],), BUCKET_KEYS[1:]):
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, GOOD_DOC)
                env = {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET, **{k: "" for k in missing}}
                proc, _, _ = run_shell(self.shells[CHECK_NAME], work, env)
                self.assertNotEqual(0, proc.returncode)
                for key in BUCKET_KEYS:
                    self.assertEqual(key in missing, key in proc.stdout, key)

    def test_check_rejects_bad_bucket_without_leaking(self):
        for bad_bucket in ("s3://x", "a/b", f"https://{BUCKET_HOST}/pic?token={SECRET_TOKEN}"):
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, GOOD_DOC)
                proc, _, _ = run_shell(self.shells[CHECK_NAME], work,
                                       {**CONFIG_ENV, "IMAGE_BUCKET": bad_bucket})
                self.assertNotEqual(0, proc.returncode, bad_bucket)
                self.assertNotIn(SECRET_TOKEN, proc.stdout + proc.stderr)
                self.assertNotIn(BUCKET_HOST, proc.stdout + proc.stderr)
                self.assertNotIn(bad_bucket, proc.stdout + proc.stderr)

    def test_check_rejects_evil_ref_without_leaking(self):
        evil = json.dumps({
            "base_name": BASE,
            "images": [{"name": "sec-1", "ref": f"https://{BUCKET_HOST}/x/a.jpg?token={SECRET_TOKEN}",
                        "chunks": [1]}],
            "thumbnail": "t.jpg",
        })
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, evil)
            proc, _, _ = run_shell(self.shells[CHECK_NAME], work,
                                   {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET})
            self.assertNotEqual(0, proc.returncode)
            self.assertNotIn(SECRET_TOKEN, proc.stdout + proc.stderr)
            self.assertNotIn(BUCKET_HOST, proc.stdout + proc.stderr)

    def test_waits_use_reflection_images_without_a_url(self):
        for name in (EARLY_NAME, LATE_NAME):
            body = self.shells[name]
            self.assertIn(SCRIPT_NAME, body)
            self.assertIn(POLL_ARG, body)
            self.assertNotIn(BASE_URL_FLAG, body)
            self.assertNotIn("--url", body)
            self.assertNotIn("${{", body)
        self.assertIn("IMAGE_EARLY_WAIT_MINUTES", self.shells[EARLY_NAME])
        self.assertIn("IMAGE_WAIT_MINUTES", self.shells[LATE_NAME])
        self.assertIn("timeout-minutes: 60", self.blocks[EARLY_NAME])
        self.assertIn("timeout-minutes: 180", self.blocks[LATE_NAME])

    def test_early_wait_rcs_and_skip(self):
        env = {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET, EARLY_ENV: "20"}
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, GOOD_DOC)
            proc, out, argv = run_shell(self.shells[EARLY_NAME], work, env, fake_rc=0)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(FOUND_TRUE, out)
            self.assertTrue(downloader_argv(argv, EARLY_TIMEOUT), argv)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, GOOD_DOC)
            proc, out, argv = run_shell(self.shells[EARLY_NAME], work, env, fake_rc=10)
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(FOUND_FALSE, out)
            self.assertIn("second chance", proc.stdout)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, GOOD_DOC)
            proc, _, _ = run_shell(self.shells[EARLY_NAME], work, env, fake_rc=1)
            self.assertNotEqual(0, proc.returncode)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, GOOD_DOC)
            proc, out, argv = run_shell(self.shells[EARLY_NAME], work,
                                        {**CONFIG_ENV, "IMAGE_BUCKET": "", EARLY_ENV: "20"}, fake_rc=0)
            self.assertEqual(0, proc.returncode)
            self.assertIn(FOUND_FALSE, out)
            self.assertFalse(any(SCRIPT_NAME in a for a in argv))
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, GOOD_DOC)
            proc, out, argv = run_shell(self.shells[EARLY_NAME], work,
                                        {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET, EARLY_ENV: "0"}, fake_rc=0)
            self.assertEqual(0, proc.returncode)
            self.assertIn(FOUND_FALSE, out)
            self.assertFalse(any(SCRIPT_NAME in a for a in argv))

    def test_late_wait_rcs(self):
        env = {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET, LATE_ENV: "60"}
        for fake_rc, found in ((0, FOUND_TRUE), (10, FOUND_FALSE)):
            with tempfile.TemporaryDirectory() as tmp:
                work = make_sec10v_work(tmp, GOOD_DOC)
                proc, out, argv = run_shell(self.shells[LATE_NAME], work, env, fake_rc=fake_rc)
                self.assertEqual(0, proc.returncode, proc.stderr)
                self.assertIn(found, out)
                self.assertTrue(downloader_argv(argv, LATE_TIMEOUT), argv)
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, GOOD_DOC)
            proc, _, _ = run_shell(self.shells[LATE_NAME], work, env, fake_rc=2)
            self.assertNotEqual(0, proc.returncode)

    def test_late_wait_skips_after_early_success(self):
        self.assertIn("steps.image.outputs.found != 'true'", self.blocks[LATE_NAME])

    def test_missing_thumbnail_means_no_build(self):
        # The build depends only on the image waits' found flags; reflection_images.py is what
        # decides those, and the manifest check already refuses a non-dedicated thumbnail.
        self.assertIn(BUILD_GATE, self.blocks[BUILD_NAME])
        self.assertNotIn("thumb", self.blocks[BUILD_NAME])
        self.assertNotIn(".jpg", self.blocks[BUILD_NAME])
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, json.dumps({"base_name": BASE, "images": [SEC1],
                                                     "thumbnail": SEC1["ref"]}))
            proc, _, _ = run_shell(self.shells[CHECK_NAME], work,
                                   {**CONFIG_ENV, "IMAGE_BUCKET": GOOD_BUCKET})
            self.assertNotEqual(0, proc.returncode, "a reused thumbnail must be refused")

    def test_report_names_the_manifest_image_not_the_cover(self):
        # <base>.jpg is the cover copy the collector writes from image 1, so it must not stand in
        # for that image: the report has to name the manifest's own img1 when only the cover exists.
        doc = chapter_doc({"name": f"{BASE}.img1", "ref": "one.jpg", "chunks": [1]},
                          {"name": f"{BASE}.img2", "ref": "two.jpg", "chunks": [2]},
                          thumbnail="book-thumb.jpg")
        with tempfile.TemporaryDirectory() as tmp:
            work = make_sec10v_work(tmp, doc,
                                    pics=[f"{BASE}.jpg", f"{BASE}.img2.jpg", f"{BASE}.thumb.jpg"])
            proc, _, _ = run_shell(run_body(self.blocks[REPORT_NAME]), work,
                                   {"FALLBACK_STATUS": "miss", "IMAGE_FOUND": "false",
                                    "IMAGE_RETRY_FOUND": "false"})
            self.assertEqual(0, proc.returncode, proc.stderr)
            self.assertIn(f"missing {BASE}.img1.jpg", proc.stdout)
            self.assertNotIn(f"{BASE}.img2.jpg", proc.stdout)
            self.assertNotIn("missing thumbnail", proc.stdout)
            self.assertIn("no video was built", proc.stdout)

    def test_ordering(self):
        order = [DISPATCH_NAME, EARLY_NAME, LATE_NAME, BUILD_NAME]
        idx = [self.text.index(n) for n in order]
        self.assertEqual(sorted(idx), idx)
        # The manifest check runs before anything is dispatched.
        self.assertLess(self.text.index(CHECK_NAME), self.text.index(DISPATCH_NAME))


if __name__ == "__main__":
    unittest.main()
