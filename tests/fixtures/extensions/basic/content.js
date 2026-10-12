// Marks each page it runs on, so a test can see that it ran (and in which profile's tab).
document.documentElement.dataset.orbitTestExtension = chrome.runtime.id
// Its storage: a test checks that removing the extension deletes it (EX-08).
chrome.runtime.sendMessage({ type: 'visit', url: location.href }).catch(() => {})
