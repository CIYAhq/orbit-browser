// The service worker: keeps a count of visits in chrome.storage.local, and answers the test's questions.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ installs: 0 }).then(({ installs }) => chrome.storage.local.set({ installs: installs + 1 }))
})

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'visit') {
    chrome.storage.local
      .get({ visits: 0 })
      .then(({ visits }) => chrome.storage.local.set({ visits: visits + 1, last: message.url }))
      .then(() => reply(true))
    return true
  }
  if (message?.type === 'get') {
    chrome.storage.local.get(null).then(reply)
    return true
  }
  return false
})
