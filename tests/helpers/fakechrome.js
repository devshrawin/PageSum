// A fake chrome.* for panel logic tests. executeScript runs the REAL content scripts inside the fake-DOM vm
// sandboxes (one per tab id), so panel code and agent code are exercised together without a browser.
import vm from 'node:vm';
import path from 'node:path';
import { plain } from './fakedom.js';

// envs: { [tabId]: env from makeEnv() }, tabs: { [tabId]: { id, url, title, windowId, discarded?, active? } }
export function installChrome({ envs = {}, tabs = {}, grant = true, hasTabsPermission = true } = {}) {
  const rec = { permissionRequests: [], tabUpdates: [], injects: [] };
  const permsGranted = { origins: new Set(), permissions: new Set(hasTabsPermission ? ['tabs'] : []) };
  const chrome = {
    runtime: { id: 'ext-id', openOptionsPage() {} },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: {
      get: async (id) => { if (!tabs[id]) throw new Error('No tab'); return tabs[id]; },
      query: async (q) => Object.values(tabs).filter((t) => (q.windowId == null || t.windowId === q.windowId) && (q.active == null || !!t.active === q.active)),
      update: async (id, props) => { rec.tabUpdates.push({ id, props }); if (tabs[id]) Object.assign(tabs[id], props.active ? { active: true } : {}, props.url ? { url: props.url } : {}); return tabs[id]; },
      captureVisibleTab: async () => { throw new Error('no capture in tests'); },
    },
    permissions: {
      async request(req) {
        rec.permissionRequests.push(req);
        const ok = typeof grant === 'function' ? grant(req) : grant;
        if (ok) {
          for (const o of req.origins || []) permsGranted.origins.add(o);
          for (const p of req.permissions || []) permsGranted.permissions.add(p);
        }
        return ok;
      },
      async contains(req) {
        return (req.origins || []).every((o) => permsGranted.origins.has(o)) && (req.permissions || []).every((p) => permsGranted.permissions.has(p));
      },
      async getAll() { return { origins: ['https://generativelanguage.googleapis.com/*', ...permsGranted.origins], permissions: [...permsGranted.permissions] }; },
      async remove(req) { for (const o of req.origins || []) permsGranted.origins.delete(o); return true; },
    },
    scripting: {
      async executeScript({ target, files, func, args }) {
        const env = envs[target.tabId];
        if (!env || env.denied) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
        rec.injects.push({ tabId: target.tabId, files: !!files });
        if (files) { env.load(files.map((x) => path.basename(x))); return [{ frameId: 0, result: null }]; }
        const fn = vm.runInContext(`(${func.toString()})`, env.ctx);
        return [{ frameId: 0, result: plain(await fn(...args)) }];
      },
      async insertCSS() {},
    },
  };
  globalThis.chrome = chrome;
  return { chrome, rec, permsGranted };
}
