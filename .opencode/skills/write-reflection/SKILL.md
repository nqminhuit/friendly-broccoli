---
name: write-reflection
description: Write, revise or review reflections/video scripts, metadata, image prompts and music cues.
---

1. Use `../../../reflections/README.md`: `Format` and `Spoilers and visuals` for authoring/review; `Pipeline` only for builds/publishing. Read sections only if missing from context or changed.

2. Confirm work, author, part, filename and spoiler scope; ask about missing/unclear requirements, how many sections the reflection should have. Check `../../../reflections/` for generated-name collisions. If you're not certain about the story arc, ask for clarification or do some web research to get more context, don't presume or guess.

3. Write as a warm, conversational literary critic for general viewers: themes, characters, writing style, simple vocabulary, natural spoken paragraphs. Use opening, thematic sections and closing; stay under 15 minutes including pauses but must be 10 minutes minimum. Include relevant anecdotes without inventing user experiences. Don't copy the same anecdotes or examples or content from other reflections, each reflection should be unique experience for the audience.

4. Apply the README template:
    - Keep metadata, narration and image references in `reflections/<name>.md`.
    - Put the dedicated thumbnail prompt and every section image prompt in `reflections/<name>-prompts.txt`. Each entry is a PNG filename on its own line, followed immediately by its prompt; separate entries with a blank line. Filenames must match the basenames of the Markdown image/thumbnail references.
    - Write SEO metadata and specific, consistent image prompts with the full chosen style in each.
    - Include a spoken opening warning only for spoiler reflections, followed immediately by a standalone music cue. Do not add a spoken spoiler notice to spoiler-free reflections. Avoid revealing spoilers too soon, and keep spoilers out of metadata, thumbnails and pre-warning images.
    - Do not add a spoken spoiler notice to a spoiler-free reflection. Avoid revealing spoilers too soon, and keep spoilers out of metadata, thumbnails and pre-warning images.

5. Select music cues using `../../../reflections/book_reflection_music_metadata.json`:
    - Read the metadata and choose from `tracks[].segments[]`. Do not invent tracks, filenames, timestamps or musical characteristics.
    - Select music based primarily on the emotional tone, themes and storytelling purpose of the surrounding narration, rather than just the overall genre.
    - Consider each track's `moods`, `storytelling_tags`, `description`, `energy`, `instrumentation` and `musical_characteristics`. For individual excerpts, prioritize `mood`, `purpose`, `description` and `speech_friendly`.
    - Prefer excerpts between 8 and 15 seconds, using their exact `start_seconds` and `end_seconds`. Respect musical phrase boundaries identified in the metadata.
    - Use the exact format `[Music:<filename>:start=<N>s:end=<N>s:fade-in=1s:fade-out=2s]`, taking `<filename>` from the track's `filename` field.
    - Music cues are standalone interludes, never played under narration. Place them between paragraphs or sections, never inside sentences, metadata or image prompts.
    - For spoiler reflections, insert a music cue immediately after the spoken spoiler warning, replacing `[Pause]`. Begin spoiler discussion only after the music ends. Choose a segment that creates a natural transition into the discussion.
    - For spoiler-free reflections, optionally insert a music cue at a meaningful narrative transition if it enhances the storytelling.
    - End every reflection with a standalone music outro after the final spoken paragraph. Choose a segment whose mood complements the conclusion, preferably with a natural musical resolution. Allow an ending in silence only when it is more emotionally appropriate.
    - Avoid repeatedly selecting the same track or excerpt across reflections when suitable alternatives exist, but prioritize narrative fit over variety. Consult existing reflections when checking reuse.
    - Keep music cues in the narration Markdown only, not in the companion image prompt file.
    - If the music metadata is missing, invalid or has no suitable segment, report the problem rather than fabricating a cue.

6. Check metadata, duration, spoiler scope/warning, formatting, first image, companion prompt-file coverage, prompts/style/thumbnail consistency, filename matches and uniqueness, placeholders, secrets and image availability. Validate all music cues against the metadata: exact filename, segment timestamps, track duration, and fade durations. Ensure spoiler reflections have a post-warning music cue and every reflection has an appropriate closing music cue, unless an intentional silent ending is justified. Ensure no narration follows the closing music cue.

7. Work on the main branch. Preserve existing voices/settings. Do not commit, push, dispatch or publish.

8. When done, perform review and revise the reflection in 2 rounds: first round for clarity, flow, and engagement. The second round for ensuring the reflection follows the story arc, maintains a warm and conversational tone. Review music cue placement during both rounds and change the selected segment if the narrative changes significantly.
