// PHASE 4 — Provider dispatch.
//
// Mirrors Open WebUI's `generate_chat_completion()`: the single seam through
// which every model call passes. Today it hands straight to
// `providers.streamChat` (which owns adapter selection and retry/backoff);
// the value of the indirection is that nothing downstream reaches into
// `providers` directly, so cross-cutting concerns have one place to live.
const providers = require('../providers');

/**
 * Runs one model call.
 *
 * @param {object} provider  resolved provider (type selects the adapter)
 * @param {object} formData  { model, messages, tools, temperature, maxTokens }
 * @param {object} ctx       { system, signal, onToken, onStatus }
 * @returns {Promise<{ text: string, toolCalls: Array }>} this turn's output only
 */
async function generateChatCompletion(provider, formData, ctx = {}) {
  return providers.streamChat(provider, {
    history: formData.messages,
    tools: formData.tools,
    system: ctx.system,
    signal: ctx.signal,
    onToken: ctx.onToken,
    onStatus: ctx.onStatus,
    onReasoning: ctx.onReasoning
  });
}

module.exports = { generateChatCompletion };
