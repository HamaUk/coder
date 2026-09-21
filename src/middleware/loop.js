// PHASE 6 — The agentic loop.
//
// Mirrors the `while tool_calls:` cycle in Open WebUI's
// `streaming_chat_response_handler`. Direct mode (agent.js) is the only caller:
// the multi-stage pipeline that used to share this loop has been removed.
//
// The per-caller differences are expressed as hooks rather than forks, so a
// future second caller can reuse the loop without editing it.
//
// ---------------------------------------------------------------------------
// Working to completion
// ---------------------------------------------------------------------------
// The loop does not treat "the model stopped talking" as "the job is done". If
// the model kept a task list (via the `update_todos` tool) and that list still
// has open items, the loop feeds the remaining work back and keeps going, up to
// `maxAutoContinues`. That is what lets a request that needs thirty steps land
// in one turn instead of ending after the first few.
//
// A model that never touches the tool keeps the old behaviour exactly: the list
// stays empty, and an empty list is never a reason to continue.
//
// A second signal guards the other failure mode: the model repeating one
// identical call until the step budget runs out. `loop-guard` counts consecutive
// identical calls and adds a short instruction next to the result — it never
// blocks a call, so genuine polling still works.
const toolsKit = require('../tools');
const { streamBodyHandler } = require('./stream');
const todo = require('./todo');
const loopGuard = require('./loop-guard');
const { DEFAULTS } = require('./limits');

const MAX_TOOL_ITERATIONS = DEFAULTS.maxSteps;

/**
 * Builds the error to throw for an aborted signal.
 *
 * A plain Stop carries an AbortError, but a stage timeout aborts with a
 * StageTimeoutError as the reason. Collapsing both into AbortError made a
 * timed-out stage look like the user had pressed Stop — the UI even labelled it
 * "(stopped by user)" and the transcript was saved flagged as aborted.
 */
function abortReason(signal) {
  const reason = signal?.reason;
  if (reason && typeof reason === 'object' && reason.name && reason.name !== 'AbortError') return reason;
  return new DOMException('Aborted', 'AbortError');
}

/**
 * The visible part of a finished piece of text: `<thinking>…</thinking>` removed,
 * exactly as the streaming stripper would have done.
 */
function visiblePartOf(text) {
  let out = '';
  const s = makeThinkingStripper((t) => { out += t; }, () => {});
  s(text);
  s.end();
  return out;
}

/**
 * Drops paragraphs that are a verbatim repeat of a tool result the model was just
 * handed.
 *
 * A weak text-protocol engine sometimes answers by echoing the tool's output
 * before saying anything of its own — producing a reply that opened with
 * "Workspace is empty." twice. The tool card already shows that result, so the
 * repetition is noise, not an answer. A paraphrase is left alone; only an exact
 * block match is dropped, so nothing the model actually wrote can be lost.
 */
function dropToolEchoes(text, outputs) {
  const echoes = new Set((outputs || []).map((o) => String(o == null ? '' : o).trim()).filter(Boolean));
  if (!echoes.size || !text) return text;
  const blocks = String(text).split(/\n{2,}/);
  const kept = blocks.filter((b) => !echoes.has(b.trim()));
  return kept.join('\n\n');
}

/**
 * Drops narration the turn has already produced, so a looping model is shown
 * once instead of once per step.
 *
 * The recorded failure said the same paragraph seven times. Comparing only
 * against the immediately preceding iteration collapsed that to four, because
 * each iteration is followed by a tool result that resets the comparison.
 * Remembering every paragraph of the turn is what actually collapses the loop.
 *
 * `suppressible` is what keeps it honest. A block is only dropped when the
 * iteration consisted ENTIRELY of things already said — a model making no
 * progress. An iteration containing anything new is emitted whole, so a
 * deliberate refrain separated by real work is never touched, and the guard
 * cannot quietly delete an answer.
 *
 * @param {string} text - this iteration's narration.
 * @param {Set<string>} said - paragraphs already emitted this turn.
 * @returns {string} the narration to keep.
 */
function dropRepeatedNarration(text, said) {
  const current = String(text == null ? '' : text);
  if (!current.trim()) return current;
  const blocks = current.split(/\n{2,}/).filter((b) => b.trim());
  if (!blocks.length) return current;
  const fresh = blocks.filter((b) => !said.has(b.trim()));
  for (const block of blocks) said.add(block.trim());
  // Nothing new at all: this iteration exists only to repeat the turn. Say
  // nothing rather than the same paragraph again.
  if (!fresh.length) return '';
  return blocks.join('\n\n');
}

/**
 * Collapses a turn whose text is the SAME paragraph repeated back-to-back.
 *
 * `dropRepeatedNarration` above works one iteration at a time and deliberately
 * keeps an iteration whole when it contains anything new. That is right for the
 * model that re-narrates and then says something fresh — but it leaves the one
 * failure this app recorded worst: a text-protocol engine that emits the same
 * plan paragraph, then a tool call, then the same paragraph again, for seven
 * steps. Each iteration carried one new thing (the call), so every iteration was
 * "kept whole", and the transcript ended up with the paragraph seven times.
 *
 * This is the turn-level safety net, applied where the text is committed rather
 * than where it is produced, so it also covers the paths that concatenate
 * several runs (a repair round, a crew relay) and the raw streamed floor in
 * `routes/chat.js` — none of which share one iteration buffer.
 *
 * Only CONSECUTIVE duplicates are dropped. A refrain that is separated by real
 * work (plan → files → plan → files → plan) is untouched, because there the
 * repeated block is not adjacent to itself. Nothing is rewritten and no block
 * is trimmed, so a fenced or indented code block survives byte for byte.
 *
 * @param {string} text - the assembled text of a turn.
 * @returns {string} the same text with adjacent duplicate blocks removed.
 */
function collapseRepeatedBlocks(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return s;
  const blocks = s.split(/\n{2,}/);
  const kept = [];
  let previous = null;
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (previous !== null && trimmed === previous) continue;
    kept.push(block);
    previous = trimmed;
  }
  return kept.join('\n\n');
}

/**
 * Removes the chat-wrapper tags some models put around their answer.
 *
 * Amazon's Nova models (and a few others reached through an OpenAI-compatible
 * endpoint) answer inside `<response>…</response>`. Those tags are transport
 * chatter, not prose, and they were reaching the transcript as visible text
 * because the client escapes HTML rather than hiding it. Only tags that cannot
 * be real markup in a reply are listed here: `<output>` and friends are valid
 * HTML elements and stripping them would corrupt any code the model wrote.
 *
 * @param {string} text - one iteration's or one turn's text.
 * @returns {string} the text without chat-wrapper tags.
 */
const CHATTER_TAGS = ['response'];

function stripChatterMarkup(text) {
  let out = String(text == null ? '' : text);
  for (const tag of CHATTER_TAGS) {
    out = out.replace(new RegExp('</?' + tag + '\\s*>', 'gi'), '');
  }
  return out;
}

function buildContinuationPrompt(openList) {  return [
    'Your task list still has open items:',
    openList,
    '',
    'Keep going — use your tools to finish them, then call update_todos with every finished item marked "completed".',
    'Do not end your turn while items remain open. If a task turns out to be unnecessary or genuinely impossible, drop it from the list (call update_todos without it) and say so in your final answer, rather than leaving it open.'
  ].join('\n');
}

/**
 * Strips `<thinking>…</thinking>` blocks out of a model's streamed text so the
 * reasoning never leaks into the visible answer. Text outside the tags flows to
 * `onText`; text inside flows to `onThinking`. Tags may arrive split across
 * chunks, so a small tail is held back until the delimiter can be ruled out.
 */
function makeThinkingStripper(onText, onThinking) {
  const OPEN = '<thinking>';
  const CLOSE = '</thinking>';
  let buf = '';
  let inThinking = false;

  function flushText(s) { if (s) onText(s); }
  function flushThinking(s) { if (s) onThinking(s); }

  function process(chunk) {
    buf += chunk;
    for (;;) {
      if (inThinking) {
        const i = buf.toLowerCase().indexOf(CLOSE);
        if (i === -1) {
          const keep = Math.min(buf.length, CLOSE.length - 1);
          if (buf.length > keep) flushThinking(buf.slice(0, buf.length - keep));
          buf = buf.slice(buf.length - keep);
          return;
        }
        if (i > 0) flushThinking(buf.slice(0, i));
        buf = buf.slice(i + CLOSE.length);
        inThinking = false;
      } else {
        const i = buf.toLowerCase().indexOf(OPEN);
        if (i === -1) {
          const keep = Math.min(buf.length, OPEN.length - 1);
          if (buf.length > keep) flushText(buf.slice(0, buf.length - keep));
          buf = buf.slice(buf.length - keep);
          return;
        }
        if (i > 0) flushText(buf.slice(0, i));
        buf = buf.slice(i + OPEN.length);
        inThinking = true;
      }
    }
  }

  const push = (chunk) => { if (chunk) process(String(chunk)); };
  push.end = () => {
    if (inThinking) flushThinking(buf);
    else flushText(buf);
    buf = '';
    inThinking = false;
  };
  return push;
}

/**
 * @param {object}   args
 * @param {object}   args.provider    resolved provider
 * @param {object}   args.formData    { model, messages, tools, ... }; `messages` is mutated in place
 * @param {object}   args.metadata    { system, chatId }
 * @param {AbortSignal} [args.signal]
 * @param {Function} args.emit        (eventType, payload) => void
 * @param {string}   [args.tokenEvent='token']
 * @param {boolean}  [args.separatorOnToolCall=false]  emit 'separator' when a turn that streamed text ends in tool calls
 * @param {Function} [args.emitExtra] (eventType) => object merged into token/tool_start/tool_end payloads
 * @param {Function} [args.onToken]   (text) => void — extra per-token accumulation
 * @param {Function} [args.onToolRun] (run, call, result) => void — extra per-tool bookkeeping
 * @param {number}   [args.maxIterations=MAX_TOOL_ITERATIONS]
 * @param {number}   [args.maxAutoContinues=0]  how many times to resume when the task list still has open items
 * @param {string}   [args.todoKey]   task-list identity; defaults to metadata.chatId
 *
 * @returns {Promise<{ text, finalText, toolRuns, iterations, continues, exhausted }>}
 *   `text` is everything the user saw this turn, in order.
 *   `exhausted` is true when the iteration cap was hit rather than the model
 *   finishing naturally — callers use it to decide whether to auto-save and
 *   whether to report the cap.
 */
async function runToolLoop({
  provider,
  formData,
  metadata = {},
  signal,
  emit,
  tokenEvent = 'token',
  separatorOnToolCall = false,
  emitExtra = null,
  onToken = null,
  onToolRun = null,
  onToolPhase = null,
  maxIterations = MAX_TOOL_ITERATIONS,
  maxAutoContinues = 0,
  todoKey = null,
  ownsTodo = false
}) {
  const history = formData.messages;
  const toolRuns = [];
  const key = todoKey || metadata.chatId || null;
  // The exact set this conversation offered the model. Anything else the model
  // names is refused rather than executed — see tools.execute().
  const allowedTools = (formData.tools || []).map(t => t && t.name).filter(Boolean);

  // `finalText` is the current uninterrupted text run (reset whenever the model
  // moves on to a tool call) — it drives the separator rule and the cap message.
  // `visibleText` is everything streamed across the whole turn, which is what
  // the transcript should end up containing.
  let finalText = '';
  let visibleText = '';
  let iterations = 0;
  let continues = 0;
  let exhausted = false;
  // Outputs of the tool calls run in the previous iteration, kept only so the
  // next turn can be recognised as an echo of them.
  let lastToolOutputs = [];
  // Every narration paragraph the turn has emitted, so a repeated one is shown
  // once instead of once per step.
  const narrationSaid = new Set();

  const extra = (type) => (typeof emitExtra === 'function' ? emitExtra(type) : {});

  // A relay passes ownsTodo:false so the whole chain shares one list. Each model
  // then begins where the last left off instead of being handed a blank
  // checklist and re-planning the same work.
  if (key && ownsTodo) todo.begin(key);

  try {
    while (iterations < maxIterations) {
      iterations++;
      if (signal?.aborted) throw abortReason(signal);

      let sawAnyToken = false;        // any delta at all (streaming happened)
      let callText = '';
      // The stripper streams to the UI but no longer writes the transcript
      // directly: what this iteration contributes is decided once the whole
      // stream is in. A text-protocol engine's markup can only be removed
      // reliably from the finished text, and a turn that merely repeats a tool
      // result should not be kept at all.
      const stripper = makeThinkingStripper(
        (txt) => {
          callText += txt;
          onToken?.(txt);
          emit(tokenEvent, { ...extra(tokenEvent), text: txt });
        },
        (th) => emit('thinking', { ...extra('thinking'), text: th, step: iterations })
      );

      const res = await streamBodyHandler(
        provider,
        formData,
        { system: metadata.system, signal },
        {
          onToken: (t) => { sawAnyToken = true; stripper(t); },
          onStatus: (s) => emit('status', { text: s }),
          onReasoning: (r) => emit('thinking', { ...extra('thinking'), text: r, step: iterations })
        }
      );

      // An adapter may return its text in one piece instead of streaming deltas
      // (the demo provider does this on a tool-call turn). Run it through the
      // stripper too, then flush any buffered tail (and any unclosed thinking).
      if (!sawAnyToken && res.text) stripper(res.text);
      stripper.end();

      // ---- what this iteration actually contributes to the reply -----------
      let piece = callText;
      // An adapter whose markup can only be stripped from the finished text says
      // so; its version then replaces whatever went out live.
      if (res.textIsAuthoritative && typeof res.text === 'string') {
        piece = visiblePartOf(res.text);
      }
      // Chat-wrapper tags are removed BEFORE anything is compared, so
      // `<response>` on one iteration and a bare paragraph on the next still
      // count as the same paragraph.
      piece = stripChatterMarkup(piece);
      // A weak engine sometimes "answers" by repeating the tool result it was
      // just handed — literally, e.g. "Workspace is empty." The tool card
      // already shows that result, so echoing it into the reply is noise rather
      // than an answer, and it is what made a transcript stutter.
      piece = dropToolEchoes(piece, lastToolOutputs);
      lastToolOutputs = [];

      // A text-protocol engine that is stuck re-emits the same paragraph every
      // iteration, so a seven-step loop produced the same sentence seven times
      // in the transcript — the single most visible symptom of the loop, and
      // pure noise: the user needs to see that work happened, not read the same
      // plan seven times.
      piece = dropRepeatedNarration(piece, narrationSaid);

      // What reached the browser live is not necessarily what the turn keeps: a
      // suppressed repeat, a dropped tool echo and an authoritative re-render
      // all change the text AFTER it was streamed. Telling the client exactly
      // what to remove — and what to put in its place — keeps the live bubble
      // and the saved transcript in agreement while the turn is still running,
      // instead of the reply silently shrinking when `message_end` swaps the
      // live element for the canonical one.
      if (piece !== callText) emit('retract', { text: callText, replace: piece });

      callText = piece;
      finalText = piece;
      if (piece) visibleText += piece;

      if (res.toolCalls?.length) {
        history.push({ role: 'assistant', content: callText, toolCalls: res.toolCalls });
        if (separatorOnToolCall && finalText.trim()) {
          emit('separator', {});
          visibleText += '\n\n'; // mirror what the separator renders, so the saved text matches the stream
        }
        finalText = '';

        const outputs = [];
        for (const call of res.toolCalls) {
          if (signal?.aborted) throw abortReason(signal);
          const args = call.args || {};
          const startedAt = Date.now();
          emit('tool_start', { ...extra('tool_start'), id: call.id, name: call.name, args, step: iterations, startedAt });
          // Tells the caller a tool is now running, so it can keep the client
          // informed while the call is in flight. A shell command may run for
          // minutes; without this the stream carries nothing at all in between.
          onToolPhase?.({ phase: 'start', id: call.id, name: call.name, startedAt, step: iterations });

          // A call repeated past the block threshold is refused BEFORE it runs:
          // the work is already done, and re-doing it is the loop. The model is
          // told why, so it can finish the turn instead of hammering the tool.
          //
          // Two different repeats are refused: the identical call, and the same
          // set of files being rewritten yet again with different content. The
          // second is what actually happened here — seven rewrites of five files,
          // each pass smaller than the last, so the turn ended with the worst
          // version on disk and no guard noticed because no two calls matched.
          const blocked = loopGuard.shouldBlock({ runKey: key, name: call.name, args });
          const blockedRewrite = blocked.blocked
            ? blocked
            : loopGuard.shouldBlockRewrite({ runKey: key, name: call.name, args });
          let result;
          let endedAt;
          try {
            result = (blocked.blocked || blockedRewrite.blocked)
              ? { ok: false, output: 'Error: ' + (blocked.blocked ? blocked.output : blockedRewrite.output), meta: { blocked: true } }
              : await toolsKit.execute(call.name, args, { chatId: metadata.chatId, todoKey: key, allowed: allowedTools });
            endedAt = Date.now();
          } finally {
            // Releases the live indicator even when the tool throws or the turn
            // is aborted mid-call, so it can never outlive its call.
            onToolPhase?.({ phase: 'end', id: call.id, name: call.name, startedAt, endedAt: endedAt || Date.now(), ms: (endedAt || Date.now()) - startedAt });
          }
          const ms = endedAt - startedAt;

          // Consecutive-repeat detection runs after execution and only ever
          // adds a sentence to the result: it cannot veto a call, so a model
          // that genuinely needs to poll a build is not stopped from doing so.
          const repeatNotice = loopGuard.observe({ runKey: key, name: call.name, args });

          const run = {
            id: call.id,
            name: call.name,
            args,
            ok: result.ok,
            result: result.output,
            // Structured facts for the UI (created/updated, ±lines, exit code).
            // The model reads `result`; `meta` is never sent to a provider, so it
            // costs nothing in the context window.
            meta: result.meta,
            step: iterations,
            startedAt,
            ms,
            ts: endedAt,
            ...(repeatNotice ? { repeat: true } : {})
          };
          onToolRun?.(run, call, result);
          toolRuns.push(run);

          emit('tool_end', { ...extra('tool_end'), id: call.id, name: call.name, ok: result.ok, result: result.output, meta: result.meta, step: iterations, startedAt, ms, endedAt, ...(repeatNotice ? { repeat: true } : {}) });
          history.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: repeatNotice ? result.output + '\n\n---\n\n' + repeatNotice : result.output
          });
          outputs.push(typeof result.output === 'string' ? result.output : '');
        }
        // Remembered so the next turn can be recognised as an echo of them.
        lastToolOutputs = outputs;
        continue;
      }

      // The model stopped without requesting tools. Before accepting that as
      // "finished", consult its own task list.
      const open = key ? todo.renderOpen(key) : '';
      if (open && continues < maxAutoContinues) {
        continues++;
        emit('status', { text: `Still ${todo.openItems(key).length} task(s) to go — continuing…` });
        if (visibleText.trim()) visibleText += '\n\n';
        finalText = '';
        // The assistant turn must be recorded before the nudge, or the nudge
        // would sit directly after a tool result and two same-role turns in a
        // row are rejected by Anthropic and Gemini.
        history.push({ role: 'assistant', content: callText || '(no output)' });
        history.push({ role: 'user', content: buildContinuationPrompt(open) });
        continue;
      }

      if (open) {
        // Out of continuation budget with work still listed. The answer is kept
        // (and auto-saved as normal) — but the user is told it is unfinished,
        // rather than the list quietly disappearing with the turn.
        const remaining = todo.openItems(key).length;
        const notice = `\n\n*(Stopped after ${continues} automatic continuation(s) with ${remaining} scheduled task(s) still open — the job is not finished. Ask me to carry on and I'll pick up from here.)*`;
        visibleText += notice;
        emit('status', { text: `Stopping with ${remaining} task(s) still open.` });
        emit(tokenEvent, { ...extra(tokenEvent), text: notice });
        return { text: collapseRepeatedBlocks(visibleText), finalText, toolRuns, iterations, continues, exhausted: false };
      }

      // Model finished without requesting more tools.
      return { text: collapseRepeatedBlocks(visibleText), finalText, toolRuns, iterations, continues, exhausted: false };
    }
    exhausted = true;
  } catch (err) {
    // Hand the caller everything that already reached the user. Without this an
    // aborted turn persisted nothing at all: the text was streamed, the reply
    // looked fine until the page was reloaded, and then it was gone.
    //
    // Only attached when there is something to salvage. An empty `partial` used
    // to be indistinguishable from a real one, so a caller that recovered from it
    // (the crew) treated a total failure as "produced partial output" and said
    // nothing about it.
    if (err && typeof err === 'object' && (visibleText || toolRuns.length)) {
      err.partial = { text: collapseRepeatedBlocks(visibleText), finalText, toolRuns, iterations, continues };
    }
    throw err;
  } finally {
    // Only the owner closes the list; a relay model that closed it would wipe the
    // shared checklist out from under the next model in the chain. The repeat
    // chain follows the same rule, for the same reason: the repair rounds and the
    // crew relays are a continuation of this turn, not a fresh one.
    if (key && ownsTodo) {
      todo.end(key);
      loopGuard.reset(key);
    }
  }

  return { text: collapseRepeatedBlocks(visibleText), finalText, toolRuns, iterations, continues, exhausted };
}

module.exports = {
  runToolLoop,
  MAX_TOOL_ITERATIONS,
  buildContinuationPrompt,
  makeThinkingStripper,
  dropRepeatedNarration,
  collapseRepeatedBlocks,
  stripChatterMarkup
};
