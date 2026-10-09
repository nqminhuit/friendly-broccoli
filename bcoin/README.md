# bcoin

Browser COpilot INline: grey ghost-text suggestions in Brave/Chrome textareas and rich editors from your own [llama.cpp](https://github.com/ggml-org/llama.cpp) server's `/infill` endpoint, the browser sibling of [ecoin](https://github.com/nqminhuit/ecoin). Text goes only to the server you configure, which must be on `127.0.0.1` or `localhost`.

## Install

Download the latest release into `~/.local/share/bcoin` (on the owner's machines, `./lazarus.sh bcoin` from linux-config does the same):

```sh
tag=$(curl -fsSL https://github.com/nqminhuit/friendly-broccoli/releases.atom | grep -o 'releases/tag/bcoin-v[^"<]*' | head -n 1 | sed 's|releases/tag/||')
curl -fsSL -o /tmp/bcoin.zip "https://github.com/nqminhuit/friendly-broccoli/releases/download/$tag/bcoin.zip"
rm -rf ~/.local/share/bcoin && unzip -q /tmp/bcoin.zip -d ~/.local/share/bcoin
```

1. Open `brave://extensions` (or `chrome://extensions`), turn on Developer mode, Load unpacked → `~/.local/share/bcoin`.
2. Right-click the toolbar icon → Options: set the server URL, the API key if the server has one, and the model if the server routes several (a llama.cpp router refuses requests without one). Test connection reports whether the model is loaded.
3. Reload the tabs that were already open.

Start the server with a FIM model, as for ecoin, for example `llama-server --fim-qwen-1.5b-default`.

## Use

- Suggestions are off everywhere until you switch a site on with Alt+Shift+C or the toolbar icon; the badge shows `AI` on such sites and `!` after a server error (hover it for the message). Change the key at `brave://extensions/shortcuts`.
- After a 300 ms pause at the end of a line, the suggestion appears in grey. Tab accepts it, Ctrl+Right accepts the next word, Esc dismisses it, and typing its next characters shrinks it. Anything else clears it.
- Textareas show the whole suggestion, laid out like the field. Rich editors (`contenteditable`: Teams, Slack, Jira, Confluence) show only its first line at the caret, since Enter sends in chat boxes. Tried in the Lexical, ProseMirror, Quill, Draft.js, CKEditor 5 and Slate demos.
- Never in single-line inputs, password fields, or code editors embedded in pages (Monaco, CodeMirror, Ace).
- While an `@mention` or `#issue` list is open (GitHub and similar), Tab belongs to the list and no ghost shows.
- Answers are cached per page, at most one request is in flight per tab, and a failed request pauses suggestions for 10 seconds.
- No suggestion where you expect one? Tick Debug in Options and open the page console (F12): bcoin logs each request, answer, and the reason it skipped or dropped one.

The request matches ecoin's: the 256 lines above as `input_prefix`, the current line up to the caret as `prompt`, the rest and the 64 lines below as `input_suffix`, plus `n_indent`, `n_predict`, `t_max_predict_ms` and the top-k/top-p/infill samplers. The answer is cleaned up with ecoin's rules: leaked FIM tokens, repeats of the following lines, degenerate repetition and closers the text already has are dropped.

## Release

Bump `version` in `manifest.json` and merge to master: `.github/workflows/bcoin.yml` runs the tests and publishes `bcoin-v<version>` with `bcoin.zip`.

## Test

```sh
node --test bcoin/infill.test.js
node --test bcoin/e2e.test.mjs  # bcoin and vtelex in headless Chrome against a fake /infill; skips without Chrome
```
