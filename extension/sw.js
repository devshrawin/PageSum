// Service worker (spec section 5): deliberately tiny. No network, no timers, no message listener, no state.
// sidePanel.open() is called FIRST and synchronously, so the click's user gesture is still valid.
import { migrateStorage } from './lib/storage.js';

chrome.runtime.onInstalled.addListener(() => { migrateStorage().catch(() => {}); });

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  chrome.storage.session.set({ activeTabGrant: { tabId: tab.id, at: Date.now() } }).catch(() => {});
});
