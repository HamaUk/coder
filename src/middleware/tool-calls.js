// PHASE 5 (shared helper) — tool-call accumulation.
//
// Each provider adapter receives tool calls over the wire differently, but two
// of them (OpenAI-compatible and Anthropic) share the same shape: fragments
// arrive keyed by an index and must be concatenated across SSE chunks before
// being parsed. This module owns that bookkeeping so the adapters only describe
// their own protocol.
//
// Gemini and LlamaCoder deliver whole, already-complete calls, so they use
// `assembleCalls` for the final assembly step only.

const safeJSON = (s) => { try { return JSON.parse(s); } catch { return { __raw: s }; } };

/**
 * Accumulates streaming tool-call fragments keyed by index.
 *
 * Two entry styles are supported because the protocols differ:
 *   - `appendFragment`  — OpenAI: id/name/args all arrive as fragments
 *   - `openBlock` + `appendArgs` — Anthropic: id/name arrive once at block
 *     start, then only the JSON arguments stream in
 */
class ToolCallAccumulator {
  constructor() {
    this.slots = new Map();
  }

  #slot(index) {
    if (!this.slots.has(index)) this.slots.set(index, { id: '', name: '', args: '' });
    return this.slots.get(index);
  }

  /** OpenAI-style: every field may arrive in fragments and is concatenated. */
  appendFragment(index, { id, name, args } = {}) {
    const slot = this.#slot(index);
    if (id) slot.id += id;
    if (name) slot.name += name;
    if (args) slot.args += args;
    return slot;
  }

  /** Anthropic-style: id/name are set once, at content_block_start. */
  openBlock(index, { id, name } = {}) {
    const slot = this.#slot(index);
    if (id) slot.id = id;
    if (name) slot.name = name;
    return slot;
  }

  /** Anthropic-style: append a partial JSON fragment to an open block. */
  appendArgs(index, partialJson) {
    const slot = this.slots.get(index);
    if (slot) slot.args += partialJson || '';
  }

  /** Raw slots in insertion order. */
  values() {
    return [...this.slots.values()];
  }

  /** Slots that actually name a tool, assembled into calls. */
  toCalls() {
    return this.values()
      .filter(s => s.name)
      .map((s, i) => ({ id: s.id || `call_${i + 1}`, name: s.name, args: safeJSON(s.args || '{}') }));
  }

  /** All slots assembled into calls, regardless of whether they name a tool. */
  toCallsUnfiltered() {
    return this.values()
      .map(s => ({ id: s.id, name: s.name, args: safeJSON(s.args || '{}') }));
  }
}

/** Assembles already-complete calls (Gemini, LlamaCoder). */
function assembleCalls(calls = []) {
  return calls.map(c => ({
    id: c.id,
    name: c.name,
    args: c.args || {},
    ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {})
  }));
}

module.exports = { ToolCallAccumulator, assembleCalls, safeJSON };
