# cim — CI Management

cim is a standalone Manifest V3 browser extension for a read-only overview of GitHub Actions runs. This first stage shows recent run summaries, filtering, and links to the existing GitHub run page. It does not dispatch workflows, rerun jobs, show live logs, or monitor in the background.

## Install and configure

1. Load the `cim/` directory as an unpacked extension in Brave or Chrome (`chrome://extensions`, enable Developer mode, then **Load unpacked**).
2. Open the cim toolbar action, then enter one `owner/repository` per line and a GitHub personal access token.
3. Use a fine-grained PAT with **Actions: read-only** access on every selected repository. Stage 3 workflow forms may need Contents: read; later controls may need Actions: write. Never share the token.
4. **Test access** checks the Actions runs endpoint for each configured repository independently.

The PAT is kept in extension session storage by default and is cleared when the browser session ends. **Remember on this device** opts into storing the PAT as plaintext in the browser's local extension storage; anyone with access to this browser profile can read it. Leaving the password field blank while saving keeps the current token. **Forget token** removes it from both stores. Repository names and the remember choice are stored locally. A private repository's GitHub run page still requires you to sign in to GitHub in that browser; the PAT does not sign the web page in.

## Monitoring and privacy

The dashboard makes read-only requests to `https://api.github.com` only while it is open and visible. It pauses timers and cancels in-flight requests while hidden or closed. Active runs are refreshed about every 10 seconds, otherwise about every 30 seconds, subject to GitHub rate limits. Only the newest 30 runs per repository load initially; **Load older runs** follows validated GitHub pagination links. Search and status filters cover loaded history. The service worker only opens/focuses the dashboard and never polls GitHub.

GitHub API responses are kept only in the open dashboard's memory. No external services, analytics, remote scripts, or credentials in URLs are used. Rate limits can temporarily pause refreshes; adjust repository count or wait for GitHub's retry time.

## Tests

Run the focused unit suite with `node --test cim/core.test.cjs` and the browser smoke tests with `node --test cim/e2e.test.mjs` (skips if Chrome is unavailable; set `CHROME` to its executable path). Existing repository unit regressions: `node --test vtelex/telex.test.js vtelex/macros.test.js bcoin/infill.test.js`.
