// Multi-model "crew" collaboration + adaptive effort.
//
// For a big project request the lead model plans and builds the first version,
// then the rest of the enabled team takes turns reviewing and improving the
// shared workspace. Every model reads the real files on disk and the
// deterministic build report — the shared memory — before touching anything, so
// each pass builds on the last instead of starting over. Simple requests never
// pay for this: they stay a single, direct answer from the lead.

const toolsKit = require('./tools');
const diagnostics = require('./middleware/diagnostics');
const { buildPayload, composeSystemPrompt } = require('./middleware/payload');
const { runToolLoop, stripChatterMarkup } = require('./middleware/loop');
const loopGuard = require('./middleware/loop-guard');
const { resolveLimits } = require('./middleware/limits');

// ---------------------------------------------------------------------------
// Adaptive effort: decide how hard the agent should work on one request.
//   quick — a greeting / trivial one-liner: single direct answer, no crew
//   agent — normal request: the lead's full agentic loop (tools + repair)
//   crew  — a real project: agent loop PLUS the rest of the team reviewing
// ---------------------------------------------------------------------------
const PROJECT_SIGNALS = /\b(build|create|make|develop|write|code|generate|implement|setup|design|redesign|fix|debug|refactor|migrate|rewrite|upgrade|app|application|website|web ?site|site|page|landing ?page|dashboard|project|full|complete|from scratch|multi-?file|e-?commerce|portfolio|blog|calculator|todo|game|bot|script|tool|api|rest ?api|react|vue|svelte|next|angular|frontend|backend|full-?stack|component|database|schema|cli|extension|server|scraper|crawler|automation|pipeline|deploy|docker|kubernetes|typescript|tailwind|css|html|javascript|python|node)\b/i;

function classifyComplexity(message) {
  const m = String(message || '').trim();
  const words = m.split(/\s+/).filter(Boolean).length;
  const lower = m.toLowerCase();

  const isProject = PROJECT_SIGNALS.test(lower) || words >= 40;
  const isQuick = !isProject && words <= 12 && (
    /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|what'?s up)\b/i.test(m) ||
    (/\b(thanks?|thank you|ok|okay|great|got it|cool|bye|goodbye)\b/i.test(lower) && words <= 6)
  );

  if (isQuick) return 'quick';
  if (isProject) return 'crew';
  return 'agent';
}

// A provider can join the crew only if it can actually be called right now.
function usableProvider(p) {
  if (!p || p.enabled === false) return false;
  if (p.toolsEnabled === false) return false;
  if (p.type === 'demo') return true;
  if (p.type === 'llamacoder') return true;
  if (p.hasKey) return true;
  return /localhost|127\.0\.0\.1/.test(p.baseUrl || '');
}

function pickWorkers(providers, leadId, crewSize) {
  const n = Math.max(0, Math.min(Number(crewSize) || 2, 4));
  const workers = [];
  const seen = new Set();

  // 1. Other enabled providers join first.
  for (const p of providers || []) {
    if (workers.length >= n) break;
    if (!usableProvider(p) || p.id === leadId) continue;
    workers.push({ provider: p, model: p.model });
    seen.add(p.id);
  }

  // 2. If the lead provider exposes several models (e.g. the built-in Hama AI
  //    engine ships five), those models can also join the crew — same endpoint,
  //    different model id.
  if (workers.length < n) {
    const lead = (providers || []).find((p) => p.id === leadId) || null;
    if (lead && Array.isArray(lead.modelsCache) && lead.modelsCache.length > 1) {
      for (const model of lead.modelsCache) {
        if (workers.length >= n) break;
        if (model === lead.model) continue;
        const key = lead.id + '|' + model;
        if (seen.has(key)) continue;
        workers.push({ provider: { ...lead, model }, model });
        seen.add(key);
      }
    }
  }

  return workers;
}

function shouldRunCrew({ settings, complexity, workers }) {
  const agent = settings.agent || {};
  if (agent.mode === 'solo') return false;
  if (agent.crewEnabled === false) return false;
  if (!workers.length) return false;
  if (agent.mode === 'crew') return true;
  return complexity === 'crew';
}

// ---------------------------------------------------------------------------
// Shared memory — the real project state every crew member reads first.
// ---------------------------------------------------------------------------
const REVIEW_ROLE = `## Your role this turn — team reviewer

You are a specialist model on a multi-model team. A lead model has already built
a first version of the project. Your job is to REVIEW and IMPROVE it — never to
rebuild it from scratch.

Rules:
1. Read the current files first (read_file / list_files). Never guess what exists.
2. Fix remaining bugs, broken imports, or anything half-finished.
3. Polish: improve the UI, tighten the code, handle edge cases, make it feel complete and professional.
4. Edit files in place — do NOT create duplicate files or a second implementation.
5. Preserve working code; change only what needs improving.
6. Build on what the models before you already did — do NOT undo or overwrite their work, and do NOT introduce a competing idea. The project is one shared codebase.
7. When finished, end with a short bullet list of exactly what you improved.`;

function buildSharedMemory(diag, chatId) {
  const parts = [];
  const report = diagnostics.renderDiagnostics(diag);
  if (report) parts.push(report);
  const manifest = diagnostics.renderManifest(diag, 200);
  if (manifest) parts.push(manifest);
  const sources = diagnostics.renderSources(diag, chatId, 10000);
  if (sources) parts.push(sources);
  return parts.length
    ? '## Shared memory — the real current state of the project on disk\n' + parts.join('\n\n')
    : '## Shared memory\nThe workspace is currently empty.';
}

// ---------------------------------------------------------------------------
// Reviewer traffic is namespaced.
//
// A reviewer is a second model running a full tool loop. While that loop shared
// the lead's `emit`, everything it produced landed in the LEAD's transcript:
// its streamed prose (an Amazon Nova reviewer answers inside `<response>` tags),
// its `<|DSML|…>` text-protocol chatter, its `[Tool Result (read_file)]`
// echoes, its shell transcripts and its tool rows — all of it rendered as plain
// text in the user's answer, mixed in with the rows of the model that actually
// built the project. Then the same reviewer text was appended AGAIN as a
// "team review" section at the end.
//
// Every reviewer event therefore carries a `crew_` prefix. The client renders
// those inside the team card for the reviewer they belong to, and nothing a
// reviewer says can arrive dressed as the lead's answer.
// ---------------------------------------------------------------------------
const CREW_EVENTS = {
  token: 'crew_token',
  separator: 'crew_separator',
  thinking: 'crew_thinking',
  tool_start: 'crew_tool_start',
  tool_end: 'crew_tool_end',
  tool_progress: 'crew_tool_progress'
};

function makeCrewEmit(emit, index, total) {
  return (type, data = {}) => {
    const mapped = CREW_EVENTS[type] || type;
    // `status` is deliberately NOT namespaced: it is the one-line "who is
    // working now" notice the console already renders above the reply.
    emit(mapped, { ...data, crewIndex: index, crewTotal: total });
  };
}

/**
 * Runs the review passes. Each worker gets the full shared memory (real files +
 * build report) and edits in place, so the models genuinely build on each other
 * instead of each writing its own version.
 *
 * @returns {Promise<{text: string, toolRuns: Array, passes: number}>} `toolRuns`
 *   are the REVIEWERS' runs, marked with the reviewer they came from. They are
 *   returned separately so the lead's turn receipt counts the lead's work, and
 *   the team card shows the reviewers' — the two were one undifferentiated list.
 */
async function runCrewRefines({ workers, chatId, history, tools, settings, signal, emit, budget, todoKey = null }) {
  const text = [];
  const toolRuns = [];
  const limits = resolveLimits(budget, settings);

  // A review pass is scoped, not a greenfield build — bound it so one worker
  // cannot burn the whole turn's budget.
  const workerLimits = {
    maxSteps: Math.max(6, Math.min(24, Math.round(limits.maxSteps / 3))),
    maxAutoContinues: 0
  };

  let passes = 0;
  const teamLog = [];
  for (let i = 0; i < workers.length; i++) {
    if (signal?.aborted) break;
    const worker = workers[i];
    passes++;

    emit('crew', {
      index: i + 1,
      total: workers.length,
      provider: { name: worker.provider.name, model: worker.provider.model },
      role: 'reviewer'
    });
    emit('status', { text: `Team review ${i + 1}/${workers.length} — ${worker.provider.name} is improving the project…` });

    let diag = null;
    try { diag = await diagnostics.diagnose(chatId); } catch { /* non-fatal */ }
    const memory = buildSharedMemory(diag, chatId);

    // Hand each worker a running log of what the reviewers before it changed,
    // on top of the real files on disk, so the team genuinely builds one shared
    // result instead of each model pursuing its own idea.
    const prior = teamLog.length
      ? '\n\n## What the reviewers before you already changed\n' +
        teamLog.map((s, k) => `${k + 1}. ${s}`).join('\n')
      : '';

    const defs = toolsKit.defsFor({
      web: tools?.web !== false,
      files: tools?.files !== false,
      code: tools?.code !== false
    });
    const base = composeSystemPrompt(worker.provider, settings, defs, chatId);
    const reviewSystem = base + '\n\n' + REVIEW_ROLE + prior + '\n\n' + memory;

    // A COPY per worker. Pushing onto the caller's array added one synthetic user
    // message per worker and never removed it, so worker 2's prompt carried two
    // consecutive user turns with no assistant reply between them — an
    // alternation Anthropic and Gemini reject outright.
    const workerHistory = [
      ...history,
      {
        role: 'user',
        content: 'Now review and improve the project. Use the shared memory above (the real files and build report) to guide you. Work in place and finish with a short list of what you improved.'
      }
    ];

    const { formData, metadata } = buildPayload({
      provider: worker.provider,
      history: workerHistory,
      tools,
      settings,
      chatId,
      systemOverride: reviewSystem
    });

    let res;
    const crewEmit = makeCrewEmit(emit, i + 1, workers.length);
    // A reviewer improving the files it was handed is not the lead re-deriving
    // the same plan. Without this, a lead that wrote five files plus the
    // completeness round would have the reviewers' edits counted as the third
    // and fourth rewrite of the same files, and the rewrite guard would refuse
    // exactly the work the crew exists to do.
    loopGuard.resetRewrite(todoKey || chatId || null);
    try {
      res = await runToolLoop({
        ownsTodo: false,
        provider: worker.provider,
        formData,
        metadata,
        signal,
        emit: crewEmit,
        tokenEvent: 'token',
        separatorOnToolCall: true,
        maxIterations: workerLimits.maxSteps,
        maxAutoContinues: workerLimits.maxAutoContinues,
        // Same per-run key as the lead, so the relay shares one checklist.
        todoKey: todoKey || chatId || null
      });
    } catch (e) {
      // A Stop must stay a Stop: swallowing the abort here would record a
      // cancelled turn as a completed one.
      if (signal?.aborted) throw e;
      // Keep whatever the user already read (mirrors the lead path). A partial
      // with neither text nor tool runs is a total failure, not salvage — saying
      // otherwise hid an unreachable provider from the user entirely.
      const salvage = e && e.partial;
      if (salvage && (salvage.text || (salvage.toolRuns || []).length)) {
        res = { text: salvage.text || '', toolRuns: salvage.toolRuns || [], exhausted: false };
      } else {
        emit('status', { text: `Team reviewer ${i + 1} failed (${(e && e.message) || e}). Continuing with the reviews that finished.` });
        continue;
      }
    }

    if (res.text && res.text.trim()) {
      const label = worker.provider.name + ' · ' + worker.model;
      // Strip the chat-wrapper tags a reviewer may have put around its summary:
      // the summary is quoted into the lead's answer, so `<response>` would
      // otherwise be rendered there as literal text.
      const summary = stripChatterMarkup(res.text.trim());
      if (summary) {
        teamLog.push(`${label}: ${summary.slice(0, 600)}`);
        text.push(`### \uD83D\uDD01 ${label} — team review\n\n${summary}`);
      }
    }
    // Kept apart from the lead's runs, and tagged with the reviewer they belong
    // to, so the console can nest them under that reviewer instead of mixing
    // them into the trajectory of the model that built the project.
    for (const run of res.toolRuns || []) {
      toolRuns.push({
        ...run,
        crew: { index: i + 1, total: workers.length, provider: worker.provider.name, model: worker.provider.model }
      });
    }
  }

  return { text: text.join('\n\n'), toolRuns, passes };
}

module.exports = {
  classifyComplexity,
  shouldRunCrew,
  pickWorkers,
  runCrewRefines,
  usableProvider
};
