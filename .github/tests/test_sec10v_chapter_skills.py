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
SKILLS_DIR = Path(".opencode/skills")
TEXT_DIR = Path("out/text")

SEO_ID = "audiobook-youtube-seo"
IMAGE_ID = "image-prompt-generator"
SEO_CONTENT = "SEO-SKILL-BODY"
IMAGE_CONTENT = "IMAGE-SKILL-BODY"
BASE_NAME = "Book.01"
BOOK_TITLE = "Test Book"
CHAPTER_TITLE = "Chapter 1"
AUTHOR = "Test Author"
PRIMARY_REQUEST = "primary"
FALLBACK_REQUEST = "fallback"
IMAGE_PROMPT_KEY = "image_prompt"


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
        (work / TEXT_DIR).mkdir(parents=True)
        (work / SKILLS_DIR / SEO_ID).mkdir(parents=True)
        (work / SKILLS_DIR / IMAGE_ID).mkdir(parents=True)
        (work / SKILLS_DIR / SEO_ID / "SKILL.md").write_text(SEO_CONTENT)
        (work / SKILLS_DIR / IMAGE_ID / "SKILL.md").write_text(IMAGE_CONTENT)
        (work / TEXT_DIR / f"{BASE_NAME}.txt").write_text("Once upon a chapter body.")
        script_file = work / "request.py"
        script_file.write_text(script)
        compile(script, str(script_file), "exec")
        env = dict(os.environ)
        env.update({
            "BASE": BASE_NAME,
            "BOOK_TITLE": BOOK_TITLE,
            "CHAPTER_TITLE": CHAPTER_TITLE,
            "AUTHOR": AUTHOR,
            "IMAGE_AVAILABLE": image_available,
        })
        subprocess.run([sys.executable, str(script_file)], check=True, cwd=work, env=env, timeout=30)
        out = {}
        for name in (PRIMARY_REQUEST, FALLBACK_REQUEST):
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
        body = reqs[PRIMARY_REQUEST]["contents"][0]["parts"][0]["text"]
        for want in (SEO_CONTENT, BOOK_TITLE, CHAPTER_TITLE, AUTHOR,
                     BASE_NAME, "Once upon a chapter body."):
            self.assertIn(want, body)
        self.assertNotIn(IMAGE_CONTENT, body)
        schema = reqs[FALLBACK_REQUEST]["generationConfig"]["responseSchema"]
        self.assertEqual(["seo_markdown"], schema["required"])
        self.assertNotIn(IMAGE_PROMPT_KEY, schema["properties"])

    def test_seo_plus_image_branch(self):
        reqs = run_request_script(self.script, "false")
        body = reqs[PRIMARY_REQUEST]["contents"][0]["parts"][0]["text"]
        for want in (SEO_CONTENT, IMAGE_CONTENT, BOOK_TITLE,
                     CHAPTER_TITLE, AUTHOR, BASE_NAME):
            self.assertIn(want, body)
        schema = reqs[FALLBACK_REQUEST]["generationConfig"]["responseSchema"]
        self.assertEqual(["seo_markdown", IMAGE_PROMPT_KEY], schema["required"])
        self.assertIn(IMAGE_PROMPT_KEY, schema["properties"])


if __name__ == "__main__":
    unittest.main()
