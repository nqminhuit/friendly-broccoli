---
name: write-reflection
description: Write, revise, or review literary reflection video scripts in reflections/, including YouTube metadata, and section image prompts.
---

# Write a reflection

## 1. Read the requirements

- Read `../../../reflections/README.md` before editing; it is the source of truth for format and pipeline behavior. Paths below are relative to the repository root, three directories above this skill.
- Confirm the book, author, optional chapter or passage (`part`), and destination filename. Ask if required information is missing and cannot be reliably inferred.
- Determine whether the reflection is spoiler-free or spoiler-inclusive from the requested scope. Ask before including major spoilers if the intended scope is unclear; spoilers, including the ending, are allowed when requested or needed for the agreed reflection scope.
- Inspect existing files under `reflections/` for naming collisions and context. Generated names must be unique across subdirectories: `gift-of-the-magi.md` becomes `Reflection.GiftOfTheMagi`, and `the-magi.md` and `the_magi.md` collide. Renaming starts a fresh video name.

## 2. Write the script

- Write the complete reflection; the workflow does not fetch the work or use an LLM to generate narration.
- Act as a senior literary critic speaking to a general YouTube audience. Be engaging and insightful, with a warm, friendly, conversational tone.
- Discuss themes, characters, and writing style. Give context that encourages viewers to read the work, matching plot and ending discussion to the agreed spoiler scope rather than treating all reflections as spoiler-free.
- For spoiler-inclusive reflections, give a clear spoken warning in the opening narration before any spoilers. State whether the ending will be discussed without revealing it in the warning. A heading or description alone is not enough; viewers must hear the warning before the discussion.
- Do not reveal twists in titles, descriptions, thumbnails, or images shown before the spoken warning.
- Use simple vocabulary rather than complex literary jargon. Include relevant personal observations or anecdotes without inventing experiences for the user.
- Use an opening, thematic sections, and a closing, each introduced by `## Heading`. The video starts with the script's own first words; no separate introduction is added by the pipeline.
- Separate paragraphs with blank lines so they read naturally aloud. A standalone `[Pause]` adds exactly three seconds of silence. Estimate narration duration, including pauses, and keep it under 15 minutes.

## 3. Add metadata and illustrations

- Start the file with front matter between two `---` lines. Required keys are `book`, `author`, `title`, and `description`; optional keys are `part`, `voice`, and `thumbnail`. Any other key is an error.
- Follow the README's format rules: `title` and `description` are required even though its prompt example labels them recommended.
- Keep `book`, `author`, and `part` on single lines. `key: value` takes the rest of the line, so titles may contain `:`. Use `description: |` followed by lines indented at least two spaces for the YouTube SEO-friendly description and recommended hashtags; write an SEO-friendly title as well.
- Preserve an existing voice unless asked to change it. An optional `voice` names a file under sec10v's `resources/voices/`. A thumbnail is recommended but optional; without one, the first image becomes the thumbnail.
- Give each section a standalone `![](ref)` line and an `<!-- image_prompt: ... -->` comment. Put the first image before narration. Each image stays on screen until the next image line; image lines are not spoken.
- Describe a specific scene, colors, composition, and relevant symbols or motifs in each prompt. Keep visual style and tone consistent, with Full-HD resolution, a 16:9 aspect ratio, and no text in the illustrations.
- Avoid runs of narration shorter than about 40 words per image; each image change starts a new audio chunk.
- Use only bucket-relative image and thumbnail names, never bucket or presigned URLs. The repository is public; do not include credentials or secret values.
- Images resolve against the `IMAGE_BASE_URL` secret and must exist before a build. All images are downloaded before audio synthesis; a missing image stops the run. Prompts do not generate images automatically. Report any image availability that could not be verified instead of claiming the file is build-ready.

## Template

Replace all placeholders and image names with actual content. Add thematic sections as needed; omit optional metadata when it is not applicable.

```markdown
---
book: <book name>
author: <author name>
title: <YouTube SEO-friendly title>
thumbnail: <relative image name>
description: |
  <YouTube SEO-friendly description>
  <relevant hashtags>
---
## Opening
![](reflection-1.jpg)
<!-- image_prompt:
<Specific scene, colors, composition, and symbols fitting this section.>
<Consistent visual style. Full-HD resolution, 16:9 aspect ratio. No text.>
-->
<Opening narration, including a spoken spoiler warning if spoilers follow.>

## Themes
![](reflection-2.jpg)
<!-- image_prompt:
<A scene illustrating this section in the same visual style.>
Full-HD resolution, 16:9 aspect ratio. No text.
-->
<Reflection paragraphs.>

## Closing
![](reflection-3.jpg)
<!-- image_prompt:
<A closing scene consistent with the reflection's tone and visual style.>
Full-HD resolution, 16:9 aspect ratio. No text.
-->
<Closing narration within the agreed spoiler scope.>
```

## 4. Review and hand back

- Check required metadata, narration duration, spoiler scope and advance spoken warning placement, paragraph and pause formatting, image placement and prompts, image availability, generated filename collisions, leftover placeholders, and accidental secret disclosure.
- Preserve approved video and narration defaults; effects need no reflection-file flags. Visual settings belong in `.github/workflows/sec10v_reflection.yml`; reflection-only Warmer narration settings are in `.github/workflows/sec10v.yml`. Consult the README for values and regeneration requirements rather than adding unsupported metadata or changing ordinary audiobook settings.
- Do not commit, push, dispatch workflows, or publish unless requested. Pushing reflection changes to `master` starts `.github/workflows/sec10v_reflection.yml`; `[skip ci]` suppresses a run. README and instruction files are excluded.
- If asked to rebuild, dispatch with `file: reflections/<name>.md`; an optional voice override allows a voice test without editing the file.
- Finished videos upload directly to YouTube as **private**, not to the image bucket. Review the video, title, description, chapters, and thumbnail in YouTube Studio before publishing.
