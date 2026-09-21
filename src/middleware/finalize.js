// PHASE 7 — Finalize.
//
// Mirrors Open WebUI's `background_tasks_handler` role: once the loop has
// produced its result, this is where the turn is committed — the assistant
// message is appended to the chat, persisted, and the `message_end` payload the
// client waits for is assembled.
//
// Pure extraction from server.js so the route handler ends at "hand off to
// finalize" rather than reaching into the store. The persisted message shape
// (including the `aborted` flag) is unchanged.
const store = require('../store');
const { collapseRepeatedBlocks } = require('./loop');

function chatMeta(c) {
  return {
    id: c.id,
    title: c.title,
    providerId: c.providerId,
    model: c.model || null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: Array.isArray(c.messages) ? c.messages.length : 0
  };
}

/**
 * Assembles the assistant message row for a finished turn.
 *
 * Extracted so the route can still hand the client a complete message when the
 * store write fails: the same shape is used for the saved row and for the
 * in-memory one, so nothing downstream (the transcript renderer, a later copy,
 * a reload) can tell them apart structurally.
 *
 * @param {object} result - { text, toolRuns, reasoning, crewRuns, thinkMs }
 * @param {object} provider - the resolved provider
 * @param {object} [opts] - { aborted, ms }
 * @returns {object} the message row
 */
function buildAssistantMessage(result, provider, { aborted = false, ms = null } = {}) {
  const msg = {
    id: store.uid(),
    role: 'assistant',
    mode: 'direct',
    content: typeof result.text === 'string' ? collapseRepeatedBlocks(result.text) : (result.text || ''),
    toolRuns: result.toolRuns || [],
    reasoning: result.reasoning || '',
    providerId: provider.id,
    model: provider.model,
    ts: Date.now(),
    aborted
  };
  if (Number.isFinite(ms) && ms >= 0) msg.ms = ms;
  if (Number.isFinite(result.thinkMs) && result.thinkMs >= 0) msg.thinkMs = result.thinkMs;
  if (Array.isArray(result.crewRuns) && result.crewRuns.length) msg.crewRuns = result.crewRuns;
  return msg;
}

/**
 * Persists the assistant turn and builds the terminal SSE payload.
 *
 * A message row is only written when there is something to record — matching
 * the previous inline behaviour, where an empty turn (e.g. an abort before any
 * token arrived) leaves no trace in the transcript.
 *
 * The chat is re-read from disk inside the store's write lock rather than
 * written back from the snapshot taken when the request started. A turn can
 * stream for minutes, and writing a stale snapshot back would silently undo
 * anything the user did in the meantime (rename, provider switch, delete) —
 * and would resurrect a chat they deleted mid-reply. If the chat is gone by
 * the time the turn finishes, the turn is simply dropped.
 *
 * @param {object}  args
 * @param {string}  args.chatId    id of the chat this turn belongs to
 * @param {object}  args.result    { text, toolRuns }
 * @param {object}  args.provider  resolved provider (already model-overridden)
 * @param {boolean} [args.aborted] true when the turn was cancelled
 * @param {number}  [args.ms]      wall-clock duration of the turn
 * @returns {Promise<{ assistantMsg: object|null, messageEnd: object }>}
 */
async function finalizeChat({ chatId, result, provider, aborted = false, ms = null }) {
  let assistantMsg = null;
  // Built inside the lock: re-reading the chat afterwards can observe a later
  // transaction and report a `messageCount` that is already out of date.
  let meta = null;

  // The last line of defence against a looping model. `text` may have been
  // assembled from several runs (the lead, up to two repair rounds, a crew
  // relay) or rescued from the raw streamed floor — none of which share the
  // loop's per-iteration buffer. Collapsing adjacent duplicate paragraphs HERE,
  // at the one point where a turn becomes a transcript, means no path can
  // persist the same plan seven times. Non-adjacent repeats are never touched.
  const text = typeof result.text === 'string' ? collapseRepeatedBlocks(result.text) : (result.text || '');

  await store.mutateChats((chats) => {
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return; // deleted while the reply was streaming — do not resurrect it

    const hasContent = text || (result.toolRuns && result.toolRuns.length);
    if (!hasContent) { meta = chatMeta(chat); return; }

    assistantMsg = buildAssistantMessage({ ...result, text }, provider, { aborted, ms });
    chat.messages.push(assistantMsg);
    chat.updatedAt = Date.now();
    meta = chatMeta(chat);
  });

  return {
    assistantMsg,
    messageEnd: {
      message: assistantMsg,
      aborted,
      // null when the chat was deleted mid-turn: the client must not re-insert
      // a conversation the user just removed.
      chat: meta,
      provider: { id: provider.id, name: provider.name, model: provider.model, presetId: provider.presetId }
    }
  };
}

module.exports = { finalizeChat, chatMeta, buildAssistantMessage };
