// Model presets and list filtering. Pure.

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export const MODEL_PRESETS = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (default, highest free quota)' },
  { id: 'gemini-3.8-flash',      label: 'Gemini 3.8 Flash (better quality, low free quota)' },
  { id: 'gemini-3.6-flash',      label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
  { id: 'gemini-flash-latest',   label: 'Latest Flash (alias, changes over time)' },
];

const EXCLUDE = /image|tts|live|embedding|transcribe|audio|robotics|aqa/i;

export function filterModelList(apiModels) {
  const seen = new Set();
  const ids = [];
  for (const m of Array.isArray(apiModels) ? apiModels : []) {
    if (!m || typeof m.name !== 'string') continue;
    if (!Array.isArray(m.supportedGenerationMethods) || !m.supportedGenerationMethods.includes('generateContent')) continue;
    if (!m.name.startsWith('models/gemini')) continue;
    if (EXCLUDE.test(m.name)) continue;
    const id = m.name.replace(/^models\//, '');
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids.sort((a, b) => {
    const fa = a.includes('flash') ? 0 : 1;
    const fb = b.includes('flash') ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
