document.documentElement.dataset.popup = 'ready'
chrome.storage.local.get({ visits: 0 }).then(({ visits }) => {
  document.getElementById('visits').textContent = `${visits} visits`
})
