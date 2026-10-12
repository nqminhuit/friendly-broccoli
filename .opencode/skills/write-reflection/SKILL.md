---
name: write-reflection
description: Write, revise or review reflections/ video scripts, metadata and image prompts.
---

1. Use `../../../reflections/README.md`: `Format` and `Spoilers and visuals` for authoring/review; `Pipeline` only for builds/publishing. Read sections only if missing from context or changed.
2. Confirm work, author, part, filename and spoiler scope; ask about missing/unclear requirements, how many sections the reflection should have. Check `../../../reflections/` for generated-name collisions. If you're not certain about the story arc, ask for clarification or do some web research to get more context, don't presume or guess.
3. Write as a warm, conversational literary critic for general viewers: themes, characters, writing style, simple vocabulary, natural spoken paragraphs. Use opening, thematic sections and closing; stay under 15 minutes including pauses but must be 10 minutes minimum. Include relevant anecdotes without inventing user experiences. Don't copy the same anecdotes or examples or content from other reflections, each reflection should be unique experience for the audience.
4. Apply the README template:
    - keep metadata, narration and image references in `reflections/<name>.md`.
    - Put the dedicated thumbnail prompt and every section image prompt in `reflections/<name>-prompts.txt`. Each entry is a PNG filename on its own line, followed immediately by its prompt; separate entries with a blank line. Filenames must match the basenames of the Markdown image/thumbnail references.
    - Write SEO metadata and specific, consistent image prompts with the full chosen style in each.
    - Include a spoken opening warning only for a spoiler reflection, followed by `[Pause]` before discussing spoilers.
    - Do not add a spoken spoiler notice to a spoiler-free reflection. Avoid revealing spoilers too soon, and keep spoilers out of metadata, thumbnails and pre-warning images.
5. Check metadata, duration, spoiler scope/warning, formatting, first image, companion prompt-file coverage, prompts/style/thumbnail consistency, filename matches and uniqueness, placeholders, secrets and image availability. Ensure no prompts remain embedded in the Markdown script. Report unverified images rather than claiming build readiness.
6. Work on the main branch. Preserve existing voices/settings. Do not commit, push, dispatch or publish.
7. When done, perform review and revise the reflection in 2 rounds: first round for clarity, flow, and engagement. The second round for ensuring the reflection follows the story arc, maintains a warm and conversational tone.
