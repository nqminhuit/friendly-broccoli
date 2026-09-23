# Reflection files

Each `reflections/<name>.md` file describes one reflection video: the source chapter, the voice,
the SEO, the script, and the image shown over each paragraph. Pushing an added or changed file to
`master` starts `.github/workflows/sec10v_reflection.yml` for that file. To re-run a file, or to try
another voice without a commit, dispatch the workflow with `file: reflections/<name>.md` and, if you
like, a voice override. Put `[skip ci]` in the commit message to push without starting a run. This
README never triggers a run.

## Format

```markdown
---
source: https://github.com/standardebooks/o-henry_short-fiction/blob/master/src/epub/text/the-gift-of-the-magi.xhtml
voice: _live/maddpren_enhanced_cut_magician_12_maugham_128kb.wav
title: The Gift of the Magi: what a gift really costs
thumbnail: magi-thumb.jpg
description: |
  One dollar and eighty-seven cents...
  #BookReflection #OHenry
---
## A Dollar and Eighty-Seven Cents
![](magi-1.jpg)
Hello, and welcome...

![](magi-2.jpg)
Della counted it three times...
```

- **Front matter**, between the two `---` lines:
  - `source` (required) is the Standard Ebooks chapter URL copied from GitHub. Add `#<section-id>` to narrate one chapter of a file that holds several.
  - `voice` is optional and is a file under sec10v's `resources/voices/`.
  - `title` and `description` are the YouTube SEO. When both are given, Gemini is not asked for them. A `description` needs a `title`.
  - `thumbnail` is optional. Without it, the first image is the thumbnail.
  - `key: value` takes the rest of the line, so a title may contain `:`. `key: |` takes the following lines indented by at least 2 spaces. Any other key is an error.
- **Script**: `## Heading` starts a section, and blank lines separate paragraphs.
- **Images**: a line that is exactly `![](ref)` shows that image from the next paragraph on, until the next image line. The first image line must come before the first paragraph.
  - Image lines are never read aloud.
  - Every image change starts a new chunk, so avoid very short runs of text under one image (under about 40 words).
  - All images are downloaded before any audio is made, and a missing one fails the run at once.
  - Without any image lines, the old flow applies: Gemini writes one image prompt per section, and you upload `<BaseName>.<k>.jpg` to the bucket while the run waits.

**This repo is public.** Write each image `ref` as a name relative to the image bucket (for example `magi-1.jpg`). It is resolved against the `IMAGE_BASE_URL` secret, so the bucket's address never appears here. Never paste a bucket or presigned URL into a file.
