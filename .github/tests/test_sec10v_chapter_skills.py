"""Check the chapter workflow is file-driven (no Gemini/URL) and the chapter docs and skill agree."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "sec10v_chapter.yml"
README = ROOT / "chapters" / "README.md"
AGENTS = ROOT / "chapters" / "AGENTS.md"
SKILL = ROOT / ".opencode" / "skills" / "prepare-chapter" / "SKILL.md"
SELECTOR = ROOT / ".github" / "scripts" / "select_chapter_files.py"

SKILL_NAME = "prepare-chapter"
INITIALLED_NAME = "G. K. Chesterton"
REPO_SCRIPT_PATH = ".opencode/skills/prepare-chapter/scripts/extract_chapter.py"
EXCLUSIONS = ("ALL-CAPS", "acronyms", "initialisms")


def headed(text, heading):
    """The lines under ``heading`` up to the next heading of the same or higher level."""
    lines = text.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines) if line.strip().startswith(heading)), None)
    assert start is not None, f"heading {heading!r} missing"
    level = len(lines[start]) - len(lines[start].lstrip("#"))
    out = []
    for line in lines[start + 1:]:
        if line.startswith("#") and len(line) - len(line.lstrip("#")) <= level:
            break
        out.append(line)
    return "".join(out)


class ChapterWorkflowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text()

    def test_no_gemini_or_url_dispatch_remnants(self):
        lowered = self.workflow.lower()
        for banned in ("gemini", "generativelanguage", "se_url", "image_url", "out/prompts",
                       "image-prompt-generator", "audiobook-youtube-seo", ".github/skills"):
            self.assertNotIn(banned, lowered, banned)
        self.assertNotIn("GEMINI_API_KEY", self.workflow)

    def test_file_driven_prepare_and_pipeline(self):
        for want in ("prepare_markdown_chapter.py", "MARKDOWN_CHAPTER_VERSION", "reflection_images.py",
                     "scripts/reuse_audio.py", "pending_chunks.py --rewrite", "video_fallback.py",
                     "trigger_workflow.py", "transcript.py", "automate_audiobook.py"):
            self.assertIn(want, self.workflow, want)
        self.assertIn("--script-file", self.workflow)
        self.assertIn("--kind chapter", self.workflow)
        self.assertIn("--segment-images out/segment-images.json", self.workflow)

    def test_push_trigger_is_chapter_markdown_only(self):
        section = self.workflow.split("workflow_dispatch:", 1)[0]
        self.assertIn("'chapters/**.md'", section)
        self.assertNotIn(".txt", section)
        self.assertIn("!chapters/README.md", section)
        self.assertIn("!chapters/**/AGENTS.md", section)
        self.assertIn("run-name: ${{ inputs.file || github.event.head_commit.message }}", self.workflow)

    def test_no_url_or_motion_dispatch_inputs(self):
        dispatch = self.workflow.split("workflow_dispatch:", 1)[1]
        for banned in ("se_url", "image_url", "chapter_title:", "motion:"):
            self.assertNotIn(banned, dispatch, banned)
        for want in ("file:", "voice:", "sec10v_ref:", "fresh:"):
            self.assertIn(want, dispatch, want)

    def test_event_commit_pinned_and_helper_used(self):
        self.assertEqual(2, self.workflow.count("ref: ${{ github.sha }}"))
        self.assertIn("select_chapter_files.py", self.workflow)
        self.assertNotIn("jq -R", self.workflow)


class ChapterDocsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.readme = README.read_text()
        cls.agents = AGENTS.read_text()
        cls.skill = SKILL.read_text()

    def test_readme_documents_required_format(self):
        for want in ("book", "author", "chapter", "title", "description", "thumbnail",
                     "source_url", "motion", "<name>-prompts.txt"):
            self.assertIn(want, self.readme, want)
        self.assertIn("no generated intro", self.readme)
        self.assertIn("not** narrated", self.readme)

    def test_readme_documents_naming_and_security(self):
        self.assertIn("Chapter.<CamelCase(FileName)>", self.readme)
        self.assertIn("the_blue_cross.md", self.readme)
        self.assertIn("collide", self.readme)
        self.assertIn("bucket-relative", self.readme)
        self.assertIn("no bucket/presigned URLs or credentials", self.readme)
        self.assertIn("never fetched", self.readme)
        self.assertIn("dedicated", self.readme)

    def test_readme_documents_motion_and_render_defaults(self):
        self.assertIn("motion: false", self.readme)
        self.assertIn("motion: true", self.readme)
        self.assertIn("5 fps", self.readme)
        self.assertIn("30 fps", self.readme)

    def test_agents_require_the_skill(self):
        self.assertIn(f"`{SKILL_NAME}` skill", self.agents)
        self.assertIn("chapters/README.md", self.agents)
        self.assertIn("Do not commit, push, dispatch or publish", self.agents)

    def test_skill_front_matter_and_scope(self):
        self.assertTrue(self.skill.startswith("---\n"))
        self.assertIn(f"name: {SKILL_NAME}", self.skill)
        self.assertIn("Not for reflections", self.skill)
        self.assertIn("../../../chapters/README.md", self.skill)
        self.assertIn("do not load or apply `write-reflection`", self.skill)

    def test_skill_source_authority_and_fidelity(self):
        for want in ("no abridgment", "never fetches", "invented", "only when explicitly requested",
                     "source_url"):
            self.assertIn(want, self.skill, want)
        self.assertIn("Do not commit, push, dispatch or publish", self.skill)

    def test_skill_documents_three_rounds(self):
        rounds = {n: headed(self.skill, f"### Round {n}") for n in (1, 2, 3)}
        for n, body in rounds.items():
            self.assertTrue(body.strip(), f"Round {n} empty")
        self.assertIn("narration", rounds[1])
        self.assertIn("no omissions", rounds[1])
        self.assertIn("image", rounds[2])
        self.assertIn("front matter", rounds[3])
        self.assertIn("programmatically", rounds[3])

    def test_readme_documents_three_rounds(self):
        for n in (1, 2, 3):
            with self.subTest(round=n):
                self.assertIn(f"## Round {n}", self.readme)
                self.assertTrue(headed(self.readme, f"## Round {n}").strip())
        self.assertIn("programmatically", headed(self.readme, "## Round 3"))

    def test_both_docs_require_scripted_extraction_not_model_retyping(self):
        for label, doc in (("README", self.readme), ("skill", self.skill)):
            with self.subTest(document=label):
                self.assertIn("never retyped by a model", doc)
                self.assertNotIn("never have a model read or transcribe", doc)

    def test_both_docs_require_the_bundled_script(self):
        for label, doc in (("README", self.readme), ("skill", self.skill)):
            with self.subTest(document=label):
                self.assertIn(REPO_SCRIPT_PATH, doc)
                self.assertIn("scripts/extract_chapter.py", doc)
                self.assertIn("--url", doc)
                self.assertIn("--output", doc)
                self.assertIn("mandatory", doc.lower())
        self.assertIn(f"python3 {REPO_SCRIPT_PATH}", self.readme)
        self.assertIn("python3 scripts/extract_chapter.py", self.skill)

    def test_tts_names_documented_with_dotted_initials(self):
        round3 = headed(self.skill, "### Round 3")
        names_section = headed(self.readme, "# tts_names")
        for label, text in (("README", names_section), ("skill", round3)):
            with self.subTest(document=label):
                self.assertIn("tts_names", text)
                self.assertIn(INITIALLED_NAME, text)
                self.assertIn("dotted initials", text)
                self.assertIn("at least one full word", text)
                self.assertIn("standalone initialisms", text)
                self.assertIn("bare initials", text)
                self.assertIn("matching `sec10v` support", text)


class SelectorTest(unittest.TestCase):
    def test_selector_writes_a_json_files_output(self):
        text = SELECTOR.read_text()
        self.assertIn('f"files={json.dumps(chosen)}', text)
        self.assertIn("Chapter.", text)
        self.assertIn("def check_collisions", text)
        self.assertNotIn("shell=True", text)

    def test_workflow_passes_inputs_through_env(self):
        text = WORKFLOW.read_text()
        run_start = text.index("python3 .github/scripts/select_chapter_files.py")
        body = text[run_start:text.index("chapter:", run_start)]
        self.assertIn('--file "$FILE"', body)
        self.assertIn('--output "$GITHUB_OUTPUT"', body)
        self.assertNotIn("${{", body)


if __name__ == "__main__":
    unittest.main()
