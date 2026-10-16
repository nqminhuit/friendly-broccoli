One `reflections/<name>.md` per video, with image prompts in `reflections/<name>-prompts.txt`. Supply all metadata, narration and images; the pipeline generates no scripts or images.

# Format

Replace placeholders; repeat the section block for themes and closing.

```markdown
---
book: <book>
author: <author>
title: <SEO title>
thumbnail: <name>-thumbnail.png
description: |
  <SEO description>
  <hashtags>
---
## Opening
![](book-01.png)
<Narration...>
## Section 1
![](book-02.png)
<Narration...>
## Other sections
...
## Closing
[Music:...]
```

Keep prompts in a companion text file, put each PNG filename on its own line, followed immediately by its prompt; separate entries with a blank line. Include the dedicated thumbnail and every section image. Filenames must match the basenames of the Markdown image/thumbnail references and be unique within the reflection.

```text
<name>-thumbnail.png
<prompt to create image...>

<book>-01.png
<prompt to create image...>

<book>-02.png
<prompt to create image...>
```

Optional `tts_names` frontmatter key, shown alone; legacy reflections omit it and the authoring skill adds it when eligible names are spoken:

```text
tts_names: |
  Father Brown
  Israel Gow
  New York
```

If the reflection is a spoiler, include a spoken warning in the end of the opening section and use a spoiler-warning image, for example:

```markdown
![](spoiler_warning_4.png)

Imagine walking down a ...

This reflection contains full spoilers for ...

[Music:...]
```

- Required for new reflections: `book`, `author`, `title`, `description`, `thumbnail`. Only optional keys: `part` (chapter/passage), `voice` (sec10v `resources/voices/` file), `tts_names` (below). Hashtags recommended.
- `thumbnail` must name a dedicated image, separate from the first image and all other section images. Put its prompt in the companion text file; do not add a narration image line or section for it. The pipeline still accepts legacy files without `thumbnail`; new reflections must specify one explicitly.
- `book`, `author`, `part` are single-line. `key: value` consumes the rest of the line, including `:`; `key: |` takes following lines indented at least two spaces.
- `tts_names: |` (optional for legacy reflections; missing or empty means no transform, so existing reflections stay valid. The authoring/review skill fills it automatically whenever eligible names are spoken): one exact person or place name per line, normally spaced as spoken (`Father Brown`, not `FatherBrown`). Authoring/review fills it with multiword person and place names the narration actually speaks, not metadata, headings or image prompts. Uppercase dotted initials are allowed with at least one full word (`G. K. Chesterton`, `John F. Kennedy`); retain the periods and spaces as spoken. Apart from these initial periods, names allow only letters, inner hyphens and apostrophes, and spaces. Exclude ordinary capitalized phrases, book/chapter titles (a person's name inside a title is allowed, the whole title is not), ALL-CAPS words, acronyms, standalone initialisms, bare initials, all-initial names and uncertain entities. Do not invent spellings or pronunciations; the list is never a global allowlist. Matches are whole words and the longest listed name wins. Requires matching `sec10v` support, including the dotted-initial update for initial-bearing entries; deploy it before relying on this key.
- `## Heading` starts a section; blank lines separate paragraphs. Standalone `[Pause:<N>s]` inserts explicitly timed silence. Narration starts immediately, without a generated intro; keep it under 15 minutes including pauses.
- Each section needs a standalone `![](ref)` before its paragraphs and a matching prompt in the companion text file. First image precedes narration; it persists until the next image and is never spoken. Each change starts a chunk; avoid fewer than about 40 words/image.
- Use bucket-relative image/thumbnail names, resolved against the reflection image bucket (`REFLECTION_IMAGE_BUCKET` + `REFLECTION_IMAGE_PREFIX`). This repo is public: no bucket/presigned URLs or credentials. All required section images plus the named thumbnail must arrive to build: an early 20-minute wait runs while the chunks synthesize, then a 60-minute second window after audio collection; a timeout skips the build/upload with a warning. Prompts do not create images.
- Generated `Reflection.<FileName>` names must be unique across subdirectories and punctuation variants: `gift-of-the-magi.md` becomes `Reflection.GiftOfTheMagi`; `the-magi.md` and `the_magi.md` collide. Renaming starts a fresh name.
- Prompt should be consistent style: "Semi-realistic cinematic oil painting with visible painterly texture, natural proportions, historically accurate, atmospheric natural light and soft shadows. Full-HD, 1920x1080, 16:9, no text, no watermark"

# Spoilers and visuals

- Spoilers, including endings, are allowed when requested or needed for the agreed scope. Warn aloud in the opening before any spoilers; say whether the ending is discussed. No twists in metadata, thumbnails or pre-warning images.
- Default: semi-realistic cinematic oil painting, natural proportions, restrained expressive faces. Match lighting, palette, clothing and setting to the book's era/mood, not a universal Victorian aesthetic.
- Override when requested or better suited to the work; cartoonish styles suit satire, whimsy, fables or children's literature. Keep each video's images/thumbnail consistent; different books may differ. Every prompt must specify the full style, scene, composition, colors/symbols, Full-HD, 16:9 and no text.

# Audio cues

Put each cue on its own line, between narration paragraphs. Cues are never spoken or included in the narration transcript.

```text
[Pause:1s]

[Pause:5s]

[Pause:1.5s]

[Music:interlude.mp3:10s]

[Music:AFoolsTheme_BrianBolger.mp3:start=123s:end=133s:fade-in=1s:fade-out=2s]
```

- Silence requires `[Pause:<N>s]`, where `N` is positive finite integer or decimal seconds and the lowercase `s` is required. Times are rounded to the nearest millisecond; values rounding to zero or too large to render are rejected. Bare `[Pause]` has no default and is rejected, along with malformed or inline cues. To preserve an old three-second pause, write `[Pause:3s]`.
- The rendered pause duration is inserted silence in the final audio, independent of narration speed. Leading, trailing and consecutive timed pauses retain their durations; runtime estimates sum the millisecond-rounded durations rather than assigning every pause the same length.
- When combining pauses and music, keep each pause with spoken text in the same image run. An isolated pause-only block between music cues, or between a cue and the edge of an image run, is rejected rather than silently dropped.
- Music cues create music-only breaks: narration stops, the current image remains visible, and narration resumes afterwards. Existing camera motion may continue; music is not mixed underneath speech.
- The shorthand `:10s` plays the first 10 seconds of the track. Alternatively, specify both `start` and `end` to select a source-track excerpt; do not combine a duration with `start`/`end`.
- `start=123s:end=133s` selects source seconds 123–133, not positions in the video. Its total duration is 10 seconds, including any fades; music timing is independent of narration speed.
- `fade-in` and `fade-out` each default to 1 second; use `0` to disable a fade. Their sum must not exceed the excerpt's duration. Fade durations are not added to the break.
- Options may appear in any order. Times are nonnegative decimal seconds with an optional `s` suffix, so `start=123:end=133` is also valid. Require `0 ≤ start < end ≤ track length`; invalid, duplicate, or unknown options fail with a clear error.
- Music files must be present in `sec10v/resources/music/`. Use a filename, not a URL or directory path; missing, empty, unreadable, or escaping files fail rather than silently shortening or skipping a break.
- Include the sum of rendered pause durations and music duration when checking the reflection's 10–15-minute runtime. Timed pauses and music cues need a supporting `sec10v` version; do not send music cues directly to a TTS backend as narration text.
- Changing a pause duration requires regenerating the affected narration audio; do not reuse audio rendered with the old timing.
- Local resumes verify music provenance. If cues or tracks change, follow the reported rebuild instructions; preserve verified unchanged narration audio, not old music clips or narration audio whose segment numbering/text has changed.

# Pipeline

- `.github/workflows/sec10v_reflection.yml`: reflection changes pushed to `master` trigger builds; README/AGENTS are excluded. `[skip ci]` suppresses runs. Manual dispatch: `file: reflections/<name>.md`, optional voice override and `fresh` (rebuild from scratch, bypassing a saved failed-upload video).
- Videos upload directly to YouTube as **private**, not to the image bucket. Review video, metadata, chapters and thumbnail in YouTube Studio before publishing.
- Failed-upload retries only: YouTube is tried first and a first success stores nothing. Only a failed VIDEO upload saves the finished bundle to the existing `BUCKET_*` private video prefix, and the job still fails visibly — trigger the same file again next day to retry only the upload (no TTS/images/FFmpeg/QA). Changed source/voice/settings/refs or `fresh` bypass reuse; images replaced under the same ref need `fresh`. A stored receipt suppresses duplicates; ambiguous completion stops for manual review. The prefix must deny anonymous read (name/ACL alone is not enough). Needs `sec10v` `scripts/video_fallback.py` at the selected ref.
- Secrets: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, plus existing image/chunk-runner secrets and `BUCKET_S3_ENDPOINT`, `BUCKET_S3_URI`, `BUCKET_ACCESS_KEY_ID`, `BUCKET_SECRET_ACCESS_KEY` (failed-upload bundles only; deletion optional).
- Automatic visual-only defaults: 30 FPS, Ken Burns (8% max zoom), varied 1-second transitions, 1-second fade-in, 1.5-second fade-out. Controls in the reflection workflow: `VIDEO_FRAMERATE`, `CROSSFADE_SECONDS`, `TRANSITION_STYLE`, `FADE_IN_SECONDS`, `FADE_OUT_SECONDS`; rebuild to apply changes.
- `.github/workflows/sec10v.yml`: reflection Warmer narration uses `exaggeration=0.65`, `cfg_weight=0.35` on synthesis/retry; audiobooks retain 0.4/0.5. Regenerate audio to apply changes.
- `tts_names` joins names only at the Chatterbox call: `sec10v.yml` takes a JSON array input and passes `--tts-names-json` to `audiobook.py`. Narration, transcripts, captions and QA text keep their spelling. Changing names, including removing them, requires regenerating the affected narration audio; audio reuse accounts for name changes after the matching sec10v support lands.
