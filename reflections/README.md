# Reflection files

Each `reflections/<name>.md` file describes one reflection video: the work it reflects on, the voice,
the title and description, the script, and the image shown over each paragraph. Pushing an added or changed file to
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
title: <youtube seo friendly title, required>
thumbnail: <optional thumbnail image, recommended>
description: |
  <youtube seo friendly description, required>
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
  - `book` and `author` (both required) name the work. `part` is optional and names what the reflection covers, such as a chapter or a passage; it is used in the video's name and description. Each is a single line. Nothing is fetched and no LLM is used: you write the whole file.
  - `voice` is optional and is a file under sec10v's `resources/voices/`.
  - `title` and `description` (both required) are the YouTube SEO.
  - `thumbnail` is optional. Without it, the first image is the thumbnail.
  - `key: value` takes the rest of the line, so a title may contain `:`. `key: |` takes the following lines indented by at least 2 spaces. Any other key is an error.
- **Script**: `## Heading` starts a section, and blank lines separate paragraphs. A line that is exactly `[Pause]` is 3 seconds of silence. The video opens with the script's first words: there is no intro.
- **Images**: a line that is exactly `![](ref)` shows that image from the next paragraph on, until the next image line. Image lines are required, and the first one must come before the first paragraph.
  - Image lines are never read aloud.
  - Every image change starts a new chunk, so avoid very short runs of text under one image (under about 40 words).
  - All images are downloaded before any audio is made, and a missing one fails the run at once.

**File names must be unique under `reflections/`.** The video and its chunks are all named `Reflection.<FileName>` (`gift-of-the-magi.md` becomes `Reflection.GiftOfTheMagi`), so `a/magi.md` and `b/magi.md`, or `the-magi.md` and `the_magi.md`, would overwrite each other. Renaming a file starts a fresh name.

**This repo is public.** Write each image `ref` as a name relative to the image bucket (for example `magi-1.jpg`). It is resolved against the `IMAGE_BASE_URL` secret, so the bucket's address never appears here. Never paste a bucket or presigned URL into a file.

## Video effects

Reflection videos use **30 FPS with gentle Ken Burns motion by default**: roughly 5% zoom and subtle
pans, alternating direction between images. Each move spans the image's full narration, continuing
across audio chunks without restarting. No opt-in flag or changes to your reflection file are needed.

Fades, dissolves and smooth left/right wipes alternate at image changes. Transitions last 1 second;
the video fades from black over its first second and to black over its final 1.5 seconds. These effects
change only the visuals, not narration or chapter timing.

Adjust `VIDEO_FRAMERATE`, `CROSSFADE_SECONDS`, `TRANSITION_STYLE`, `FADE_IN_SECONDS` and
`FADE_OUT_SECONDS` in `.github/workflows/sec10v_reflection.yml`. Existing videos need a new build to
pick up the settings.

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
