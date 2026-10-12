# cim — CI Management

cim is a standalone Manifest V3 browser extension for a read-only overview of GitHub Actions runs across multiple GitHub account/repository profiles. The dashboard combines profiles, labels each run with its profile, and filters loaded runs by profile, repository, workflow, branch, and status. It links to the existing GitHub run page. This stage does not dispatch workflows, rerun jobs, show live logs, or monitor in the background.

## Install and configure

1. Load the `cim/` directory as an unpacked extension in Brave or Chrome (`chrome://extensions`, enable Developer mode, then **Load unpacked**).
2. Open the cim toolbar action and create a connection profile (for example, Personal or Work). Give each profile its own repositories and GitHub personal access token; the same repository can appear in different profiles.
3. Use a fine-grained PAT with **Actions: read-only** access on every repository in that profile. Later workflow forms may need Contents: read; future mutating controls may need Actions: write. Never share the token.
4. **Test access** checks the Actions runs endpoint for the selected profile's repositories.

Each profile's PAT is kept in extension session storage by default and is cleared when the browser session ends. **Remember on this device** independently opts that profile into storing the PAT as plaintext in local extension storage; anyone with access to this browser profile can read it. Leaving the password field blank while saving keeps only that profile's current token. **Forget token** clears the selected profile's PAT while retaining its repository list; removing a profile deletes its settings and PAT. Profile names/repositories and the remember choice are stored locally. Opening a private repository's GitHub run page uses the browser's GitHub web session, not the PAT; switch the signed-in GitHub web account there if access requires a different account.

## Monitoring and privacy

The dashboard makes read-only requests to `https://api.github.com` only while it is open and visible. It pauses timers and cancels in-flight requests while hidden or closed. Active runs are refreshed about every 10 seconds, otherwise about every 30 seconds, subject to per-profile GitHub rate limits and repository count. An expired PAT pauses only its profile; inaccessible repositories pause their own automatic reads. Only the newest 30 runs per repository load initially; **Load older runs** follows validated GitHub pagination links. Filters cover loaded history. The service worker only opens/focuses the dashboard and never polls GitHub.

GitHub API responses are kept only in the open dashboard's memory. No external services, analytics, remote scripts, or credentials in URLs are used. Rate limits can temporarily pause refreshes; adjust repository count or wait for GitHub's retry time.

## Tests

Run the focused unit suite with `node --test cim/core.test.cjs` and the browser smoke tests with `node --test cim/e2e.test.mjs` (skips if Chrome is unavailable; set `CHROME` to its executable path). Existing repository unit regressions: `node --test vtelex/telex.test.js vtelex/macros.test.js bcoin/infill.test.js`.
