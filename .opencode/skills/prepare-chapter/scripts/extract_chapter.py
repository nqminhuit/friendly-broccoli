#!/usr/bin/env python3
"""Extract narration-only Markdown from a public XHTML/EPUB chapter, deterministically, no LLM.

Adapted from the acquisition/extraction half of ``nqminhuit/sec10v`` ``scripts/prepare_chapter.py``.
"""
from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Sequence
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote, urlsplit, urlunsplit

EPUB_NS = "http://www.idpf.org/2007/ops"
DEFAULT_TIMEOUT = 60
HTTP_SCHEMES = ("http", "https")
GITHUB_HOSTS = ("github.com", "www.github.com")
USER_AGENT = "friendly-broccoli-prepare-chapter/1.0 (+https://github.com/nqminhuit/friendly-broccoli)"
RAW_BASE = "https://raw.githubusercontent.com"
# The Standard Ebooks chapter path: its presence pins the ref to the segment before it.
SE_MARKER = "src/epub/text/"
# GitHub's own line anchors (#L10, #L10-L20) are not chapter/section ids.
_LINE_ANCHOR_RE = re.compile(r"L\d+(?:-L\d+)?\Z")
_BLOB_RE = re.compile(r"^/(?P<owner>[^/]+)/(?P<repo>[^/]+)/(?:blob|raw)/(?P<rest>.+)$")
# Whitespace removed only at a block's structural boundary; NBSP and other Unicode spaces stay.
STRUCTURAL_WS = " \t\r\n\f\v"

SECTION_TAGS = ("section", "article")
HEADING_TAGS = frozenset({"hgroup", "h1", "h2", "h3", "h4", "h5", "h6"})
NARRATIVE_TAGS = frozenset({"p", "figcaption"})
CONTAINER_TAGS = frozenset({"section", "article", "blockquote", "div", "header", "figure"})
SKIP_TAGS = frozenset({"head", "style", "script", "title", "meta", "link", "base", "nav",
                       "img", "hr", "source", "template", "col", "colgroup"})
METADATA_TOKENS = frozenset({"title", "ordinal"})
NOTE_TOKENS = frozenset({"noteref", "footnote", "endnote", "rearnote", "note",
                         "footnotes", "endnotes", "rearnotes"})
# DPUB-ARIA roles marking the same note/noteref content as epub:type does.
NOTE_ROLES = frozenset({"doc-noteref", "doc-footnote", "doc-endnote", "doc-endnotes"})
# Inline tags a narrative paragraph/heading may wrap; any other nesting fails closed.
INLINE_TAGS = frozenset({
    "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "del", "dfn",
    "em", "i", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strong",
    "sub", "sup", "time", "u", "var", "w",
})


class ChapterError(Exception):
    """A source or extraction problem the author has to resolve; nothing is written."""


class SourceRef(NamedTuple):
    """A resolved source: the fetchable URL and an optional ``#<section-id>`` selection."""

    url: str
    section: str | None = None


class Narration(NamedTuple):
    """The extracted chapter: its heading/label for metadata, and the narrative blocks."""

    title: str | None
    blocks: list[str]


def _local(tag: object) -> str:
    """``{ns}p`` → ``p``; comments/PIs (non-str tags) → ``""``."""
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _epub_types(element: ET.Element) -> list[str]:
    value = element.get(f"{{{EPUB_NS}}}type") or ""
    return value.split()


def _has_metadata_token(element: ET.Element) -> bool:
    """True for a heading paragraph carrying ``epub:type`` ``title``/``ordinal`` (never narrated)."""
    return any(token in METADATA_TOKENS or token.split(":")[-1] in METADATA_TOKENS
               for token in _epub_types(element))


def is_line_anchor(fragment: str) -> bool:
    """``L10``/``L10-L20`` are GitHub line anchors, not chapter section ids."""
    return bool(_LINE_ANCHOR_RE.fullmatch(fragment))


def resolve_source_url(url: str) -> SourceRef:
    """Resolve a GitHub blob or direct http(s) URL to its fetchable source plus any ``#<section-id>``."""
    parts = urlsplit(url.strip())
    if parts.scheme not in HTTP_SCHEMES:
        raise ChapterError(f"unsupported URL scheme {parts.scheme or '(none)'!r}; use http or https: {url}")
    if "@" in parts.netloc:
        raise ChapterError(f"credentials are not allowed in the source URL: {url}")
    if not parts.hostname:
        raise ChapterError(f"source URL has no host: {url}")

    section = unquote(parts.fragment) if parts.fragment else None
    if section and is_line_anchor(section):
        section = None

    host = parts.hostname.lower()
    if host in GITHUB_HOSTS:
        if "/tree/" in parts.path:
            raise ChapterError(f"that GitHub URL is a directory listing, not a chapter file: {url}")
        if _BLOB_RE.match(parts.path):
            return SourceRef(_github_blob_to_raw(parts.path, url), section)
    return SourceRef(urlunsplit((parts.scheme, parts.netloc, parts.path, parts.query, "")), section)


def _github_blob_to_raw(path: str, url: str) -> str:
    match = _BLOB_RE.match(path)
    if not match:
        raise ChapterError(f"unrecognised GitHub URL: {url}")
    rest = match.group("rest")
    if SE_MARKER in rest:
        prefix, _, tail = rest.partition(SE_MARKER)
        ref = prefix.removesuffix("/")
        if not ref or "/" in ref or not tail:
            raise ChapterError(
                f"ambiguous GitHub ref in {url}: a '/' ref cannot be told apart from the file path; "
                "use a branch/tag/SHA without a slash")
        file_path = SE_MARKER + tail
    else:
        ref, slash, file_path = rest.partition("/")
        if not ref or not slash or not file_path:
            raise ChapterError(f"GitHub blob URL must name a ref and a file path: {url}")
    return f"{RAW_BASE}/{match.group('owner')}/{match.group('repo')}/{ref}/{file_path}"


def fetch_source(url: str, timeout: int = DEFAULT_TIMEOUT) -> bytes:
    """GET the raw chapter bytes with a finite timeout; HTTP/network errors raise."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def read_source(path: Path) -> bytes:
    if not path.is_file():
        raise ChapterError(f"input file not found: {path}")
    return path.read_bytes()


def parse_document(data: bytes | str) -> ET.Element:
    """Parse the whole source as XML; anything not well-formed XHTML is a hard failure."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    data = data.removeprefix(b"\xef\xbb\xbf")
    if b"<!entity" in data.lower():
        raise ChapterError("DTD/entity declarations are not supported; use plain XHTML")
    try:
        return ET.fromstring(data)
    except ET.ParseError as exc:
        raise ChapterError(
            f"source is not well-formed XHTML/XML ({exc}); HTML that is not valid XHTML needs "
            "explicit, supported scripted handling")


def _find_body(root: ET.Element) -> ET.Element:
    for element in root.iter():
        if _local(element.tag) == "body":
            return element
    return root


def select_container(body: ET.Element, section: str | None) -> ET.Element:
    """The requested ``<section>``/``<article>``; several chapters require an explicit choice."""
    if section:
        for element in body.iter():
            if _local(element.tag) in SECTION_TAGS and element.get("id") == section:
                nested = [d for d in element.iter() if d is not element
                          and _local(d.tag) in SECTION_TAGS and "chapter" in _epub_types(d)]
                if nested:
                    ids = ", ".join(d.get("id") or "(no id)" for d in nested)
                    raise ChapterError(f"section {section!r} holds several chapters ({ids}); "
                                       "pick one of them instead")
                return element
        raise ChapterError(f"no <section>/<article> with id {section!r} in the source")

    chapters = [el for el in body.iter()
                if _local(el.tag) in SECTION_TAGS and "chapter" in _epub_types(el)]
    if len(chapters) == 1:
        return chapters[0]
    if len(chapters) > 1:
        ids = ", ".join(el.get("id") or "(no id)" for el in chapters)
        raise ChapterError(
            f"source holds {len(chapters)} chapters ({ids}); pass --section or a #<section-id> "
            "fragment to choose exactly one")
    sections = [el for el in body.iter() if _local(el.tag) in SECTION_TAGS]
    if len(sections) == 1:
        return sections[0]
    raise ChapterError("no chapter container (<section>/<article epub:type=\"chapter\">) found in the source")


def _check_loose(text: str | None) -> None:
    if text and text.strip(STRUCTURAL_WS):
        raise ChapterError("loose narrative text outside a supported paragraph; the source needs "
                           "supported scripted handling rather than hand extraction")


def _note_kind(element: ET.Element) -> str | None:
    """A clear label for a note/noteref element (via ``epub:type`` or DPUB-ARIA role), or ``None``."""
    for token in _epub_types(element):
        if token.split(":")[-1] in NOTE_TOKENS:
            return f"epub:type={token!r}"
    for role in (element.get("role") or "").split():
        if role in NOTE_ROLES:
            return f"role={role!r}"
    return None


def _reject_notes(container: ET.Element) -> None:
    for element in container.iter():
        if _local(element.tag) == "aside":
            raise ChapterError("chapter contains an <aside> note; notes are not supported, add scripted handling")
        kind = _note_kind(element)
        if kind:
            raise ChapterError(f"chapter contains {kind} notes/noterefs; notes are not supported, "
                               "add scripted handling")


def _first_heading_region(container: ET.Element) -> ET.Element | None:
    """The first chapter heading/hgroup, or the ``<header>`` holding it; later subsections ignored."""
    parents = {child: parent for parent in container.iter() for child in parent}
    for element in container.iter():
        tag = _local(element.tag)
        if tag in HEADING_TAGS or (tag == "p" and _has_metadata_token(element)):
            parent = parents.get(element)
            if parent is not None and _local(parent.tag) in ("hgroup", "header"):
                return parent
            return element
    return None


def _heading_text(region: ET.Element) -> str:
    """A heading region's ``ordinal: title`` label for metadata, blank parts dropped."""
    ordinal = title = plain = None
    for node in region.iter():
        tag = _local(node.tag)
        if tag == "hgroup" or (tag not in HEADING_TAGS and tag not in NARRATIVE_TAGS):
            continue
        if not (text := _block_text(node)):
            continue
        tokens = {token.split(":")[-1] for token in _epub_types(node)}
        if "ordinal" in tokens and ordinal is None:
            ordinal = text
        elif "title" in tokens and title is None:
            title = text
        elif tag in HEADING_TAGS and plain is None:
            plain = text
    label = ordinal or plain
    return ": ".join(part for part in (label, title) if part)


def _chapter_title(container: ET.Element) -> str | None:
    """The chapter heading/label for metadata — never part of the narration."""
    if (region := _first_heading_region(container)) is not None and (text := _heading_text(region)):
        return text
    for element in container.iter():
        if _local(element.tag) == "p" and _has_metadata_token(element) and (text := _block_text(element)):
            return text
    return None


def _block_text(element: ET.Element) -> str:
    """A block's text with inline tags unwrapped, entity decoded once, boundary indentation removed."""
    parts: list[str] = []
    _gather(element, parts)
    return "".join(parts).strip(STRUCTURAL_WS)


def _gather(element: ET.Element, parts: list[str]) -> None:
    """Unwrap allowed inline tags, preserving each element's text/tails; anything else fails closed."""
    parts.append(element.text or "")
    for child in list(element):
        tag = _local(child.tag)
        if tag == "br":
            parts.append("\n")
        elif tag in INLINE_TAGS:
            _gather(child, parts)
        else:
            raise ChapterError(f"unsupported <{tag}> inside narrative text; only inline tags are "
                               "supported, add scripted handling instead of extracting by hand")
        parts.append(child.tail or "")


def _walk(element: ET.Element, blocks: list[str]) -> None:
    _check_loose(element.text)
    for child in list(element):
        tag = _local(child.tag)
        _check_loose(child.tail)
        if tag in HEADING_TAGS or tag in SKIP_TAGS:
            continue
        if tag in NARRATIVE_TAGS:
            if not _has_metadata_token(child) and (text := _block_text(child)):
                blocks.append(text)
        elif tag in CONTAINER_TAGS:
            _walk(child, blocks)
        else:
            raise ChapterError(f"unsupported element <{tag}> inside the chapter; add supported "
                               "scripted handling instead of extracting by hand")


def extract_narration(data: bytes | str, section: str | None = None) -> Narration:
    """Parse and select one chapter, returning its label and narrative blocks in document order."""
    root = parse_document(data)
    container = select_container(_find_body(root), section)
    _reject_notes(container)
    blocks: list[str] = []
    _walk(container, blocks)
    if not blocks:
        raise ChapterError("chapter has no narrative paragraphs; nothing to narrate")
    return Narration(_chapter_title(container), blocks)


def render_narration(blocks: Sequence[str]) -> str:
    """Blocks separated by a blank line, with a trailing newline — narration only, no front matter."""
    return "\n\n".join(blocks) + "\n"


def write_output(path: Path, text: str) -> None:
    """Create ``path`` exclusively; an existing file is never overwritten."""
    if path.exists():
        raise ChapterError(f"refusing to overwrite existing file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "x", encoding="utf-8", newline="") as handle:
        handle.write(text)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--url", help="public chapter URL; a GitHub /blob/ URL is resolved to its raw source")
    group.add_argument("--input", help="local XHTML/HTML file instead of --url")
    parser.add_argument("--output", required=True, help="new UTF-8 narration-only Markdown file (must not exist)")
    parser.add_argument("--section", help="chapter <section>/<article> id; overrides a #fragment in --url")
    args = parser.parse_args(argv)

    try:
        if args.url:
            resolved = resolve_source_url(args.url)
            source_label = resolved.url
            section = args.section or resolved.section
            data = fetch_source(resolved.url)
        else:
            source_path = Path(args.input)
            source_label = str(source_path)
            section = args.section
            data = read_source(source_path)

        narration = extract_narration(data, section)
        output = Path(args.output)
        write_output(output, render_narration(narration.blocks))
    except (ChapterError, urllib.error.URLError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"Source     {source_label}", file=sys.stderr)
    print(f"Section    {section or '(whole file)'}", file=sys.stderr)
    print(f"Chapter    {narration.title or '(no heading)'}", file=sys.stderr)
    print(f"Blocks     {len(narration.blocks)}", file=sys.stderr)
    print(f"Output     {output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
