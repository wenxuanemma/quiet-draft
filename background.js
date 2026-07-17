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
