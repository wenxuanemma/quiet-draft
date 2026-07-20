// The chrome.commands shortcut is only guaranteed to reach the background
// service worker, not the currently-focused new-tab page directly. So we
// flip a storage flag here; every open newtab.html page listens for that
// flag via chrome.storage.onChanged and reacts instantly (storage events
// fire in the same tick across contexts, no polling needed).

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-panic') return;

  const { panicActive } = await chrome.storage.local.get('panicActive');
  await chrome.storage.local.set({ panicActive: !panicActive });
});

// Clicking the toolbar icon on a claude.ai tab toggles the document
// overlay for that specific tab. We key state by tab id (not global)
// since you likely want the overlay off in other tabs/windows even
// while it's on in one claude.ai conversation.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.startsWith('https://claude.ai/')) return;
  if (!tab.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'QD_TOGGLE_OVERLAY' });
  } catch (err) {
    // Content script may not be injected yet (e.g. page just loaded);
    // nothing to do — user can click again once the page is ready.
    console.warn('Quiet Draft: could not reach content script on this tab', err);
  }
});
