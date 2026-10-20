// Clicking the toolbar icon opens the recorder in its own tab (or focuses it if already open).
// A tab is used instead of a popup because a popup closes as soon as the screen picker
// takes focus, which would kill the recording.
// The tab the icon was clicked on becomes the default tab for console/network logging.
const RECORDER_URL = chrome.runtime.getURL('recorder.html');

chrome.action.onClicked.addListener(async (tab) => {
  const logTab = /^(https?|file):/.test(tab?.url ?? '') ? tab.id : null;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const existing = contexts.find((c) => c.documentUrl?.startsWith(RECORDER_URL));

  if (existing) {
    if (logTab) chrome.runtime.sendMessage({ type: 'log-tab', tabId: logTab }).catch(() => {});
    await chrome.tabs.update(existing.tabId, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: logTab ? `${RECORDER_URL}?tab=${logTab}` : RECORDER_URL });
  }
});
