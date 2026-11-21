// Panel -> page agent channel (spec 6.1) and injection. No DOM, no panel state.
// The agent has no inbound listener: every command is a chrome.scripting.executeScript call.

// Injected together, in this order, as classic scripts. Phase 3 appends 'content/guide.js'.
export const CONTENT_FILES = ['content/core.js', 'content/extract.js', 'content/highlight.js', 'content/media.js'];
export const CSS_FILES = ['content/agent.css'];

// Returns one entry per frame that answered: { frameId, ok, data?, error? }.
export async function callAgent(tabId, name, args, { frameIds, allFrames } = {}) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: !!allFrames };
  const out = await chrome.scripting.executeScript({
    target,
    func: (n, a) => (globalThis.__PageSum ? globalThis.__PageSum.call(n, a) : { ok: false, error: { code: 'no_agent' } }),
    args: [name, args ?? {}],
  });
  return out.map((r) => ({ frameId: r.frameId, ...(r.result || { ok: false, error: { code: 'no_result' } }) }));
}

async function inject(target) {
  await chrome.scripting.executeScript({ target, files: CONTENT_FILES });
  await chrome.scripting.insertCSS({ target, files: CSS_FILES });
}

// Makes sure the agent is in the tab. Throws when the tab can't be read at all (no activeTab grant and no host
// permission, or a restricted page). With allFrames it tries every frame first; if Chrome refuses because some
// frames are not permitted (unverified, spec 18.8) it falls back to the main frame and reports { skipped: true }.
export async function ensureAgent(tabId, { allFrames = false } = {}) {
  try {
    const r = await callAgent(tabId, 'ping', {}, allFrames ? { allFrames: true } : { frameIds: [0] });
    if (r.length && r.every((x) => x.ok)) return { frames: allFrames, skipped: false };
  } catch { /* not injected yet, or no access: injecting below throws if there is truly no access */ }
  if (allFrames) {
    try {
      await inject({ tabId, allFrames: true });
      return { frames: true, skipped: false };
    } catch { /* fall back to the main frame */ }
    await inject({ tabId, allFrames: false });
    return { frames: false, skipped: true };
  }
  await inject({ tabId, allFrames: false });
  return { frames: false, skipped: false };
}
