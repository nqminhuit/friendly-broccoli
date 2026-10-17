# cim — CI Management

cim is a standalone Manifest V3 browser extension for monitoring GitHub Actions across multiple GitHub account/repository profiles. The combined dashboard labels and filters loaded runs, expands runs to show their jobs and steps, offers explicit rerun-all and rerun-failed controls for completed runs, cancels active runs, and offers a New run form that dispatches `workflow_dispatch` workflows with typed inputs. It does not show live logs or monitor in the background.

## Install

Load the repository's `cim/` directory directly, or download `cim.zip` from the latest [`cim-v*` release](https://github.com/nqminhuit/friendly-broccoli/releases) and extract it into `~/.local/share/cim`.

1. Open `brave://extensions` or `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the directory containing `manifest.json`.
3. Click the cim toolbar icon to open or focus its dashboard.

Requires Chrome 116 or newer: the toolbar finds its open dashboard with `runtime.getContexts`, so no `tabs` permission is needed.

To upgrade, replace the extracted files, reload the extension and reload the dashboard. The first release is published only after the feature branch is merged to master and CI passes.

## Configure account profiles

1. Open **Settings** and create a profile such as Personal or Work, with its own repositories and GitHub PAT. Enter one `owner/repository` per line; the same repository may appear in multiple profiles.
2. For a fine-grained PAT, select the repositories that profile needs and grant **Actions: read** for monitoring. Reruns, cancel and dispatch additionally require **Actions: write**; dispatch forms also require **Contents: read** to load workflow files. Organization policies or SSO may impose additional access requirements.
3. **Test access** checks the Actions runs endpoint for each repository, then **Save** the profile. This read test does not prove that dispatch, rerun or cancel permission is available.

Each profile's PAT is kept in extension session storage by default and is cleared when the browser session ends. **Remember on this device** independently opts that profile into storing the PAT as plaintext in local extension storage; anyone with access to this browser profile can read it. Leaving the password field blank while saving keeps only that profile's current token. **Forget token** clears the selected profile's PAT while retaining its repository list; removing a profile deletes its settings and PAT. Profile names/repositories and the remember choice are stored locally. Opening a private repository's GitHub run page uses the browser's GitHub web session, not the PAT; switch the signed-in GitHub web account there if access requires a different account.

## Use

- Filter loaded history by profile, repository, workflow, branch and result, or search it. The newest 30 runs per repository load first; **Load older runs** browses further. The **Status** menu shows only or hides the checked statuses, and filters (except search) are remembered in this browser.
- Runs use compact, single-line summaries; long labels truncate visually but remain available in full on hover. Narrow windows scroll the run list horizontally. **Jobs** expands a run's current attempt and metadata; active expanded runs refresh, while completed details remain cached until refreshed or reopened. Status and step results reflect GitHub data, not an estimated completion percentage.
- **New run** selects a profile, repository, workflow and branch/tag, defaulting to the repository's default branch. The workflow must declare `workflow_dispatch` on its default branch. **Load inputs** reads the selected ref's YAML and generates string, boolean, number, choice and environment fields. Environment inputs accept a GitHub environment name. Strings preserve multiline text; required `false` and `0` values are valid. The New run dialog is roomier for long prompts: string fields grow from a compact height to about ten lines as their text wraps, and can be dragged taller by hand. Clicking outside the dialog or pressing Escape closes it.
- **Re-run all jobs** or **Re-run failed jobs** repeats an existing run with its original commit, ref and actor permissions. GitHub enforces the 30-day and 50-rerun limits. Dispatch starts a new execution instead.
- **Cancel** on an active run's row sends a normal cancel after confirmation. Steps with `if: always()` still run before the run stops. The row shows "Cancel requested" until GitHub reports the run finished, and the button can be used again after a minute if the run is still going.
- Reruns and cancels are never auto-retried; a duplicate cancel is harmless. Reruns require confirmation, New run starts as soon as you click Start workflow, and both may incur Actions usage charges. Accepted requests are not completed workflows: cim follows the exact dispatched run ID or waits for a rerun's new attempt before displaying its result.
- **Open on GitHub** opens the existing run or job page for logs. Private pages use your browser's signed-in GitHub account, not the PAT; switch web accounts if necessary.

## Monitoring and privacy

The dashboard calls only `https://api.github.com` while open and visible. It pauses timers and aborts requests when hidden or closed. Active runs refresh roughly every 10 seconds, otherwise every 30 seconds, with slower intervals for large repository/job lists or per-profile rate limits. Updates use polling, not instantaneous push events. The service worker only opens/focuses the dashboard; there are no background polls, notifications or backend services.

An expired PAT pauses only its profile. Inaccessible repositories pause automatic reads until explicitly refreshed or reconfigured. Rate limits temporarily pause the affected profile without blocking healthy profiles. Workflow lists are capped at 500 entries and show a truncation notice if incomplete.

Mutation requests are **never automatically retried**. If a connection fails or a sent request is aborted, GitHub may already have accepted it. Check GitHub before using **I checked GitHub; allow another request**. An uncertain dispatch links to its workflow page, never guesses which concurrent run belongs to the request. Fresh dispatched IDs that initially return 404 are retried for a bounded period without blocking the repository.

API responses stay in the open dashboard's memory. There is no browser-sync token storage, analytics, remote code, or credential-bearing URL. YAML parsing uses the pinned local artifact documented in `vendor/README.md`. Only GitHub.com is supported, not GitHub Enterprise Server.

## Release

`.github/workflows/cim.yml` runs unit and mocked Chrome tests for cim changes. On master, passing tests publish `cim-v<manifest version>` with `cim.zip` once per version. Bump `version` in `manifest.json` for subsequent releases. The archive includes all runtime scripts, HTML, CSS, and the vendor parser/license; tests are excluded.

## Tests

```sh
node --test cim/*.test.cjs
mkdir -p /tmp/opencode
node --test cim/e2e.test.mjs
node --test vtelex/telex.test.js vtelex/macros.test.js bcoin/infill.test.js
```

Browser tests load the extension into headless Chrome with mocked GitHub responses; they never use a real PAT or trigger real workflows. They skip when Chrome is absent; set `CHROME` to its executable path. CI runs Chrome without its sandbox where required. No installation or build step is needed.
