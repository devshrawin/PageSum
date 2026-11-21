// Response schemas for the structured actions (guide, quick actions, form helper, compare) and the normalisers
// that clean a validated answer. Pure. Schemas follow spec sections 9.2, 10 and 11.

const SOURCES = { type: 'array', items: { type: 'string' }, maxItems: 3 };
const NULL_STRING = { type: ['string', 'null'] };

export const GUIDE_SCHEMA = {
  type: 'object', required: ['feasible', 'summary', 'steps'], additionalProperties: false,
  properties: {
    feasible: { type: 'boolean' },
    summary: { type: 'string' },
    steps: {
      type: 'array', maxItems: 12,
      items: {
        type: 'object', additionalProperties: false, required: ['elementId', 'action', 'instruction', 'caution'],
        properties: {
          elementId: NULL_STRING,
          action: { type: 'string', enum: ['click', 'type', 'select', 'check', 'scroll', 'read', 'wait'] },
          instruction: { type: 'string' },
          valueHint: NULL_STRING,
          caution: { type: ['string', 'null'], enum: ['destructive', 'payment', 'personal_data', 'external', null] },
        },
      },
    },
  },
};

export const ACTION_ITEMS_SCHEMA = {
  type: 'object', required: ['items', 'dates'], additionalProperties: false,
  properties: {
    items: {
      type: 'array', maxItems: 50,
      items: {
        type: 'object', required: ['task', 'owner', 'due', 'dueText', 'sources'], additionalProperties: false,
        properties: { task: { type: 'string' }, owner: NULL_STRING, due: { type: ['string', 'null'], format: 'date' }, dueText: NULL_STRING, sources: SOURCES },
      },
    },
    dates: {
      type: 'array', maxItems: 50,
      items: {
        type: 'object', required: ['date', 'text', 'what', 'sources'], additionalProperties: false,
        properties: { date: { type: ['string', 'null'], format: 'date' }, text: { type: 'string' }, what: { type: 'string' }, sources: SOURCES },
      },
    },
  },
};

export const QUIZ_SCHEMA = {
  type: 'object', required: ['cards', 'quiz'], additionalProperties: false,
  properties: {
    cards: {
      type: 'array', maxItems: 20,
      items: { type: 'object', required: ['q', 'a', 'sources'], additionalProperties: false, properties: { q: { type: 'string' }, a: { type: 'string' }, sources: SOURCES } },
    },
    quiz: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', required: ['q', 'choices', 'answer', 'why', 'sources'], additionalProperties: false,
        properties: {
          q: { type: 'string' },
          choices: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4 },
          answer: { type: 'integer', minimum: 0, maximum: 3 },
          why: { type: 'string' },
          sources: SOURCES,
        },
      },
    },
  },
};

export const FORM_SCHEMA = {
  type: 'object', required: ['fields'], additionalProperties: false,
  properties: {
    fields: {
      type: 'array', maxItems: 80,
      items: {
        type: 'object', required: ['elementId', 'explanation', 'format', 'draft'], additionalProperties: false,
        properties: { elementId: { type: 'string' }, explanation: { type: 'string' }, format: NULL_STRING, draft: NULL_STRING },
      },
    },
  },
};

export const TABLE_SCHEMA = {
  type: 'object', required: ['columns', 'rows'], additionalProperties: false,
  properties: {
    columns: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
    rows: {
      type: 'array', maxItems: 200,
      items: {
        type: 'object', required: ['cells', 'sources'], additionalProperties: false,
        properties: { cells: { type: 'array', items: { type: ['string', 'null'] } }, sources: SOURCES },
      },
    },
    notes: NULL_STRING,
  },
};

export const COMPARE_SCHEMA = {
  type: 'object', required: ['criteria', 'summary', 'verdict'], additionalProperties: false,
  properties: {
    criteria: {
      type: 'array', minItems: 1, maxItems: 15,
      items: {
        type: 'object', required: ['name', 'values'], additionalProperties: false,
        properties: {
          name: { type: 'string' },
          values: {
            type: 'array',
            items: {
              type: 'object', required: ['tab', 'value', 'sources'], additionalProperties: false,
              properties: { tab: { type: 'string', enum: ['t1', 't2', 't3', 't4'] }, value: NULL_STRING, sources: SOURCES },
            },
          },
        },
      },
    },
    summary: { type: 'string' },
    verdict: NULL_STRING,
  },
};

/* ---------- normalisers ---------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const keepSources = (sources, resolve) => (Array.isArray(sources) ? sources : []).filter((id) => resolve && resolve(id)).slice(0, 3);
const cap = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);

// Caps lengths. Dropping steps that name unknown elements is lib/guidecore.js validatePlan.
export function normalizeGuide(plan) {
  return {
    feasible: !!plan.feasible,
    summary: cap(plan.summary, 400),
    steps: plan.steps.slice(0, 12).map((s) => ({
      elementId: s.elementId,
      action: s.action,
      instruction: cap(s.instruction, 300),
      valueHint: s.valueHint == null ? null : cap(s.valueHint, 120),
      caution: s.caution == null ? null : s.caution,
    })),
  };
}

// Dates that aren't YYYY-MM-DD become null (the original wording stays in text / dueText). Sources must resolve.
export function normalizeActionItems(data, resolve) {
  const date = (d) => (typeof d === 'string' && ISO_DATE.test(d) ? d : null);
  return {
    items: data.items.map((it) => ({ ...it, due: date(it.due), sources: keepSources(it.sources, resolve) })),
    dates: data.dates.map((d) => ({ ...d, date: date(d.date), sources: keepSources(d.sources, resolve) })),
  };
}

export function normalizeQuiz(data, resolve) {
  return {
    cards: data.cards.map((c) => ({ ...c, sources: keepSources(c.sources, resolve) })),
    quiz: data.quiz.map((q) => ({ ...q, sources: keepSources(q.sources, resolve) })),
  };
}

// fields: FieldInfo[] from the page scan. Unknown ids are dropped; sensitive fields never get a draft.
export function normalizeForm(data, fields) {
  const byId = new Map((fields || []).map((f) => [f.id, f]));
  return {
    fields: data.fields
      .filter((f) => byId.has(f.elementId))
      .map((f) => ({
        elementId: f.elementId,
        explanation: cap(f.explanation, 400),
        format: f.format == null ? null : cap(f.format, 200),
        draft: byId.get(f.elementId).sensitive ? null : (f.draft == null ? null : cap(f.draft, 500)),
      })),
  };
}

// Pads or trims every row to the number of columns, trims cells to 500 chars and makes column names unique.
export function rectangularize(data, resolve) {
  const seen = new Map();
  const columns = data.columns.map((raw) => {
    const name = String(raw).trim().slice(0, 100) || 'Column';
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
  const rows = data.rows.map((r) => {
    const cells = [];
    for (let i = 0; i < columns.length; i++) {
      const v = r.cells[i];
      cells.push(v == null ? null : String(v).slice(0, 500));
    }
    return { cells, sources: keepSources(r.sources, resolve) };
  });
  return { columns, rows, notes: data.notes == null ? null : data.notes };
}

// tabKeys: ['t1','t2',..] in selection order. resolve: id -> truthy for valid namespaced ids.
// Values for tabs outside the selection are dropped, sources must carry that tab's prefix and resolve,
// and a tab the model skipped gets a null value.
export function normalizeCompare(data, tabKeys, resolve) {
  const keys = new Set(tabKeys);
  const criteria = data.criteria.map((c) => {
    const byTab = new Map();
    for (const v of c.values) {
      if (!keys.has(v.tab) || byTab.has(v.tab)) continue;
      byTab.set(v.tab, {
        tab: v.tab,
        value: v.value == null ? null : cap(v.value, 500),
        sources: (Array.isArray(v.sources) ? v.sources : []).filter((id) => id.startsWith(v.tab + 'c') && resolve(id)).slice(0, 3),
      });
    }
    return { name: cap(c.name, 120), values: tabKeys.map((k) => byTab.get(k) || { tab: k, value: null, sources: [] }) };
  });
  return { criteria, summary: data.summary, verdict: data.verdict == null ? null : data.verdict };
}
