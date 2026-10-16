---
name: prepare-chapter
description: Prepare, write or review chapters/ audiobook chapter files — full-text imports, narration fidelity, metadata, SEO, dedicated thumbnail, image prompts, pauses and music cues. Not for reflections or commentary.
---

1. Use `../../../chapters/README.md`: `Format` and `Importing versus writing` for authoring/review; `Pipeline` only for builds/publishing. Read sections only if missing from context or changed. This skill is for chapter/audiobook content only — do not load or apply `write-reflection`, which covers reflections and commentary.

2. Confirm the work: book, author, chapter label, filename and provenance. Check `chapters/` for existing files and generated-name collisions (`Chapter.<CamelCase(file-stem)>`, including punctuation variants such as `the-blue-cross.md` vs `the_blue_cross.md`). Verify that the source, work, chapter and output filename belong together; ask when provenance, scope or the chapter boundary is unclear rather than guessing.

3. Preserve the source text exactly unless explicitly asked to adapt it: no abridgment, no modernization, no rewriting, no invented or reconstructed passages. If a passage is missing or uncertain, report it and ask — never fill the gap. The author may acquire and verify a source at authoring time and record its public URL as `source_url`; the build never fetches, so the committed text is the only input.

4. Fill the front matter: required `book`, `author`, `chapter`, `title`, `description`, `thumbnail`; optional `voice`, `tts_names`, `source_url`, `motion`. Write the YouTube SEO `title` and multiline `description` yourself. `chapter` is a spoken-label metadata field and is not narrated on its own.

5. Keep narration as the chapter text, starting with the first image and its `![](ref)`. Add an exact spoken intro or outro only when explicitly requested. Optional headings, HTML comments, pauses and music cues are never spoken. Do not normalize honorifics, currency or Unicode, and never write joined names into the body, metadata, SEO fields or prompts.

6. Add a dedicated `thumbnail` image, distinct from every body image, and put its prompt plus every section image prompt in `chapters/<name>-prompts.txt`: each PNG filename on its own line, its prompt immediately after, entries separated by a blank line. Keep a consistent style specific to the chapter's era and mood, and name each file to match its Markdown reference. The pipeline does not generate images or prompts.

7. Use only bucket-relative image and thumbnail names — never bucket/presigned URLs, credentials or `..` traversal. The repo is public.

8. `motion: false` (default) keeps static 5 fps with no fades; `motion: true` opts into Ken Burns 30 fps with 1s/1.5s fades. `voice` defaults to the audiobook voice when omitted. Preserve existing voice and render defaults unless asked, and change the file (not a hidden default) to change them.

9. Add pauses and music only when they serve the narration, and only with the existing valid syntax: standalone `[Pause:<N>s]` with an explicit positive, renderable duration, and standalone `[Music:<filename>:…]` cues whose tracks, timestamps and fades come from `sec10v/resources/music/` metadata. Do not invent tracks, filenames or timestamps, and do not add mandatory music, a required duration cap or a spoiler notice — a chapter keeps its own length and tone.

10. Populate optional `tts_names: |` with the multiword person and place names the narration actually speaks, one exact name per line in normal spelling (`Father Brown`, not `FatherBrown`). Uppercase dotted initials are allowed with at least one full word (`G. K. Chesterton`), keeping periods and spacing; exclude ordinary capitalized phrases, titles (a name inside a title is allowed), ALL-CAPS words, acronyms, standalone initialisms, bare initials, all-initial names and uncertain entities. Do not invent spellings. Omit the block only when no eligible names apply. Requires matching `sec10v` support, including the dotted-initial update for initial-bearing entries.

11. Work on the branch asked for. Do not commit, push, dispatch or publish unless requested.

12. When done, review in two rounds. Round 1: completeness and text fidelity — every required field present, the full chapter text preserved with nothing added or dropped, the opening image and prompt present. Round 2: metadata, SEO, dedicated thumbnail and prompt coverage, relative refs (no URLs or secrets), pause/music syntax and provenance, `tts_names` correctness, and generated-name collisions.
