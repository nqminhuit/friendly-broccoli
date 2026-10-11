"""Check sec10v_chapter.yml builds Gemini requests from native skill paths."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows" / "sec10v_chapter.yml"
STEP_NAME = "Generate image prompt and SEO with Gemini"

SEO_ID = "audiobook-youtube-seo"
IMAGE_ID = "image-prompt-generator"


def extract_request_python(text):
    """Return the request-building Python heredoc of the creative step."""
    idx = text.index(STEP_NAME)
    start_marker = "python - <<'PY'"
    start = text.index(start_marker, idx) + len(start_marker)
    lines = text[start:].splitlines()
    body = []
    for line in lines[1:]:
        if line.strip() == "PY":
            break
        body.append(line)
    else:
        raise AssertionError("unterminated PY heredoc")
    script = textwrap.dedent("\n".join(body))
    assert "gemini-request" in script, "wrong heredoc extracted"
    return script


def run_request_script(script, image_available):
    """Run the heredoc with temp fixtures; return parsed request JSONs."""
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "out" / "text").mkdir(parents=True)
        (work / ".opencode" / "skills" / SEO_ID).mkdir(parents=True)
        (work / ".opencode" / "skills" / IMAGE_ID).mkdir(parents=True)
        (work / ".opencode" / "skills" / SEO_ID / "SKILL.md").write_text("SEO-SKILL-BODY")
        (work / ".opencode" / "skills" / IMAGE_ID / "SKILL.md").write_text("IMAGE-SKILL-BODY")
        (work / "out" / "text" / "Book.01.txt").write_text("Once upon a chapter body.")
        script_file = work / "request.py"
        script_file.write_text(script)
        compile(script, str(script_file), "exec")
        env = dict(os.environ)
        env.update({
            "BASE": "Book.01",
            "BOOK_TITLE": "Test Book",
            "CHAPTER_TITLE": "Chapter 1",
            "AUTHOR": "Test Author",
            "IMAGE_AVAILABLE": image_available,
        })
        subprocess.run([sys.executable, str(script_file)], check=True, cwd=work, env=env, timeout=30)
        out = {}
        for name in ("primary", "fallback"):
            out[name] = json.loads((work / f"gemini-request.{name}.json").read_text())
        return out


class ChapterSkillsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.script = extract_request_python(cls.text)

    def test_no_legacy_skill_paths(self):
        self.assertNotIn(".github/skills", self.text)
        self.assertIn(f".opencode/skills/{SEO_ID}/SKILL.md", self.script)
        self.assertIn(f".opencode/skills/{IMAGE_ID}/SKILL.md", self.script)

    def test_seo_only_branch(self):
        reqs = run_request_script(self.script, "true")
        body = reqs["primary"]["contents"][0]["parts"][0]["text"]
        for want in ("SEO-SKILL-BODY", "Test Book", "Chapter 1", "Test Author",
                     "Book.01", "Once upon a chapter body."):
            self.assertIn(want, body)
        self.assertNotIn("IMAGE-SKILL-BODY", body)
        schema = reqs["fallback"]["generationConfig"]["responseSchema"]
        self.assertEqual(["seo_markdown"], schema["required"])
        self.assertNotIn("image_prompt", schema["properties"])

    def test_seo_plus_image_branch(self):
        reqs = run_request_script(self.script, "false")
        body = reqs["primary"]["contents"][0]["parts"][0]["text"]
        for want in ("SEO-SKILL-BODY", "IMAGE-SKILL-BODY", "Test Book",
                     "Chapter 1", "Test Author", "Book.01"):
            self.assertIn(want, body)
        schema = reqs["fallback"]["generationConfig"]["responseSchema"]
        self.assertEqual(["seo_markdown", "image_prompt"], schema["required"])
        self.assertIn("image_prompt", schema["properties"])


if __name__ == "__main__":
    unittest.main()
