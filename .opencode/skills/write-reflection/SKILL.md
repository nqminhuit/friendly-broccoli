---
name: write-reflection
description: Write, revise or review reflections/video scripts, metadata, image prompts and music cues.
---

1. Use `../../../reflections/README.md`: `Format` and `Spoilers and visuals` for authoring/review; `Pipeline` only for builds/publishing. Read sections only if missing from context or changed.

2. Confirm work, author, part, filename and spoiler scope; ask about missing/unclear requirements, how many sections the reflection should have. Check `../../../reflections/` for generated-name collisions. If you're not certain about the story arc, ask for clarification or do some web research to get more context, don't presume or guess.

3. Write as a warm, conversational literary critic for general viewers: themes, characters, writing style, simple vocabulary, natural spoken paragraphs. Use opening, thematic sections, conclusion and closing; duration should be 10 to 15 minutes. Include relevant anecdotes without inventing user experiences. Don't copy the same anecdotes or examples or content from other reflections, each reflection should be unique experience for the audience.

4. Apply the README template:
    - Keep metadata, narration and image references in `reflections/<name>.md`.
    - Put the dedicated thumbnail prompt and every section image prompt in `reflections/<name>-prompts.txt`. Each entry is a PNG filename on its own line, followed immediately by its prompt; separate entries with a blank line. Filenames must match the basenames of the Markdown image/thumbnail references.
    - Write SEO metadata and specific, consistent image prompts with the full chosen style in each.
    - There are 11 shared spoiler-warning images and 17 shared closing images already genereated. So to make each video unique choose a random-number x from 1 to 11 for `spoiler_warning_<x>.png` image and a random-number y from 1 to 17 for `closing_<y>.png` image.
    - Silence always uses an explicit standalone `[Pause:<N>s]` cue, with positive finite integer or decimal seconds and a required lowercase `s`, such as `[Pause:1s]`, `[Pause:5s]` or `[Pause:1.5s]`. Times round to the nearest millisecond; zero-rounded or unrenderable durations are invalid. Bare `[Pause]` is invalid and has no default; use `[Pause:3s]` when retaining an old three-second pause.
    - Keep timed pause cues adjacent to spoken text in the same image run, never inside sentences, metadata or image prompts. Their inserted silence is independent of narration speed; include the sum of rendered, millisecond-rounded durations in the runtime.
    - Include a spoken opening warning only for spoiler reflections, followed immediately by a standalone music cue. Do not add a spoken spoiler notice to spoiler-free reflections. Avoid revealing spoilers too soon, and keep spoilers out of metadata, thumbnails and pre-warning images.
    - Do not add a spoken spoiler notice to a spoiler-free reflection. Avoid revealing spoilers too soon, and keep spoilers out of metadata, thumbnails and pre-warning images.
    - Identify eligible multiword person or place names in the spoken narration body and populate the optional `tts_names: |` frontmatter block (see README Format): one exact name per line, in normal spelling (e.g. `Israel Gow`, not `IsraelGow`). Allow uppercase dotted initials with at least one full word (`G. K. Chesterton`, `John F. Kennedy`), preserving periods and normal spacing; no other punctuation except inner hyphens and apostrophes is allowed. Include only names actually spoken; exclude ordinary capitalized phrases, book/chapter titles (a person's name inside a title is fine, the whole title is not), ALL-CAPS words, acronyms, standalone initialisms, bare initials, all-initial names and uncertain matches. Don't invent spellings or pronunciations. Omit the block only when no eligible names apply. Never write joined names into the Markdown body, metadata, SEO fields or image prompts. New metadata and dotted-initial entries require matching sec10v support deployed before building.

5. Select music cues using `book_reflection_music_metadata.json` from `sec10v/resources/music/` (ask if you don't know where sec10v is):
    - Read the metadata and choose from `tracks[].segments[]`. Do not invent tracks, filenames, timestamps or musical characteristics.
    - Select music based primarily on the emotional tone, themes and storytelling purpose of the surrounding narration, rather than just the overall genre.
    - Consider each track's `moods`, `storytelling_tags`, `description`, `energy`, `instrumentation` and `musical_characteristics`. For individual excerpts, prioritize `mood`, `purpose`, `description` and `speech_friendly`.
    - Prefer excerpts between 8 and 15 seconds, using their exact `start_seconds` and `end_seconds`. Respect musical phrase boundaries identified in the metadata.
    - Use the exact format `[Music:<filename>:start=<N>s:end=<N>s:fade-in=1s:fade-out=2s]`, taking `<filename>` from the track's `filename` field.
    - Music cues are standalone interludes, never played under narration. Place them between paragraphs or sections, never inside sentences, metadata or image prompts.
    - For spoiler reflections, insert a music cue immediately after the spoken spoiler warning, replacing any timed pause cue there. Begin spoiler discussion only after the music ends. Choose a segment that creates a natural transition into the discussion.
    - For spoiler-free reflections, optionally insert a music cue at a meaningful narrative transition if it enhances the storytelling.
    - End every reflection with a standalone music outro after the final spoken paragraph. Choose a segment whose mood complements the conclusion, preferably with a natural musical resolution. Allow an ending in silence only when it is more emotionally appropriate.
    - Avoid repeatedly selecting the same track or excerpt across reflections when suitable alternatives exist, but prioritize narrative fit over variety. Consult existing reflections when checking reuse.
    - Keep music cues in the narration Markdown only, not in the companion image prompt file.
    - If the music metadata is missing, invalid or has no suitable segment, report the problem rather than fabricating a cue.
    - For spoiler-warning music, prefer segments whose `narrative_roles` contains `spoiler_transition`. For closing music, prefer `closing`. Consider the track's `cue_role_guidance`, prioritizing `strong` fits over `conditional` fits when equally appropriate. Always match the music to the surrounding narration; never select solely by role.
    - `speech_friendly` indicates compatibility with simultaneous narration, not overall musical suitability. Since music cues are standalone interludes, do not penalize or exclude segments with `low` or `low_medium` values. Prioritize emotional fit, narrative role, musical phrasing and natural transitions.

6. Check metadata, duration, spoiler scope/warning, formatting, first image, companion prompt-file coverage, prompts/style/thumbnail consistency, filename matches and uniqueness, placeholders, secrets and image availability. Validate every pause's explicit duration and standalone placement; reject bare or malformed pause cues, and count the rendered, millisecond-rounded durations. Validate all music cues against the metadata: exact filename, segment timestamps, track duration, and fade durations. Ensure spoiler reflections have a post-warning music cue and every reflection has an appropriate closing music cue, unless an intentional silent ending is justified. Ensure no narration follows the closing music cue. Check `tts_names` in both directions: if eligible names are spoken but the block is missing, add it; if the block is present, check that every entry is an exact person or place name spoken in the narration, none is missing, no entry is invalid or not a name, and normal spacing is kept.

7. Work on the main branch. Preserve existing voices/settings. Do not commit, push, dispatch or publish.

8. When done, perform review and revise the reflection in 2 rounds: first round for clarity, flow, and engagement. The second round for ensuring the reflection follows the story arc, maintains a warm and conversational tone. Review music cue placement during both rounds and change the selected segment if the narrative changes significantly. In both rounds, check that `tts_names` is present when eligible names are spoken and that any existing list still matches the narration.
