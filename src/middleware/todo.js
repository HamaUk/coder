// The agent's own task list — the "am I actually finished?" signal the loop uses
// to decide whether to keep working.
//
// This is the mechanism behind working a project through to the end rather than
// stopping after a tool call or two: the model keeps an explicit checklist via
// the `update_todos` tool, and runToolLoop will not let the turn end while that
// checklist still has open items (up to its auto-continue budget).
//
// Keyed by an opaque `todoKey` rather than by chat, so two chats streaming at
// once each get their own scratch list and can never share one.
//
// A model that never calls the tool behaves exactly as it did before — the list
// stays empty, and an empty list is never a reason to continue.

const lists = new Map();

const MAX_ITEMS = 40;
const MAX_TEXT = 240;
const MAX_LISTS = 64; // bound the map: keys are per-run and must not accumulate
const STATUSES = ['pending', 'in_progress', 'completed'];

function normalize(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const raw of items.slice(0, MAX_ITEMS)) {
    if (!raw) continue;
    const text = String(typeof raw === 'string' ? raw : (raw.text ?? raw.task ?? raw.title ?? '')).trim();
    if (!text) continue;
    const status = STATUSES.includes(raw.status) ? raw.status : 'pending';
    out.push({ text: text.slice(0, MAX_TEXT), status });
  }
  return out;
}

/**
 * Starts a fresh list for this run. Called by the loop before its first model
 * call, so a previous turn's list can never leak into this one.
 */
function begin(key) {
  if (!key) return;
  if (!lists.has(key) && lists.size >= MAX_LISTS) {
    // Oldest key wins the eviction — every list here belongs to a finished run.
    const oldest = lists.keys().next();
    if (!oldest.done) lists.delete(oldest.value);
  }
  lists.set(key, []);
}

function end(key) {
  if (key) lists.delete(key);
}

function set(key, items) {
  if (!key) return;
  const normalized = normalize(items);
  if (!lists.has(key) && lists.size >= MAX_LISTS) {
    const oldest = lists.keys().next();
    if (!oldest.done) lists.delete(oldest.value);
  }
  lists.set(key, normalized);
}

function snapshot(key) {
  return key ? (lists.get(key) || []).slice() : [];
}

function openItems(key) {
  return snapshot(key).filter(i => i.status !== 'completed');
}

/** Renders the open items as the bullet list used in continuation nudges. */
function renderOpen(key) {
  return openItems(key)
    .map(i => `- [${i.status === 'in_progress' ? 'in progress' : 'pending'}] ${i.text}`)
    .join('\n');
}

module.exports = { begin, end, set, snapshot, openItems, renderOpen, MAX_ITEMS };
