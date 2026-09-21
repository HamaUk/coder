// Direct mode — payload preparation then the shared agentic loop.
//
// The loop itself lives in ./middleware/loop.js (PHASE 6). This module is the
// Direct-mode wiring: build the provider-neutral payload, run the loop,
// auto-persist any code blocks the model emitted in prose, and compile the
// workspace afterwards and send the model back to fix what it broke.
//
// For big project requests it also dispatches the rest of the enabled "crew" —
// additional models that review and improve the shared workspace — see ./crew.js.
const toolsKit = require('./tools');
const { buildPayload, composeSystemPrompt } = require('./middleware/payload');
const { runToolLoop } = require('./middleware/loop');
const { resolveLimits } = require('./middleware/limits');
const diagnostics = require('./middleware/diagnostics');
const loopGuard = require('./middleware/loop-guard');
const crew = require('./crew');

// ---------------------------------------------------------------------------
// Compile-and-repair
// ---------------------------------------------------------------------------
const MAX_REPAIR_ROUNDS = 2;

const WRITES_FILES = /^(write_|edit_|delete_|create_)/;

function buildRepairPrompt(buildReport, round) {
  return [
    'The workspace has to compile before this turn is finished. I compiled it — it does not.',
    '',
    buildReport,
    '',
    round > 1
      ? 'Fix every ERROR above, starting with the first. This is the second attempt: if something genuinely cannot be repaired, delete the broken code rather than leaving the project unbuildable, and say what you removed.'
      : 'Fix every ERROR above, starting with the first.',
    'Use read_file to see the current content before changing it, and edit_file to change it in place.',
    'Do not start over, and do not create a second implementation of anything that already exists.',
    'When the build is clean, say so in one line and stop.'
  ].join('\n');
}

async function repairUntilClean({ chatId, formData, res, text, toolRuns, signal, emit, runOnce, runKey }) {
  let rounds = 0;
  let exhausted = res.exhausted;

  if (exhausted || !chatId || signal?.aborted) return { text, toolRuns, rounds, exhausted, finalText: res.finalText };
  if (!toolRuns.some(r => WRITES_FILES.test(String(r.name || '')))) {
    return { text, toolRuns, rounds, exhausted, finalText: res.finalText };
  }

  for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
    let diag = null;
    try { diag = await diagnostics.diagnose(chatId); } catch { break; }
    const report = diagnostics.renderDiagnostics(diag);
    if (!report || !diag || !diag.errors) break;

    const notice = '\n\n---\n\n**Build check: ' + diag.errors + ' error(s) found — repairing.**\n\n';
    emit('status', { text: 'The build has ' + diag.errors + ' error(s) — sending them back to be fixed…' });
    emit('token', { text: notice });
    text += notice;

    const history = formData.messages;
    const last = history[history.length - 1];
    if (last && last.role === 'user') {
      history.push({ role: 'assistant', content: res.finalText || '(no output)' });
    }
    history.push({ role: 'user', content: buildRepairPrompt(report, round) });

    // Fixing the file it just wrote is not a rewrite loop.
    loopGuard.resetRewrite(runKey);
    res = await runOnce({ ownsTodo: false });
    rounds++;
    text += res.text;
    toolRuns.push(...res.toolRuns);
    exhausted = res.exhausted;

    if (exhausted) break;
  }

  return { text, toolRuns, rounds, exhausted, finalText: res.finalText };
}

// ---------------------------------------------------------------------------
// Completeness — a project that came back as a skeleton
// ---------------------------------------------------------------------------
// The system prompt asks for 150–600-line files and spells out that a template
// or starter is "a working implementation, not a skeleton". A strong model
// follows it; a small one does not, and the recorded evidence is blunt: asked
// for scripts, a page, a stylesheet and a script, `amazon/nova-lite-v1` wrote
// 100 B, 30 B, 323 B, 144 B and 62 B — seven, two, thirteen, ten and three
// lines of "Hello, world!". The user's complaint was not that the app failed but
// that the code was far too small, which no amount of prompt phrasing fixes in a
// model that does not read prompts carefully.
//
// So the pipeline checks the work instead of trusting the model. A round that
// created several files and made ALL of them thin is not a finished project, and
// the model is sent back once with the exact file list, line counts and byte
// counts, told what "complete" means, and told how to build a long file across
// several calls. Bounded to one round: a model that will not expand its own work
// will not expand it on the third ask either, and the turn still ends with
// whatever was produced.
const MAX_EXPAND_ROUNDS = 1;

/**
 * Asks where a skeleton IS the deliverable.
 *
 * "Print hello world", "a one-liner", "a 10-line script", "a minimal example" —
 * for these a short file is the correct answer and pushing it to 200 lines would
 * be worse, not better. Everything else that created several files is expected
 * to be real work.
 */
const TRIVIAL_ASK = /\b(hello[ ,-]?world|one[- ]?liner|single[- ]line|minimal (example|demo|version)|tiny example|boilerplate only|skeleton only|stub only|just print)\b|\b\d+\s*[- ]?lines?\b/i;

/** Below BOTH of these, a created file is a skeleton rather than an implementation. */
const SUBSTANCE_MIN_LINES = 30;
const SUBSTANCE_MIN_BYTES = 1200;

/** One file is a snippet; this many is a project that has to hang together. */
const SUBSTANCE_MIN_FILES = 2;

/**
 * Every file the turn actually created, latest write per path.
 *
 * Read from the tool runs' structured `meta` (which the tools already report)
 * rather than by re-reading the disk, so this is the same data the transcript
 * shows — and it costs nothing.
 *
 * @param {Array} toolRuns - the turn's runs so far.
 * @returns {Array<{path: string, lines: number, bytes: number}>}
 */
function createdFiles(toolRuns) {
  const byPath = new Map();
  for (const run of toolRuns || []) {
    if (!run || run.ok === false) continue;
    const name = String(run.name || '');
    if (name === 'write_files') {
      const reported = run.meta && Array.isArray(run.meta.files) ? run.meta.files : [];
      for (const f of reported) {
        if (f && f.path) byPath.set(String(f.path), {
          path: String(f.path),
          lines: Number(f.lines) || 0,
          bytes: Number(f.bytes) || 0
        });
      }
    } else if (name === 'write_file') {
      const path = String((run.args && run.args.path) || '');
      if (!path) continue;
      const content = String((run.args && run.args.content) || '');
      byPath.set(path, {
        path,
        bytes: (run.meta && Number(run.meta.bytes)) || content.length,
        lines: (run.meta && Number(run.meta.lines)) || (content ? content.split('\n').length : 0)
      });
    }
  }
  return [...byPath.values()];
}

/** Whether this turn's output is a set of skeletons rather than a project. */
function skeletalFiles(toolRuns) {
  const files = createdFiles(toolRuns);
  if (files.length < SUBSTANCE_MIN_FILES) return null;
  const thin = files.filter((f) => f.lines < SUBSTANCE_MIN_LINES && f.bytes < SUBSTANCE_MIN_BYTES);
  // EVERY created file has to be thin. One substantial file means the model did
  // understand the job and a small companion file is legitimate.
  return thin.length === files.length ? thin : null;
}

function buildExpandPrompt(thin) {
  const listing = thin
    .map((f) => `- ${f.path} — ${f.lines} line${f.lines === 1 ? '' : 's'}, ${f.bytes} bytes`)
    .join('\n');
  return [
    'The files you just created are skeletons, not finished work:',
    '',
    listing,
    '',
    'Each of these has to be a COMPLETE implementation. Rewrite them so they actually do the job:',
    '- every function, branch and state the feature needs — with real error handling and input validation;',
    '- real structure, content and styling, not one rule per element and not a placeholder heading;',
    '- the files must genuinely work together: a stylesheet whose classes the markup uses, a script the page loads, imports that resolve.',
    '',
    'A template, starter, page, component or script of this kind is normally 150–600 lines.',
    'If a file is too long to send in one call, write the first part with write_file and extend it with',
    'write_file({ append: true }) until it is finished — never cut it short and never leave a TODO.',
    '',
    'Keep exactly the same filenames, do not create new ones, do not ask a question, and do not explain the plan.',
    'Write the files, then finish with one short line describing what you built.'
  ].join('\n');
}

/**
 * Sends a skeleton result back once, to be finished properly.
 *
 * @returns {Promise<{text: string, toolRuns: Array, rounds: number}>}
 */
async function expandSkeletalWork({ chatId, formData, res, text, toolRuns, signal, emit, runOnce, request, complexity, runKey }) {
  if (res.exhausted || !chatId || signal?.aborted) return { text, toolRuns, rounds: 0 };
  // Only for a request that asked for a project. "Quick" and plain "agent" turns
  // are answers or single small changes, where a short file is the deliverable.
  if (complexity !== 'crew') return { text, toolRuns, rounds: 0 };
  if (TRIVIAL_ASK.test(String(request || ''))) return { text, toolRuns, rounds: 0 };

  const thin = skeletalFiles(toolRuns);
  if (!thin) return { text, toolRuns, rounds: 0 };

  const lines = thin.reduce((n, f) => n + f.lines, 0);
  const notice = '\n\n---\n\n**Those files are skeletons — ' + thin.length + ' files, ' + lines +
    ' lines in total. Sending them back to be written properly.**\n\n';
  emit('status', { text: 'The files came back too thin — asking the model to finish them properly…' });
  emit('token', { text: notice });
  text += notice;

  const history = formData.messages;
  const last = history[history.length - 1];
  if (last && last.role === 'user') {
    history.push({ role: 'assistant', content: res.finalText || '(no output)' });
  }
  history.push({ role: 'user', content: buildExpandPrompt(thin) });

  // A fresh pass over the same files is not a rewrite loop — see resetRewrite.
  loopGuard.resetRewrite(runKey);
  const next = await runOnce({ ownsTodo: false });
  text += next.text;
  toolRuns.push(...next.toolRuns);

  return { text, toolRuns, rounds: 1 };
}

async function runAgent({ provider, providers, history, tools, settings, signal, emit, chatId, budget }) {
  // Reasoning (chain-of-thought) arrives as `thinking` events from the loop and
  // is accumulated here so it can be persisted on the message and rendered as a
  // collapsed "Thought" row. The wrapper is transparent to every other event.
  let reasoning = '';
  // How long the model spent reasoning before it started doing anything. The
  // console renders it on the "Think" row, and a value that only exists while
  // the stream is live (as it did) meant the same row lost its duration the
  // moment the page was reloaded. Measured from the first reasoning token to the
  // last, so it is the model's thinking time and not the turn's length.
  let thinkingFrom = 0;
  let thinkingTo = 0;
  const originalEmit = emit;
  emit = (type, data = {}) => {
    if (type === 'thinking' && data.text) {
      reasoning += data.text;
      const now = Date.now();
      if (!thinkingFrom) thinkingFrom = now;
      thinkingTo = now;
    }
    originalEmit(type, data);
  };
  const thinkMs = () => (thinkingFrom && thinkingTo > thinkingFrom ? thinkingTo - thinkingFrom : null);

  // ---- live tool progress ------------------------------------------------
  //
  // A tool call can now take minutes: `run_shell` defaults to a 120s timeout,
  // `start_job` returns at once but the first wait on a build does not. Between
  // `tool_start` and `tool_end` the stream would otherwise carry nothing, so a
  // long command looks identical to a hung server. One ticker per running call
  // emits the elapsed time every few seconds, which is what the card's live
  // "Running 0:42" line renders. It is deliberately an EVENT and not the
  // keep-alive comment: a comment keeps the socket open but tells the user
  // nothing, and the client has no visible step to update from it.
  const PROGRESS_EVERY_MS = 4000;
  let progressTimer = null;
  let progressCall = null;
  const stopProgress = () => {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    progressCall = null;
  };
  const onToolPhase = (info) => {
    if (!info) return;
    if (info.phase === 'end') {
      // Only the call that owns the timer may clear it: a nested or repeated
      // call id must not cancel a different call's ticker.
      if (!progressCall || progressCall.id === info.id) stopProgress();
      return;
    }
    stopProgress();
    progressCall = { id: info.id, name: info.name, startedAt: info.startedAt, step: info.step };
    emit('tool_progress', {
      id: info.id,
      name: info.name,
      step: info.step,
      startedAt: info.startedAt,
      elapsedMs: 0
    });
    progressTimer = setInterval(() => {
      if (!progressCall) return;
      emit('tool_progress', {
        id: progressCall.id,
        name: progressCall.name,
        step: progressCall.step,
        startedAt: progressCall.startedAt,
        elapsedMs: Date.now() - progressCall.startedAt
      });
    }, PROGRESS_EVERY_MS);
    progressTimer.unref?.();
  };

  const limits = resolveLimits(budget, settings);

  // Adaptive effort: read the current request once, up front.
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const complexity = crew.classifyComplexity(lastUser ? lastUser.content : '');

  const { formData, metadata } = buildPayload({ provider, history, tools, settings, chatId });

  // The task list is keyed per RUN, not per chat: two overlapping turns on one
  // chat (a second tab, or a reload mid-reply) would otherwise share one
  // checklist — the newer turn resetting it and the first finisher deleting it
  // from under the other, which silently cut that turn short. The repair rounds
  // and the crew relays deliberately reuse this same key so they still share the
  // one list with the turn that owns it (`ownsTodo: false`).
  const runKey = chatId ? `${chatId}:${Math.random().toString(36).slice(2, 10)}` : null;

  const runOnce = (overrides = {}) => runToolLoop({
    ownsTodo: true,
    ...overrides,
    provider,
    formData,
    metadata,
    signal,
    emit,
    tokenEvent: 'token',
    separatorOnToolCall: true,
    onToolPhase,
    maxIterations: limits.maxSteps,
    maxAutoContinues: limits.maxAutoContinues,
    todoKey: runKey
  });

  // The loop attaches what already reached the user to the error it throws, so an
  // aborted turn still persists. Reasoning is accumulated here, so it has to be
  // merged in too — otherwise the "Think" row vanishes on exactly the path (a
  // Stop) where the user most wants to see what the model was doing. Every await
  // that can abort goes through this, not just the first one.
  // The last successfully completed stage. When a LATER stage throws — a repair
  // round, a crew review, auto-save — the error carries whatever partial that
  // stage had, which may be nothing at all. The main run's output must survive
  // that: it is already streamed and already real. `lastResult` is therefore the
  // floor every failure starts from, so the transcript can never lose work the
  // user watched happen.
  let lastResult = null;
  const keepReasoningOnFailure = async (fn) => {
    try {
      const value = await fn();
      if (value && typeof value === 'object') lastResult = value;
      return value;
    } catch (e) {
      if (e && typeof e === 'object') {
        const partial = e.partial;
        if (lastResult) {
          e.partial = {
            // A later stage's own salvage is more specific when it exists; the
            // last full result is the floor underneath it.
            text: (partial && partial.text) || lastResult.text || '',
            toolRuns: (partial && partial.toolRuns && partial.toolRuns.length)
              ? partial.toolRuns
              : (lastResult.toolRuns || []),
            reasoning
          };
        } else if (partial) {
          partial.reasoning = reasoning;
        } else if (reasoning) {
          // Reasoning alone is still worth keeping even when no token arrived.
          e.partial = { text: '', toolRuns: [], reasoning };
        }
      }
      throw e;
    }
  };

  try {
    const res = await keepReasoningOnFailure(() => runOnce());
    const toolRuns = res.toolRuns.slice();

    const repaired = await keepReasoningOnFailure(() => repairUntilClean({
      chatId, formData, res, text: res.text, toolRuns, signal, emit, runOnce, runKey
    }));
    let text = repaired.text;
    let exhausted = repaired.exhausted;

    // ---- Completeness: a project that came back as a skeleton ---------------
    // Runs AFTER the build repair (so the files at least compile) and BEFORE the
    // crew (so the reviewers polish a real implementation rather than a stub).
    if (!exhausted && !signal?.aborted) {
      const lastUser = [...history].reverse().find((m) => m.role === 'user');
      const expanded = await keepReasoningOnFailure(() => expandSkeletalWork({
        chatId,
        formData,
        res: { exhausted: false, finalText: repaired.finalText },
        text,
        toolRuns,
        signal,
        emit,
        runOnce,
        request: lastUser ? lastUser.content : '',
        complexity,
        runKey
      }));
      text = expanded.text;
    }

    // ---- Crew: the rest of the enabled team reviews & improves the work ----
    // The reviewers' tool runs are collected SEPARATELY from the lead's. Merging
    // them (as this did) put the reviewer's reads and rewrites into the lead's
    // turn receipt, so a turn that built five files reported ten steps, and the
    // console had no way to say which rows belonged to which model.
    let crewRuns = [];
    const workers = crew.pickWorkers(providers, provider.id, (settings.agent || {}).crewSize);
    if (!exhausted && !signal?.aborted &&
        crew.shouldRunCrew({ settings, complexity, workers })) {
      const label = workers.length === 1 ? 'model' : 'models';
      const notice = '\n\n---\n\n**Team collaboration** — dispatching ' + workers.length +
        ' additional ' + label + ' to review and improve this using the shared workspace.\n';
      emit('token', { text: notice });
      text += notice;

      const crewRes = await keepReasoningOnFailure(() => crew.runCrewRefines({
        workers, chatId, history, tools, settings, signal, emit, budget, todoKey: runKey
      }));
      if (crewRes.text) text += crewRes.text;
      if (crewRes.toolRuns && crewRes.toolRuns.length) crewRuns = crewRes.toolRuns;
    }

    // Auto-persist code blocks the model wrote out in prose instead of calling a
    // tool. Skipped when the turn hit its step cap, and skipped for any path a
    // file tool already wrote this turn.
    if (!exhausted) {
      const skip = toolsKit.artifactPathsFromToolRuns(toolRuns);
      const autoSaved = toolsKit.extractAndSaveCodeBlocks(text, { chatId, skip });
      for (const item of autoSaved) {
        if (item.error) {
          // Surfaced as a failed row instead of vanishing: the user can see the
          // block in the transcript, so silence reads as "the file exists".
          toolRuns.push({
            name: 'write_file',
            args: { path: item.path },
            ok: false,
            result: 'Could not auto-save this code block to ' + item.path + ': ' + item.error,
            meta: { auto: true, error: item.error },
            ts: Date.now()
          });
          continue;
        }
        toolRuns.push({
          name: 'write_file',
          args: { path: item.path },
          ok: true,
          result: 'Auto-saved code block to workspace: ' + item.path + ' (' + item.size + ' bytes)',
          meta: { created: true, bytes: item.size, auto: true },
          ts: Date.now()
        });
      }
      return { text, toolRuns, crewRuns, mode: 'direct', crew: workers.length, reasoning, thinkMs: thinkMs() };
    }

    const note = res.continues
      ? '\n\n*(Stopped — ' + res.iterations + ' steps used and ' + res.continues + ' automatic continuation(s) later, the turn hit its limit. Ask me to carry on and I\'ll pick up where I left off.)*'
      : '\n\n*(Stopped — reached the maximum number of tool steps for one turn.)*';
    emit('token', { text: note });
    return { text: text + note, toolRuns, crewRuns, mode: 'direct', crew: 0, reasoning, thinkMs: thinkMs() };
  } finally {
    // The loop releases the ticker when its tool call ends, but a throw in
    // between — an aborted turn, a provider error — would leave a 4-second
    // interval firing into a closed stream. One release point for every exit.
    stopProgress();
  }
}

module.exports = {
  runAgent,
  composeSystemPrompt,
  resolveLimits,
  MAX_REPAIR_ROUNDS,
  MAX_EXPAND_ROUNDS,
  // Exported for the completeness suite: the trigger is a pure decision over the
  // turn's runs, and "did it fire on the right turns" is the whole risk.
  createdFiles,
  skeletalFiles,
  buildExpandPrompt,
  TRIVIAL_ASK,
  SUBSTANCE_MIN_LINES,
  SUBSTANCE_MIN_BYTES,
  SUBSTANCE_MIN_FILES
};
