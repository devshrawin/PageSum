// Side panel bootstrap: wires the UI modules together and starts tab following.
import { getSettings } from './lib/storage.js';
import { redactKey } from './lib/errors.js';
import { $ } from './panel/dom.js';
import { app, initTabs, shownState, load } from './panel/tabs.js';
import { initPage, renderState, setTitle, startSummary, startVision, abortUi, updateModelLabel } from './panel/page.js';

function logError(err) {
  console.error(redactKey(String((err && err.message) || err)));
}

async function init() {
  initPage();
  try {
    app.settings = await getSettings();
  } catch (err) {
    logError(err);
    $('restrictedText').textContent = 'Could not read settings.';
    $('view-init').hidden = true;
    $('view-restricted').hidden = false;
    return;
  }

  // Settings changed in the options page: pick them up, and start as soon as a key appears.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    try {
      const was = app.settings;
      app.settings = await getSettings();
      updateModelLabel();
      const st = shownState();
      if (st && st.view === 'needKey' && app.settings.apiKey && !(was && was.apiKey)) load(st.tabId);
    } catch (err) { logError(err); }
  });

  // Aborting everything when the panel closes needs no code: the panel's JS context ends with it.
  await initTabs({ render: renderState, setTitle, startSummary, startVision, abortUi });
}

init().catch(logError);
