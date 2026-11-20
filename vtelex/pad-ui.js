// Enter copies the pad's text and closes the window, Esc just closes; telex itself comes from content.js.
const pad = document.getElementById('pad');

function closePad() {
    chrome.tabs.getCurrent((tab) => {
        if (tab) chrome.tabs.remove(tab.id);
        else window.close();
    });
}

pad.addEventListener('keydown', async (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
        closePad();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        // A failed write keeps the window open so the text is not lost.
        try {
            if (pad.value) await navigator.clipboard.writeText(pad.value);
            closePad();
        } catch {
            pad.focus();
        }
    }
});
