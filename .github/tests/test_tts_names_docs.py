"""Check the tts_names docs: the README key block and the write-reflection skill checks."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "reflections" / "README.md"
SKILL = ROOT / ".opencode" / "skills" / "write-reflection" / "SKILL.md"
KEY = "tts_names"
KEY_BLOCK = "tts_names: |"
EXCLUSIONS = ("ALL-CAPS", "acronyms", "initialisms")


def numbered_step(text, n):
    start = re.search(rf"^{n}\. ", text, re.M)
    end = re.search(rf"^{n + 1}\. ", text, re.M)
    assert start, f"step {n} missing"
    return text[start.start():end.start() if end else len(text)]


class TtsNamesDocsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.readme = README.read_text()
        cls.skill = SKILL.read_text()

    def test_readme_documents_optional_block_and_exclusions(self):
        self.assertIn(KEY_BLOCK, self.readme)
        for word in EXCLUSIONS:
            self.assertIn(word, self.readme)

    def test_skill_populates_and_checks_names(self):
        self.assertIn(KEY, numbered_step(self.skill, 4))
        self.assertIn("Identify eligible", numbered_step(self.skill, 4))
        self.assertIn("block is missing", numbered_step(self.skill, 6))
        self.assertIn(KEY, numbered_step(self.skill, 6))
        self.assertIn("eligible names", numbered_step(self.skill, 8))
        self.assertIn(KEY, numbered_step(self.skill, 8))
        for word in EXCLUSIONS:
            self.assertIn(word, numbered_step(self.skill, 4))


if __name__ == "__main__":
    unittest.main()
