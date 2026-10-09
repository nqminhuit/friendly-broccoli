# vtelex

Vietnamese telex typing for Brave/Chrome as a browser extension, so no system input method (ibus, fcitx) has to run and desktop keybindings stay untouched. It only acts on bare letter keys in text inputs, textareas and rich editors; anything with Ctrl, Alt or Super passes through.

## Install

Download the latest release into `~/.local/share/vtelex` (on the owner's machines, `./lazarus.sh vtelex` from linux-config does the same):

```sh
tag=$(curl -fsSL 'https://api.github.com/repos/nqminhuit/friendly-broccoli/releases?per_page=100' | jq -r '[.[].tag_name | select(startswith("vtelex-"))][0]')
curl -fsSL -o /tmp/vtelex.zip "https://github.com/nqminhuit/friendly-broccoli/releases/download/$tag/vtelex.zip"
rm -rf ~/.local/share/vtelex && unzip -q /tmp/vtelex.zip -d ~/.local/share/vtelex
```

1. Open `brave://extensions` (or `chrome://extensions`), turn on Developer mode, Load unpacked → `~/.local/share/vtelex`.
2. Reload the tabs that were already open: content scripts only reach pages loaded after the extension.

To upgrade, rerun the download, press the extension's reload button and reload open tabs.

## Release

Bump `version` in `manifest.json` and merge to master: `.github/workflows/vtelex.yml` runs the tests and publishes `vtelex-v<version>` with `vtelex.zip`. Changes that keep the version are tested but not released.

## Use

- Each site remembers its own mode, starting in English: Alt+Space or the toolbar icon switches the current site between Vietnamese and English, and a `VI`/`EN` label flashes in the page corner. The icon's badge shows the current tab's mode. Change the key at `brave://extensions/shortcuts`.
- Telex: `s f r x j` tones, `z` clears the tone, `aa ee oo dd` for â ê ô đ, `w` for ă ơ ư (`uow` → ươ, a lone `w` → ư). Pressing a mark key twice undoes it (`ass` → `as`, `ww` → `w`).
- Marks may come anywhere in the word: `tieengs`, `tieesng` and `tiengse` all give `tiếng`.
- Tones use the old placement (`hòa`, `thúy`, `khỏe`). For `hoà`, pass `{ modernTone: true }` to `step` in `content.js`.
- A word that stops being a Vietnamese syllable reverts to the keys typed (`with`, `windows`, `google` survive), but many short English words convert (`this` → `thí`, `is` → `í`, `was` → `ứa`), as in Unikey. Switch the site to English for those.

## Shortcuts

In VI mode, a shortcut word followed by Space, Enter or any punctuation turns into its text: `ko?` → `không?`, `Ko` → `Không`, `KO` → `KHÔNG`. Edit the list by right-clicking the toolbar icon → Options, one `shortcut = text` per line; it starts with a few (`ko`, `đc`, `nc`, `trc`, `ntn`, ...). Backspace right after an expansion puts the shortcut back (`không ` → `ko `). Shortcuts match the keys as typed, so one like `as` still works even though telex would turn it into `á`. The list lives in that browser only; copy the box to move it.

Works in plain inputs and textareas and in Lexical (the editor behind Messenger and WhatsApp Web), ProseMirror, Quill, Draft.js and CKEditor 5. It can't work in recent Slate editors, which ignore script-made input events, nor in Google Docs and other canvas editors. Password and email fields are skipped.

## Test

```sh
node --test vtelex/telex.test.js vtelex/macros.test.js
node --test vtelex/e2e.test.mjs  # loads the extension into headless Chrome; skips without Chrome
```
