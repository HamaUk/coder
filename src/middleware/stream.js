// PHASE 5 — Stream handling.
//
// Mirrors Open WebUI's `streaming_chat_response_handler` role: it drives one
// streamed model call and returns a normalized `{ text, toolCalls }` to the
// loop, with token/status deltas routed to the caller's event sink.
//
// Note on where normalization lives: in Open WebUI this layer also accumulates
// `delta.tool_calls` across chunks. HAMA's provider adapters already do that
// per-protocol and return a normalized shape, so this module stays thin and the
// shared accumulation bookkeeping sits in ./tool-calls.js instead. Splitting it
// that way keeps the four adapters' protocol parsing untouched.
const { generateChatCompletion } = require('./dispatch');
const { ToolCallAccumulator, assembleCalls } = require('./tool-calls');

/**
 * Runs one streamed turn.
 *
 * @param {object} provider
 * @param {object} formData   { model, messages, tools, temperature, maxTokens }
 * @param {object} ctx        { system, signal }
 * @param {object} hooks      { onToken(text), onStatus(text) }
 * @returns {Promise<{ text: string, toolCalls: Array }>}
 */
async function streamBodyHandler(provider, formData, ctx = {}, hooks = {}) {
  return generateChatCompletion(provider, formData, {
    system: ctx.system,
    signal: ctx.signal,
    onToken: hooks.onToken,
    onStatus: hooks.onStatus,
    onReasoning: hooks.onReasoning
  });
}

module.exports = { streamBodyHandler, ToolCallAccumulator, assembleCalls };
