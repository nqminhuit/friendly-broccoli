One `chapters/<name>.md` per video, with image prompts in `chapters/<name>-prompts.txt`. Supply all metadata, narration and images; the pipeline generates no scripts, images or captions, and fetches nothing — `source_url` is provenance only.

# Format

Replace the placeholders; repeat the `![](…)` narration block for each image. The template below is a placeholder only — do not commit it as a buildable chapter.

```markdown
---
book: <book>
author: <author>
chapter: <spoken chapter label>
title: <SEO title>
description: |
  <SEO description>
  <hashtags>
thumbnail: <name>-thumbnail.png
---
![](<name>-01.png)
<Narration...>
![](<name>-02.png)
<Narration...>
[Pause:3s]
[Music:<track>.mp3:start=123s:end=133s:fade-in=1s:fade-out=2s]
<Narration...>
```

Keep prompts in the companion text file, put each PNG filename on its own line, followed immediately by its prompt; separate entries with a blank line. Cover every image and the dedicated thumbnail.

```text
<name>-thumbnail.png
<prompt to create image...>

<name>-01.png
<prompt to create image...>

<name>-02.png
<prompt to create image...>
```

Optional `tts_names` frontmatter key, shown alone; include it whenever eligible names are spoken:

```text
tts_names: |
  Father Brown
  Israel Gow
  New York
```

- Required: `book`, `author`, `chapter`, `title`, `description`, `thumbnail`. Optional: `voice` (sec10v `resources/voices/` file), `tts_names` (below), `source_url`, `motion` (`true`/`false`, default `false`). Hashtags recommended.
- `chapter` is the spoken chapter label used as the chapter title metadata; it is **not** narrated on its own. There is no generated intro or outro and no `.intro` dispatch item — the video starts with the file's own words. `title` is the YouTube SEO title.
- `book`, `author`, `chapter` are single-line. `key: value` consumes the rest of the line, including `:`; `key: |` takes following lines indented at least two spaces.
- `description: |` is the authored YouTube description (multiline). `thumbnail` must name a dedicated image, distinct from every body image; the build resolves it separately to `out/pics/<base>.thumb.jpg`.
- `source_url` is public provenance only (e.g. the Standard Ebooks page you imported from). It is recorded in the metadata and never fetched during a build.
- `motion: false` (default) renders static at 5 fps with no fades; `motion: true` renders Ken Burns at 30 fps with a 1s fade-in and 1.5s fade-out. The file's choice is part of the failed-upload identity, so changing it rebuilds the video. Existing audiobook voice and render defaults are otherwise preserved.
- `voice` names a narrator voice under sec10v `resources/voices/`; when omitted, the audiobook voice is used. A manual dispatch may override it for voice tests, but the file remains the default.
- Prose is preserved exactly as authored: no normalization, no expanding honorifics, currency or Unicode, no reflowing. `#`–`######` headings, HTML comments, `![](ref)` lines, pauses and music cues are never spoken. Do not write joined names into the body, metadata, SEO fields or image prompts.
- Body can start with the first `![](ref)` and then plain narration; headings are optional. The first image precedes the narration, and each image change starts a chunk; avoid fewer than about 40 words per image.
- Use bucket-relative image/thumbnail names, resolved against the chapter image bucket (`CHAPTER_IMAGE_BUCKET` + `CHAPTER_IMAGE_PREFIX`). This repo is public: no bucket/presigned URLs or credentials, no `http(s)://`, no query strings and no `..` traversal. No build generation touches the images: upload them yourself.
- Generated `Chapter.<CamelCase(FileName)>` names must be unique across subdirectories and punctuation variants: `the-blue-cross.md` becomes `Chapter.TheBlueCross`; `the-blue-cross.md` and `the_blue_cross.md` collide and the run is refused before any build. Renaming starts a fresh name.
- Commit a chapter only when it is ready to build: pushing `chapters/**.md` to `master` builds added/changed files. `[skip ci]` in the commit message suppresses the run, and a `-prompts.txt`-only commit never triggers one.
- Prompt should be a consistent style specific to the chapter's era and mood: "Semi-realistic cinematic oil painting with visible painterly texture, natural proportions, historically accurate, atmospheric natural light and soft shadows. Full-HD, 1920x1080, 16:9, no text, no watermark".

# Importing versus writing

- An imported chapter keeps the full source text exactly: no abridgment, modernization or rewriting, and no invented passages. The author may acquire and verify a source at authoring time (recording its URL as `source_url`), but the build itself never fetches.
- Add an exact spoken intro only if explicitly requested; otherwise the narration is the chapter text alone.

# Audio cues

Put each cue on its own line, between narration paragraphs. Cues are never spoken or included in the narration transcript.

```text
[Pause:1s]

[Pause:5s]

[Pause:1.5s]

[Music:interlude.mp3:10s]

[Music:AFoolsTheme_BrianBolger.mp3:start=123s:end=133s:fade-in=1s:fade-out=2s]
```

- Silence requires `[Pause:<N>s]`, where `N` is positive finite integer or decimal seconds and the lowercase `s` is required. Times are rounded to the nearest millisecond; values rounding to zero or too large to render are rejected. Bare `[Pause]` has no default and is rejected, along with malformed or inline cues.
- When combining pauses and music, keep each pause with spoken text in the same image run; an isolated pause-only block between music cues, or between a cue and the edge of an image run, is rejected.
- Music cues create music-only breaks: narration stops, the current image remains visible, and narration resumes afterwards. Music is not mixed underneath speech.
- `:10s` plays the first 10 seconds of the track; alternatively specify both `start` and `end` to select a source-track excerpt, and do not combine a duration with `start`/`end`. `start=123s:end=133s` selects source seconds 123–133, not positions in the video.
- `fade-in` and `fade-out` each default to 1 second; use `0` to disable a fade. Their sum must not exceed the excerpt's duration, and fades are not added to the break. Options may appear in any order; times are nonnegative decimal seconds with an optional `s` suffix.
- Music files must be present in `sec10v/resources/music/`. Use a filename, not a URL or directory path; missing, empty, unreadable, or escaping files fail rather than silently skipping a break.
- There is no required or automatic music bed, and no duration cap: a chapter keeps its own length, including rendered pause and music durations. Choose music only from the metadata in `sec10v/resources/music/`; never invent tracks, filenames or timestamps.

# tts_names

- `tts_names: |` (optional; missing or empty means no transform): one exact person or place name per line, normally spaced as spoken (`Father Brown`, not `FatherBrown`). Fill it with multiword person and place names the narration actually speaks, not metadata, headings or image prompts.
- Uppercase dotted initials are allowed with at least one full word (`G. K. Chesterton`, `John F. Kennedy`); retain the periods and spaces as spoken. Apart from these initial periods, names allow only letters, inner hyphens and apostrophes, and spaces. Exclude ordinary capitalized phrases, book/chapter titles (a person's name inside a title is allowed, the whole title is not), ALL-CAPS words, acronyms, standalone initialisms, bare initials, all-initial names and uncertain entities. Do not invent spellings or pronunciations; the list is never a global allowlist. Matches are whole words and the longest listed name wins.
- The list joins names only at the Chatterbox call; narration, transcripts and QA keep their spelling. Requires matching `sec10v` support, including the dotted-initial update for initial-bearing entries; deploy it before relying on this key.

# Pipeline

- `.github/workflows/sec10v_chapter.yml`: chapter changes pushed to `master` trigger builds of the added/changed files; README/AGENTS are excluded and a `-prompts.txt`-only commit builds nothing. `[skip ci]` suppresses runs. Manual dispatch: `file: chapters/<name>.md`, optional voice override, `fresh` (rebuild from scratch, bypassing a saved failed-upload video) and `sec10v_ref`. The job checks out the exact event commit, so a dispatch builds the selected content, not a moving master.
- Prepare validates all metadata, voice/image/music/thumbnail/cue/chunk-limit rules before any TTS is dispatched. A configuration failure stops the run early.
- Required images and the dedicated thumbnail must all arrive to build: an early 20-minute wait runs while the chunks synthesize, then a 60-minute second window after audio collection; a timeout, or a missing image or thumbnail, skips the build/upload with a warning naming the safe paths.
- Videos upload directly to YouTube as **private**, with the authored SEO applied. Review the video, metadata, chapters and thumbnail in YouTube Studio before publishing.
- Failed-upload retries only: YouTube is tried first and a first success stores nothing. Only a failed VIDEO upload saves the finished bundle to the existing `BUCKET_*` private video prefix, and the job still fails visibly — trigger the same file again next day to retry only the upload (no TTS/images/FFmpeg/QA). Changed source/voice/settings/refs or `fresh` bypass reuse; an image replaced under the same ref needs `fresh`. A stored receipt suppresses duplicates; ambiguous completion stops for manual review. The prefix must deny anonymous read (name/ACL alone is not enough). Needs `sec10v` `scripts/video_fallback.py` at the selected ref.
- Audio reuse is identity-safe: a chunk's MP3 is reused only when its `.audio.json` sidecar matches the chunk text, voice, rate, reference and audio digests; audio without a sidecar is regenerated once.
- Secrets: `CHAPTER_IMAGE_BUCKET`, optional `CHAPTER_IMAGE_PREFIX`, `SEC10V_ACCESS_TOKEN`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, `HF_TOKEN`, plus `BUCKET_S3_ENDPOINT`, `BUCKET_S3_URI`, `BUCKET_ACCESS_KEY_ID`, `BUCKET_SECRET_ACCESS_KEY` (failed-upload bundles and image reads). There is no `GEMINI_API_KEY` — the file is the only source of prompt and SEO text.
- Deployment requires the supporting `sec10v` ref (with `prepare_markdown_chapter.py`, `reflection_images.py` chapter handling and `video_fallback.py` source-file identity) merged and selected before this workflow is activated. A too-old `sec10v_ref` fails the early capability check with a clear message.
