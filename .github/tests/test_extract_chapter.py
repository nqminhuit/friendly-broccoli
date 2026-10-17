"""Check the prepare-chapter XHTML extractor: source-preserving output, URL handling and CLI."""
import contextlib
import importlib.util
import io
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".opencode" / "skills" / "prepare-chapter" / "scripts" / "extract_chapter.py"

spec = importlib.util.spec_from_file_location("extract_chapter", SCRIPT)
extract_chapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract_chapter)

ChapterError = extract_chapter.ChapterError
resolve = extract_chapter.resolve_source_url
extract = extract_chapter.extract_narration

SE_BLOB = ("https://github.com/standardebooks/a-e-w-mason_the-house-of-the-arrow"
           "/blob/master/src/epub/text/chapter-1.xhtml")
SE_RAW = ("https://raw.githubusercontent.com/standardebooks/a-e-w-mason_the-house-of-the-arrow"
          "/master/src/epub/text/chapter-1.xhtml")


def build(body, section_attrs='id="chapter-1" epub:type="chapter"'):
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
            '<head><title>Book</title><style>p.x</style><script>1</script></head>\n'
            f'<body epub:type="bodymatter">\n<section {section_attrs}>\n{body}\n</section>\n'
            '</body>\n</html>\n')


MULTI = ('<?xml version="1.0" encoding="utf-8"?>\n'
         '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
         '<body>\n'
         '<section id="chapter-1" epub:type="chapter"><h2>One</h2><p>First chapter.</p></section>\n'
         '<section id="chapter-2" epub:type="chapter"><h2>Two</h2><p>Second chapter.</p></section>\n'
         '</body>\n</html>\n')


class ExtractNarrationTest(unittest.TestCase):
    def test_heading_kept_for_metadata_not_narrated(self):
        narration = extract(build('<h2>Chapter One</h2>\n<p>First.</p>\n<p>Second.</p>'))
        self.assertEqual("Chapter One", narration.title)
        self.assertEqual(["First.", "Second."], narration.blocks)

    def test_hgroup_and_ordinal_title_paragraphs_excluded(self):
        data = build('<header><hgroup><h2 epub:type="ordinal">II</h2>'
                     '<p epub:type="title">The Letter</p></hgroup></header>\n<p>Body.</p>')
        narration = extract(data)
        self.assertEqual(["Body."], narration.blocks)
        self.assertEqual("II: The Letter", narration.title)

    def test_namespaced_ordinal_title_hgroup_joined(self):
        data = build('<header><hgroup><h2 epub:type="z3998:ordinal">I</h2>'
                     '<p epub:type="z3998:title">Letters of Mark</p></hgroup></header>\n<p>Body.</p>')
        self.assertEqual("I: Letters of Mark", extract(data).title)

    def test_split_ordinal_and_title_joined_not_harvest_later_heading(self):
        data = build('<header><h2 epub:type="ordinal">III</h2><p epub:type="title">Split</p></header>'
                     '\n<p>Body.</p>\n<h3>A subsection</h3>\n<p>More.</p>')
        narration = extract(data)
        self.assertEqual("III: Split", narration.title)
        self.assertEqual(["Body.", "More."], narration.blocks)

    def test_unsupported_inline_ruby_stops(self):
        with self.assertRaises(ChapterError):
            extract(build('<p>The word <ruby>\u6f22<rt>kan</rt></ruby> ends.</p>'))

    def test_nested_block_table_inside_paragraph_stops(self):
        with self.assertRaises(ChapterError):
            extract(build('<p>Text<table><tr><td>One</td><td>Two</td></tr></table>end.</p>'))

    def test_head_style_script_and_nav_are_not_narrated(self):
        data = build('<nav><p>Site menu</p></nav>\n<p>Body.</p>')
        self.assertEqual(["Body."], extract(data).blocks)

    def test_inline_tags_unwrapped_with_text_and_tails(self):
        data = build('<p>He said <i>hello</i> to <abbr title="mister">Mr.</abbr> Smith and left.</p>')
        self.assertEqual(["He said hello to Mr. Smith and left."], extract(data).blocks)

    def test_allowed_anchor_and_nested_inline_preserved(self):
        data = build('<p>See <a href="map.xhtml"><em>the map</em></a> and <strong>go</strong>, '
                     '<span>then</span> stop.</p>')
        self.assertEqual(["See the map and go, then stop."], extract(data).blocks)

    def test_entities_decoded_exactly_once(self):
        data = build('<p>&amp;amp; then &lt;tag&gt; and &#8212; done</p>')
        self.assertEqual(["&amp; then <tag> and \u2014 done"], extract(data).blocks)

    def test_unicode_honorifics_currency_and_whitespace_verbatim(self):
        body = "<p>\u00a0M. Dupont paid \u00a35 10s. \u2014 \u2060a  b.</p>"
        expected = "\u00a0M. Dupont paid \u00a35 10s. \u2014 \u2060a  b."
        self.assertEqual([expected], extract(build(body)).blocks)

    def test_verse_br_becomes_line_breaks(self):
        data = build('<p>Line one<br/>Line two<br />Line three</p>')
        self.assertEqual(["Line one\nLine two\nLine three"], extract(data).blocks)

    def test_blockquote_embedded_letter_preserved(self):
        data = build('<blockquote>\n<p>Dear sir,</p>\n<p>Yours.</p>\n</blockquote>')
        self.assertEqual(["Dear sir,", "Yours."], extract(data).blocks)

    def test_structural_boundary_indentation_removed(self):
        self.assertEqual(["Indented paragraph."], extract(build('<p>\n\tIndented paragraph.\n</p>')).blocks)

    def test_multiple_chapters_require_a_section_choice(self):
        with self.assertRaises(ChapterError):
            extract(MULTI)

    def test_section_selects_the_requested_chapter(self):
        self.assertEqual(["Second chapter."], extract(MULTI, section="chapter-2").blocks)

    def test_unknown_section_stops(self):
        with self.assertRaises(ChapterError):
            extract(MULTI, section="nope")

    def test_part_section_holding_chapters_stops(self):
        data = ('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
                '<body><section id="part-1" epub:type="part">'
                '<section id="chapter-1" epub:type="chapter"><p>One.</p></section>'
                '<section id="chapter-2" epub:type="chapter"><p>Two.</p></section>'
                '</section></body></html>')
        with self.assertRaises(ChapterError):
            extract(data, section="part-1")

    def test_noteref_stops(self):
        with self.assertRaises(ChapterError):
            extract(build('<p>Word.<a epub:type="noteref" href="notes.xhtml">1</a></p>'))

    def test_dpub_aria_note_roles_stop(self):
        for role in ("doc-noteref", "doc-footnote", "doc-endnote", "doc-endnotes"):
            with self.subTest(role=role), self.assertRaises(ChapterError):
                extract(build(f'<p>Word.<a role="{role}" href="#note">1</a></p>'))

    def test_aside_note_stops(self):
        with self.assertRaises(ChapterError):
            extract(build('<p>Word.</p>\n<aside epub:type="footnote"><p>Note.</p></aside>'))

    def test_unsupported_block_stops(self):
        with self.assertRaises(ChapterError):
            extract(build('<p>Word.</p>\n<ul><li>Item</li></ul>'))

    def test_loose_narrative_text_stops(self):
        with self.assertRaises(ChapterError):
            extract(build('<p>Word.</p>\nA loose line.'))

    def test_truncated_xml_stops(self):
        with self.assertRaises(ChapterError):
            extract('<html><body><section epub:type="chapter"><p>oops')

    def test_non_xhtml_html_stops(self):
        with self.assertRaises(ChapterError):
            extract('<html><body><p>one<p>two')

    def test_empty_chapter_stops(self):
        with self.assertRaises(ChapterError):
            extract(build('<h2>Only a heading</h2>'))


class SourceUrlTest(unittest.TestCase):
    def test_github_blob_resolves_to_raw(self):
        self.assertEqual(SE_RAW, resolve(SE_BLOB).url)

    def test_github_raw_link_and_tree_listing(self):
        self.assertEqual(SE_RAW, resolve(SE_BLOB.replace("/blob/", "/raw/")).url)
        with self.assertRaises(ChapterError):
            resolve("https://github.com/standardebooks/book/tree/master/src/epub/text")

    def test_section_fragment_captured(self):
        raw, section = resolve(SE_BLOB + "#chapter-1-1")
        self.assertEqual(SE_RAW, raw)
        self.assertEqual("chapter-1-1", section)

    def test_github_line_anchors_are_not_sections(self):
        for fragment in ("L10", "L10-L20"):
            with self.subTest(fragment=fragment):
                raw, section = resolve(SE_BLOB + "#" + fragment)
                self.assertIsNone(section)
                self.assertNotIn("#", raw)

    def test_raw_and_direct_urls_pass_through(self):
        self.assertEqual(SE_RAW, resolve(SE_RAW).url)
        self.assertEqual("https://example.com/book/ch.xhtml",
                         resolve("https://example.com/book/ch.xhtml#L3").url)

    def test_slashed_ref_rejected(self):
        with self.assertRaises(ChapterError):
            resolve("https://github.com/standardebooks/book/blob/feature/branch/"
                    "src/epub/text/chapter-1.xhtml")

    def test_credentials_and_unsupported_scheme_rejected(self):
        with self.assertRaises(ChapterError):
            resolve("https://user:pass@github.com/o/r/blob/main/src/epub/text/c.xhtml")
        with self.assertRaises(ChapterError):
            resolve("ftp://example.com/chapter.xhtml")


class CommandLineTest(unittest.TestCase):
    def setUp(self):
        # Prefer the OpenCode scratch dir when present, but stay self-contained on a plain machine.
        parent = "/tmp/opencode" if Path("/tmp/opencode").is_dir() else None
        self._tmp = tempfile.TemporaryDirectory(prefix="extract-chapter-", dir=parent)
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def run_cli(self, argv):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = extract_chapter.main(argv)
        return code, stderr.getvalue()

    def test_input_written_and_existing_output_refused(self):
        source = self.tmp / "chapter.xhtml"
        source.write_text(build('<h2>One</h2><p>Body &amp; text.</p>'), encoding="utf-8")
        output = self.tmp / "chapter.md"

        code, stderr = self.run_cli(["--input", str(source), "--output", str(output)])
        self.assertEqual(0, code, stderr)
        self.assertEqual("Body & text.\n", output.read_text(encoding="utf-8"))
        self.assertIn("Chapter    One", stderr)

        code, stderr = self.run_cli(["--input", str(source), "--output", str(output)])
        self.assertEqual(1, code)
        self.assertIn("overwrite", stderr)
        self.assertEqual("Body & text.\n", output.read_text(encoding="utf-8"))

    def test_section_flag_selects_chapter(self):
        source = self.tmp / "multi.xhtml"
        source.write_text(MULTI, encoding="utf-8")
        output = self.tmp / "multi.md"
        code, stderr = self.run_cli(["--input", str(source), "--section", "chapter-2",
                                     "--output", str(output)])
        self.assertEqual(0, code, stderr)
        self.assertEqual("Second chapter.\n", output.read_text(encoding="utf-8"))

    def test_failure_writes_no_output(self):
        source = self.tmp / "bad.xhtml"
        source.write_text("<html><body><p>oops", encoding="utf-8")
        output = self.tmp / "bad.md"
        code, stderr = self.run_cli(["--input", str(source), "--output", str(output)])
        self.assertEqual(1, code)
        self.assertFalse(output.exists())
        self.assertIn("ERROR:", stderr)

    def test_unsupported_inline_and_note_roles_write_no_output(self):
        cases = {
            "ruby.xhtml": build('<p>Word <ruby>\u6f22<rt>kan</rt></ruby> end.</p>'),
            "noteref.xhtml": build('<p>Word.<a role="doc-noteref" href="#note">1</a></p>'),
        }
        for name, body in cases.items():
            with self.subTest(case=name):
                source = self.tmp / name
                source.write_text(body, encoding="utf-8")
                output = self.tmp / (name + ".md")
                code, stderr = self.run_cli(["--input", str(source), "--output", str(output)])
                self.assertEqual(1, code)
                self.assertFalse(output.exists())
                self.assertIn("ERROR:", stderr)

    def test_url_is_fetched_and_resolved_section_selected(self):
        output = self.tmp / "url.md"
        with mock.patch.object(extract_chapter, "fetch_source", return_value=MULTI.encode()) as fetcher:
            code, stderr = self.run_cli(["--url", SE_BLOB + "#chapter-2", "--output", str(output)])
        self.assertEqual(0, code, stderr)
        self.assertEqual("Second chapter.\n", output.read_text(encoding="utf-8"))
        fetcher.assert_called_once_with(SE_RAW)

    def test_network_failure_writes_no_output(self):
        output = self.tmp / "netfail.md"
        failure = urllib.error.URLError("connection refused")
        with mock.patch.object(extract_chapter, "fetch_source", side_effect=failure):
            code, stderr = self.run_cli(["--url", "https://example.com/book.xhtml",
                                         "--output", str(output)])
        self.assertEqual(1, code)
        self.assertFalse(output.exists())
        self.assertIn("ERROR:", stderr)

    def test_url_and_input_are_mutually_exclusive(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            extract_chapter.main(["--url", "https://example.com/x.xhtml",
                                  "--input", "x", "--output", "y"])


if __name__ == "__main__":
    unittest.main()
