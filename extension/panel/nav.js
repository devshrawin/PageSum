// Tab bar (spec 14): WAI-ARIA tabs for Page / Tools / Guide / Compare / History. No other module knows how tabs
// are drawn; they ask currentTab() and listen with onTabChange().
import { $ } from './dom.js';

export const TABS = ['page', 'tools', 'guide', 'compare', 'history'];
let current = 'page';       // remembered while the panel is open
const listeners = [];

export const currentTab = () => current;
export const onTabChange = (fn) => { listeners.push(fn); };

export function setTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) return;
  current = name;
  for (const t of TABS) {
    const tab = $('tab-' + t);
    const on = t === name;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    $('panel-' + t).hidden = !on;
  }
  if (focus) $('tab-' + name).focus();
  for (const fn of listeners) fn(name);
}

export function initNav() {
  for (const t of TABS) {
    $('tab-' + t).addEventListener('click', () => setTab(t));
  }
  // Arrow keys move between tabs, Home and End jump to the ends (automatic activation).
  $('tabbar').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(current);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next], { focus: true });
  });
  setTab('page');
}

// Views that replace the whole content of Page, Tools and Guide. Compare and History stay usable.
// Returns the sentence to show, or null when the tab has a page to work on.
export function blockedReason(st) {
  if (!st) return 'Open a web page to use PageSum here.';
  switch (st.view) {
    case 'needKey': return 'Add your Gemini API key on the Page tab first.';
    case 'restricted': return st.restrictedReason || "Chrome doesn't let extensions read this page.";
    case 'needAccess': return "PageSum can't read this tab yet. Allow access on the Page tab.";
    case 'empty': return 'Not enough readable text on this page.';
    default: break;
  }
  if (!st.page && st.view === 'init') return 'Reading page...';
  if (!st.page) return 'This page has not been read yet.';
  return null;
}
