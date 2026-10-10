# Reflection files

Each `reflections/<name>.md` file describes one reflection video: the work it reflects on, the voice,
the SEO, the script, and the image shown over each paragraph. Pushing an added or changed file to
`master` starts `.github/workflows/sec10v_reflection.yml` for that file. To re-run a file, or to try
another voice without a commit, dispatch the workflow with `file: reflections/<name>.md` and, if you
like, a voice override. Put `[skip ci]` in the commit message to push without starting a run. This
README never triggers a run.

## Format

```markdown
---
book: <book name, required>
author: <author name, required>
part: <part name, or chapter, optional>
voice: _live/maddpren_enhanced_cut_magician_12_maugham_128kb.wav
title: <youtube seo friendly title, recommended>
thumbnail: <optional thumbnail image, recommended>
description: |
  <youtube seo friendly description, recommended>
  <hash tags, recommended>
---
## <heading session opening>
![](img-1.jpg)
<!-- image_prompt:
A crowded Edwardian London railway station...
Cartoon cinematic, oil painting, vintage Victorian palette.
Full-HD resolution, 16:9 aspect ratio. No text.
-->
Hello, and welcome...

## <heading session 1>
![](img-2.jpg)
The rabbit is a symbol of...

## <other remaining heading sessions>
![](img-x.jpg)
...

## <closing session>
...
```

- **Front matter**, between the two `---` lines:
  - `book` and `author` (both required) name the work. `part` is optional and names what the reflection covers, such as a chapter or a passage; without it the intro reads "A reflection". Each is a single line. Nothing is fetched: you write the whole script.
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

**File names must be unique under `reflections/`.** The video, its chunks and the prompts and SEO saved in the bucket are all named `Reflection.<FileName>` (`gift-of-the-magi.md` becomes `Reflection.GiftOfTheMagi`), so `a/magi.md` and `b/magi.md`, or `the-magi.md` and `the_magi.md`, would overwrite each other. Renaming a file starts a fresh name, without the saved prompts and SEO.

**This repo is public.** Write each image `ref` as a name relative to the image bucket (for example `magi-1.jpg`). It is resolved against the `IMAGE_BASE_URL` secret, so the bucket's address never appears here. Never paste a bucket or presigned URL into a file.

## Prompts
Act as a senior literary critic and write a reflection on the book "" by "" in the style of a YouTube video script under 15 minutes of narration. The reflection should be engaging, insightful, and accessible to a general audience. Do not spoil the ending of the book, but provide enough context to entice viewers to read it. Use a friendly, warm, and conversational tone, as if you are sharing your thoughts with a friend. Include personal anecdotes or experiences related to the book, and highlight its themes, characters, and writing style. Use simple vocabulary and avoid complex literary jargon so that the viewers can easily follow along and understand the reflection. The reflection should be structured in a way that each paragraph can be read aloud clearly and naturally, with appropriate pauses and emphasis. Here is the markdown format for the reflection:

```markdown
---
book: <book name, required>
author: <author name, required>
part: <part name, or chapter, optional>
title: <youtube seo friendly title, recommended>
thumbnail: <optional thumbnail image, recommended>
description: |
  <youtube seo friendly description, recommended>
  <hash tags, recommended>
---
## <heading session opening>
![](img-1.jpg)
<!-- image_prompt:
A crowded Edwardian London railway station...
Cartoon cinematic, oil painting, vintage Victorian palette.
Full-HD resolution, 16:9 aspect ratio. No text.
-->
Hello, and welcome...

## <heading session 1>
![](img-2.jpg)
<!-- image_prompt: ...-->
The rabbit is a symbol of...

## <other remaining heading sessions>
![](img-x.jpg)
<!-- image_prompt: ...-->
...

## <closing session>
![](img-x.jpg)
<!-- image_prompt: ...-->
...
```

Each session should also have a prompt for creating an image that visually represents the content of that session. The image prompt should be descriptive and specific, capturing the essence of the reflection and the themes discussed in that section. The image should be consistent with the overall tone and style of the whole reflection, and should enhance the viewer's understanding and engagement with the content. The image prompt should be written in a way that it can be easily understood by an AI image generation tool, and should include details such as colors, composition, and any relevant symbols or motifs.
