// The automatic backup's blob maker. A service worker has no
// URL.createObjectURL, and a whole store is too long for a data: URL (Chrome
// caps URLs at 2MB), so the worker hands the JSON here and downloads the blob
// URL that comes back. The worker closes this document once the download is
// done, which frees the blob.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'backup-blob') return;
  sendResponse(URL.createObjectURL(new Blob([message.json], { type: 'application/json' })));
});
