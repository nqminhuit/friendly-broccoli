// Edits the shortcut list kept in chrome.storage.local; open tabs pick up changes right away.
const MACROS = 'macros';
const { DEFAULT_MACROS, parseMacros } = globalThis.vtelexMacros;
const box = document.getElementById('macros');
const status = document.getElementById('status');

function show(message) {
    status.textContent = message;
    setTimeout(() => { status.textContent = ''; }, 2000);
}

chrome.storage.local.get(MACROS, (r) => { box.value = r[MACROS] ?? DEFAULT_MACROS; });

document.getElementById('save').addEventListener('click', async () => {
    await chrome.storage.local.set({ [MACROS]: box.value });
    show(`Saved ${parseMacros(box.value).size} shortcuts`);
});

document.getElementById('reset').addEventListener('click', async () => {
    await chrome.storage.local.remove(MACROS);
    box.value = DEFAULT_MACROS;
    show('Reset to defaults');
});
