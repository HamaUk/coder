// The recorded failure, replayed end to end.
//
// This test exists because the app shipped a turn that did all of this at once,
// and every part of it was invisible from the outside:
//
//   * the model wrote the SAME five files seven times, with different content
//     each pass, each pass smaller than the last — so the transcript ended with
//     the worst version of the project on disk and one narration paragraph
//     repeated seven times in the reply;
//   * the two crew reviewers streamed their own prose straight into the lead's
//     answer, so the user's reply contained a reviewer's `<response>` wrapper and
//     its tool echoes as plain text;
//   * nothing counted any of it as a repeat, because no two calls had identical
//     arguments.
//
// It drives the REAL agent loop, the REAL tool executor and the REAL finalize
// step against a mock provider that reproduces that turn, and asserts on what
// actually reaches the transcript.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-recorded-'));
process.env.HAMA_DATA_DIR = path.join(SCRATCH, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(SCRATCH, 'workspace');

const store = require(path.join(ROOT, 'src', 'store'));
const agent = require(path.join(ROOT, 'src', 'agent'));
const { finalizeChat } = require(path.join(ROOT, 'src', 'middleware', 'finalize'));
const shellKit = require(path.join(ROOT, 'src', 'shell'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const PARAGRAPH = "I'll create a complete set of template files for you — a Python script, a Windows batch file, an HTML page, a CSS stylesheet, and a JavaScript file — all working together as a small demo project. Let me build them now.";
const FILES = ['src/scripts/hello.py', 'src/scripts/run.bat', 'src/index.html', 'src/style.css', 'src/app.js'];
// The real turn shrank its output every pass: 1441 → 1201 → 1091 → … → 918 bytes.
const SIZE_BY_PASS = [1441, 1201, 1091, 1139, 1017, 1102, 918];

const REVIEW_MARKER = 'REVIEWER-PRIVATE-PROSE';

/**
 * A stand-in provider that replays the recorded turn.
 *
 * The lead model re-narrates and rewrites the same five files on every step,
 * exactly as the recorded model did. A request whose system prompt carries the
 * reviewer role (the crew's own prompt) answers with reviewer prose wrapped in
 * the `<response>` tags the real model used.
 */
function startRecordedProvider() {
  return new Promise((resolve) => {
    const seen = [];
    // The reviewer's own turn: first request asks for a file, the next speaks.
    // Counted here rather than inferred from the transcript, because the worker
    // is handed the LEAD's history and every "has this happened yet" probe is
    // therefore already true for it.
    let reviewerRequests = 0;
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-recorded' }] }));
      }
      if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
        res.writeHead(404);
        return res.end('not found');
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      await new Promise((r) => req.on('end', r));
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
      seen.push(parsed);

      const messages = parsed.messages || [];
      const system = String((messages[0] && messages[0].content) || '');
      const isReviewer = /team reviewer/i.test(system);
      const answered = messages.filter((m) => m.role === 'tool').length;
      const narrate = messages.filter((m) => m.role === 'assistant').length;

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      if (isReviewer) {
        // The reviewer reads a file, then writes prose inside `<response>`.
        reviewerRequests++;
        if (reviewerRequests === 1) {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_review_1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: FILES[0] }) } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ choices: [{ delta: { content: `<response>${REVIEW_MARKER} I improved the styles.</response>` } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // The lead: narrate, then rewrite the same files. Every pass has different
      // content — which is exactly why the identical-argument guard was blind to
      // it.
      if (narrate < 8) {
        const size = SIZE_BY_PASS[Math.min(narrate, SIZE_BY_PASS.length - 1)];
        send({ choices: [{ delta: { content: PARAGRAPH } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_write_' + narrate, type: 'function', function: {
          name: 'write_files',
          arguments: JSON.stringify({ files: FILES.map((p) => ({ path: p, content: 'x'.repeat(size) })) })
        } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: 'Done.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

function providerFor(port, id, name) {
  return {
    id, name, type: 'openai', enabled: true,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'mock-key', model: 'mock-recorded', toolsEnabled: true
  };
}

async function runTurn({ port, chatId, providers, settings }) {
  const events = [];
  const lead = providers[0];
  let result = null;
  let error = null;
  try {
    result = await agent.runAgent({
      provider: lead,
      providers,
      history: [{ role: 'user', content: 'create me some scripts python and bat and one html and one css and one javascript all them just template' }],
      tools: { web: false, files: true, code: true },
      settings,
      signal: null,
      emit: (type, data) => events.push({ type, ...data }),
      chatId,
      budget: { maxSteps: 14, maxAutoContinues: 0 }
    });
  } catch (e) {
    error = e;
  }
  return { events, result, error };
}

/** Creates the chat row the turn belongs to, the way the route does. */
async function makeChat(chatId, provider) {
  await store.mutateChats((chats) => {
    chats.push({
      id: chatId,
      title: 'create me some scripts',
      providerId: provider.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: store.uid(), role: 'user', content: 'create me some scripts python and bat', ts: Date.now() }]
    });
  });
}

(async () => {
  const mock = await startRecordedProvider();
  const lead = providerFor(mock.port, 'prov_lead', 'Hama AI');
  const worker = providerFor(mock.port, 'prov_worker', 'OpenRouter');

  // =========================================================================
  // 1. The lead turn — the rewrite loop and the repeated narration
  // =========================================================================
  const solo = { agentName: 'HAMA', agent: { mode: 'solo', crewEnabled: false, crewSize: 0 } };
  const turn = await runTurn({ port: mock.port, chatId: 'recorded_solo', providers: [lead], settings: solo });

  check('the turn completed without throwing', !turn.error, turn.error && turn.error.message);
  const text = (turn.result && turn.result.text) || '';
  const paragraphs = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const sameParagraph = paragraphs.filter((b) => b === PARAGRAPH).length;
  check('the repeated narration is kept exactly once', sameParagraph === 1,
    `${sameParagraph} copy/copies of the paragraph in ${paragraphs.length} block(s)`);

  const writes = (turn.result.toolRuns || []).filter((r) => r.name === 'write_files');
  const executed = writes.filter((r) => r.ok !== false);
  check('the rewrite loop is stopped well before the seventh pass', executed.length > 0 && executed.length <= 4,
    `${executed.length} write_files call(s) actually ran (the recorded turn ran 7); ${writes.length - executed.length} refused`);
  check('the refused pass is reported as a failure, with a reason the model can read', (() => {
    const refused = writes.find((r) => r.ok === false && /Refused/.test(String(r.result)));
    return Boolean(refused) && refused.meta && refused.meta.blocked === true;
  })());
  check('a repeat the guard noticed is marked on the run',
    (turn.result.toolRuns || []).some((r) => r.repeat === true));

  // =========================================================================
  // 2. What actually reaches the transcript
  // =========================================================================
  await makeChat('recorded_solo', lead);
  const { assistantMsg } = await finalizeChat({
    chatId: 'recorded_solo',
    result: turn.result,
    provider: lead,
    aborted: false,
    ms: 1234
  });
  const stored = assistantMsg || {};
  const storedBlocks = String(stored.content || '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  check('the SAVED reply holds one copy of the paragraph',
    storedBlocks.filter((b) => b === PARAGRAPH).length === 1,
    `${storedBlocks.length} block(s) stored`);
  check('the saved reply keeps the tool runs for the UI', (stored.toolRuns || []).length > 0,
    `${(stored.toolRuns || []).length} run(s)`);
  check('the saved turn records its duration', stored.ms === 1234);

  // =========================================================================
  // 3. The crew — a reviewer must not be able to speak as the lead
  // =========================================================================
  const crewed = { agentName: 'HAMA', agent: { mode: 'crew', crewEnabled: true, crewSize: 1 } };
  const withCrew = await runTurn({
    port: mock.port,
    chatId: 'recorded_crew',
    providers: [lead, worker],
    settings: crewed
  });

  check('the crew turn completed without throwing', !withCrew.error, withCrew.error && withCrew.error.message);
  const events = withCrew.events || [];

  // The crux: nothing the reviewer said may arrive as a LEAD token.
  const leadTokens = events.filter((e) => e.type === 'token').map((e) => String(e.text || '')).join('');
  check('the reviewer\'s prose never arrives as the lead\'s text',
    !leadTokens.includes(REVIEW_MARKER), leadTokens.includes(REVIEW_MARKER) ? 'LEAKED into token events' : 'clean');

  const crewTokens = events.filter((e) => e.type === 'crew_token').map((e) => String(e.text || '')).join('');
  check('the reviewer\'s prose arrives namespaced, under its own reviewer index',
    crewTokens.includes(REVIEW_MARKER) && events.some((e) => e.type === 'crew_token' && e.crewIndex === 1));
  check('a reviewer\'s tool call is namespaced too',
    events.some((e) => e.type === 'crew_tool_start') && !events.some((e) => e.type === 'tool_start' && e.id === 'call_review_1'));

  // The wrapper tags are chatter: they must not reach the answer even though the
  // reviewer's summary IS quoted into it.
  check('the `<response>` wrapper is stripped from the summary',
    !String((withCrew.result && withCrew.result.text) || '').includes('<response>'));

  const leadRuns = (withCrew.result && withCrew.result.toolRuns) || [];
  const crewRuns = (withCrew.result && withCrew.result.crewRuns) || [];
  check('the reviewers\' rows are kept apart from the lead\'s',
    crewRuns.length > 0 && crewRuns.every((r) => r.crew) && !leadRuns.some((r) => r.crew),
    `${leadRuns.length} lead run(s), ${crewRuns.length} reviewer run(s)`);
  check('a reviewer row names the reviewer that ran it',
    crewRuns.every((r) => r.crew && r.crew.index === 1 && r.crew.model));

  await makeChat('recorded_crew', lead);
  const crewSaved = await finalizeChat({
    chatId: 'recorded_crew',
    result: withCrew.result,
    provider: lead,
    aborted: false,
    ms: 4321
  });
  check('the saved crew turn carries the reviewers\' rows separately',
    Array.isArray(crewSaved.assistantMsg.crewRuns) && crewSaved.assistantMsg.crewRuns.length === crewRuns.length);
  check('the saved crew turn does not store the reviewer\'s markup',
    !String(crewSaved.assistantMsg.content).includes('<response>'));

  // =========================================================================
  // 4. The commit point, whatever assembled the text
  // =========================================================================
  // The seven stored copies did NOT come from one loop's buffer: the text was
  // concatenated from several runs (the lead, a repair round, a crew relay)
  // and/or rescued from the raw streamed floor in routes/chat.js — none of which
  // share the loop's per-iteration dedupe. finalize is the one point every path
  // passes through, so the collapse has to hold there too.
  await makeChat('recorded_segments', lead);
  const assembled = await finalizeChat({
    chatId: 'recorded_segments',
    result: { text: [PARAGRAPH, PARAGRAPH, PARAGRAPH].join('\n\n'), toolRuns: [] },
    provider: lead
  });
  check('a turn assembled from repeated segments is collapsed when committed',
    String(assembled.assistantMsg.content).split(/\n{2,}/).filter((b) => b.trim()).length === 1,
    JSON.stringify(String(assembled.assistantMsg.content).slice(0, 60)) + '…');

  await makeChat('recorded_refrain', lead);
  const refrain = [PARAGRAPH, 'Step one done.', PARAGRAPH, 'Step two done.', PARAGRAPH].join('\n\n');
  const keptRefrain = await finalizeChat({
    chatId: 'recorded_refrain',
    result: { text: refrain, toolRuns: [] },
    provider: lead
  });
  check('a refrain separated by real work is left alone',
    String(keptRefrain.assistantMsg.content) === refrain);

  mock.srv.close();
  shellKit.killAll();
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('CRASH', error);
  process.exit(2);
});
