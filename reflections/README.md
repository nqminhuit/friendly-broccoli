One `reflections/<name>.md` per video. Supply all metadata, narration and images; the pipeline generates no scripts or images.

# Format

Replace placeholders; repeat the section block for themes and closing.

```markdown
---
book: <book>
author: <author>
title: <SEO title>
thumbnail: <SEO title>-thumbnail.jpg
description: |
  <SEO description>
  <hashtags>
---
<!-- thumbnail_prompt:
<Dedicated thumbnail scene, clear focal point, composition readable at small sizes; full chosen style. Full-HD, 16:9, no text.>
-->
## Opening
![](book-01.jpg)
<!-- image_prompt:
<Scene, composition, colors, symbols; full chosen style. Full-HD, 16:9, no text.>
-->
<Narration; spoken spoiler warning only if this is a spoiler reflection, otherwise no need.>
## Section 1
![](book-02.jpg)
<!-- image_prompt:
...
-->
<Narration ...>
## Other sections
...
## Closing
```

- Required for new reflections: `book`, `author`, `title`, `description`, `thumbnail`. Only optional keys: `part` (chapter/passage), `voice` (sec10v `resources/voices/` file). Hashtags recommended.
- `thumbnail` must name a dedicated image, separate from the first image and all other section images. Add a `thumbnail_prompt` comment after the front matter and before the first section; do not add a narration image line or section for it. The pipeline still accepts legacy files without `thumbnail`; new reflections must specify one explicitly.
- `book`, `author`, `part` are single-line. `key: value` consumes the rest of the line, including `:`; `key: |` takes following lines indented at least two spaces.
- `## Heading` starts a section; blank lines separate paragraphs. Standalone `[Pause]` = 3 seconds. Narration starts immediately, without a generated intro; keep it under 15 minutes including pauses.
- Each section needs a standalone `![](ref)` before its paragraphs and an `image_prompt` comment. First image precedes narration; it persists until the next image and is never spoken. Each change starts a chunk; avoid fewer than about 40 words/image.
- Use bucket-relative image/thumbnail names, resolved via `IMAGE_BASE_URL`. This repo is public: no bucket/presigned URLs or credentials. All required section images plus the named thumbnail must arrive to build: an early 20-minute wait runs while the chunks synthesize, then a 60-minute second window after audio collection; a timeout skips the build/upload with a warning. Prompts do not create images.
- Generated `Reflection.<FileName>` names must be unique across subdirectories and punctuation variants: `gift-of-the-magi.md` becomes `Reflection.GiftOfTheMagi`; `the-magi.md` and `the_magi.md` collide. Renaming starts a fresh name.

# Spoilers and visuals

- Spoilers, including endings, are allowed when requested or needed for the agreed scope. Warn aloud in the opening before any spoilers; say whether the ending is discussed. No twists in metadata, thumbnails or pre-warning images.
- Default: semi-realistic cinematic oil painting, natural proportions, restrained expressive faces. Match lighting, palette, clothing and setting to the book's era/mood, not a universal Victorian aesthetic.
- Override when requested or better suited to the work; cartoonish styles suit satire, whimsy, fables or children's literature. Keep each video's images/thumbnail consistent; different books may differ. Every prompt must specify the full style, scene, composition, colors/symbols, Full-HD, 16:9 and no text.

# Pipeline

- `.github/workflows/sec10v_reflection.yml`: reflection changes pushed to `master` trigger builds; README/AGENTS are excluded. `[skip ci]` suppresses runs. Manual dispatch: `file: reflections/<name>.md`, optional voice override and `fresh` (rebuild from scratch, bypassing a saved failed-upload video).
- Videos upload directly to YouTube as **private**, not to the image bucket. Review video, metadata, chapters and thumbnail in YouTube Studio before publishing.
- Failed-upload retries only: YouTube is tried first and a first success stores nothing. Only a failed VIDEO upload saves the finished bundle to the existing `BUCKET_*` private video prefix, and the job still fails visibly — trigger the same file again next day to retry only the upload (no TTS/images/FFmpeg/QA). Changed source/voice/settings/refs or `fresh` bypass reuse; images replaced under the same ref need `fresh`. A stored receipt suppresses duplicates; ambiguous completion stops for manual review. The prefix must deny anonymous read (name/ACL alone is not enough). Needs `sec10v` `scripts/video_fallback.py` at the selected ref.
- Secrets: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`, plus existing image/chunk-runner secrets and `BUCKET_S3_ENDPOINT`, `BUCKET_S3_URI`, `BUCKET_ACCESS_KEY_ID`, `BUCKET_SECRET_ACCESS_KEY` (failed-upload bundles only; deletion optional).
- Automatic visual-only defaults: 30 FPS, Ken Burns (8% max zoom), varied 1-second transitions, 1-second fade-in, 1.5-second fade-out. Controls in the reflection workflow: `VIDEO_FRAMERATE`, `CROSSFADE_SECONDS`, `TRANSITION_STYLE`, `FADE_IN_SECONDS`, `FADE_OUT_SECONDS`; rebuild to apply changes.
- `.github/workflows/sec10v.yml`: reflection Warmer narration uses `exaggeration=0.65`, `cfg_weight=0.35` on synthesis/retry; audiobooks retain 0.4/0.5. Regenerate audio to apply changes.
