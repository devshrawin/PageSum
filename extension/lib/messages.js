// Agent -> panel event envelope (spec 6.2). Pure. The panel takes tabId from sender.tab.id, never from the payload.

const EVENTS = new Set(['navigated', 'guideTargetLost', 'escape']);

export function isTrustedAgentSender(sender, runtimeId) {
  return !!(sender && runtimeId && sender.id === runtimeId &&
    sender.tab && Number.isInteger(sender.tab.id) && Number.isInteger(sender.frameId));
}

export function validateAgentEvent(msg) {
  if (!msg || typeof msg !== 'object') return { ok: false };
  if (msg.v !== 2 || msg.src !== 'pagesum-agent' || msg.type !== 'agent/event') return { ok: false };
  if (typeof msg.event !== 'string' || !EVENTS.has(msg.event)) return { ok: false };
  const d = msg.data && typeof msg.data === 'object' ? msg.data : {};
  if (msg.event === 'navigated') {
    if (typeof d.href !== 'string' || d.href.length > 2048) return { ok: false };
    try { new URL(d.href); } catch { return { ok: false }; }
    return { ok: true, event: 'navigated', data: { href: d.href } };
  }
  if (msg.event === 'guideTargetLost') {
    if (typeof d.elementId !== 'string' || !/^e\d{1,4}$/.test(d.elementId)) return { ok: false };
    return { ok: true, event: 'guideTargetLost', data: { elementId: d.elementId } };
  }
  return { ok: true, event: 'escape', data: {} };
}
