// "The files are far too small" — the completeness round.
//
// The recorded evidence: asked for scripts, a page, a stylesheet and a script,
// `amazon/nova-lite-v1` wrote 100 B, 30 B, 323 B, 144 B and 62 B — seven, two,
// thirteen, ten and three lines of boilerplate. The prompt already asks for
// 150–600-line files; a small model simply does not act on it. So the pipeline
// checks the work instead of trusting the model, and sends a set of skeletons
// back once with the exact file list and line counts.
//
// This drives the REAL agent loop against a mock provider that behaves like the
// small model: thin files first, real files when pushed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-substance-'));
process.env.HAMA_DATA_DIR = path.join(SCRATCH, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(SCRATCH, 'workspace');

const store = require(path.join(ROOT, 'src', 'store'));
const agent = require(path.join(ROOT, 'src', 'agent'));
const shellKit = require(path.join(ROOT, 'src', 'shell'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const THIN = [
  { path: 'web/index.html', lines: 13, body: '<!DOCTYPE html>\n<html>\n<body>\n<h1>Hello</h1>\n</body>\n</html>\n' },
  { path: 'web/styles.css', lines: 10, body: 'body {\n  color: #333;\n}\n' },
  { path: 'web/app.js', lines: 3, body: 'console.log("hello");\n' }
];

/** A file big enough that nothing could call it a skeleton. */
function bigFile(ext, lines) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    if (ext === 'html') out.push(`  <section class="card" id="card-${i}"><h2>Item ${i}</h2><p>Real content for item ${i}.</p></section>`);
    else if (ext === 'css') out.push(`.card-${i} { display: flex; gap: 12px; padding: ${i}px 16px; border-radius: 12px; }`);
    else out.push(`export function handler${i}(input) { if (!input) throw new Error('input required'); return input * ${i + 1}; }`);
  }
  return out.join('\n') + '\n';
}

/**
 * A stand-in for a small model that writes skeletons unless it is pushed.
 *
 * The push is detected by the phrase the completeness prompt uses ("skeletons"),
 * so if that wording ever changes this test fails loudly rather than silently
 * passing while the feature does nothing.
 */
function startMockProvider() {
  return new Promise((resolve) => {
    const state = { thinWritten: false, expanded: false, sawExpandAsk: false, calls: 0 };
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-substance' }] }));
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
      const messages = parsed.messages || [];
      state.calls++;

      const expandAsk = messages.some((m) => m.role === 'user' && /skeletons/i.test(String(m.content || '')));
      if (expandAsk) state.sawExpandAsk = true;

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const writeFiles = (files) => {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_w_' + state.calls, type: 'function', function: {
          name: 'write_files',
          arguments: JSON.stringify({ files })
        } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      };

      if (expandAsk && !state.expanded) {
        state.expanded = true;
        writeFiles([
          { path: 'web/index.html', content: bigFile('html', 160) },
          { path: 'web/styles.css', content: bigFile('css', 120) },
          { path: 'web/app.js', content: bigFile('js', 80) }
        ]);
      } else if (!state.thinWritten) {
        state.thinWritten = true;
        writeFiles(THIN.map((f) => ({ path: f.path, content: f.body })));
      } else {
        send({ choices: [{ delta: { content: 'Done — the site is in web/.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, state }));
  });
}

async function runTurn({ port, chatId, message }) {
  const provider = {
    id: 'mock_substance_provider', name: 'Mock Small', type: 'openai', enabled: true,
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'mock-key', model: 'mock-substance', toolsEnabled: true
  };
  const events = [];
  let result = null;
  let error = null;
  try {
    result = await agent.runAgent({
      provider,
      providers: [provider],
      history: [{ role: 'user', content: message }],
      tools: { web: false, files: true, code: true },
      settings: { agentName: 'HAMA', agent: { mode: 'solo', crewEnabled: false, crewSize: 0 } },
      signal: null,
      emit: (type, data) => events.push({ type, ...data }),
      chatId,
      budget: { maxSteps: 10, maxAutoContinues: 0 }
    });
  } catch (e) {
    error = e;
  }
  return { events, result, error };
}

async function makeChat(chatId, providerId) {
  await store.mutateChats((chats) => {
    chats.push({
      id: chatId, title: 'probe', providerId,
      createdAt: Date.now(), updatedAt: Date.now(),
      messages: [{ id: store.uid(), role: 'user', content: 'probe', ts: Date.now() }]
    });
  });
}

(async () => {
  const mock = await startMockProvider();

  // =========================================================================
  // 1. A skeleton project is sent back to be finished
  // =========================================================================
  await makeChat('substance_probe', 'mock_substance_provider');
  const turn = await runTurn({
    port: mock.port,
    chatId: 'substance_probe',
    message: 'build me a landing page with html css and js'
  });

  check('the turn completed without throwing', !turn.error, turn.error && turn.error.message);
  check('the model was asked a second time, specifically about the thin files',
    mock.state.sawExpandAsk, mock.state.expanded ? 'expansion round ran' : 'never asked');
  check('the transcript says why the turn took longer',
    /skeletons/i.test(String((turn.result && turn.result.text) || '')));
  check('the app announced the round instead of doing it silently',
    (turn.events || []).some((e) => e.type === 'status' && /too thin/i.test(String(e.text || ''))));

  const writes = (turn.result.toolRuns || []).filter((r) => r.name === 'write_files');
  check('both passes are recorded as tool runs', writes.length === 2, writes.length + ' write(s)');

  // The real proof: what ended up on disk is the finished version, not the stub.
  const ws = path.join(process.env.HAMA_WORKSPACE_DIR, 'chats', 'substance_probe', 'web');
  const html = fs.existsSync(path.join(ws, 'index.html')) ? fs.readFileSync(path.join(ws, 'index.html'), 'utf8') : '';
  const lines = html ? html.split('\n').length : 0;
  check('the file on disk is the substantial version, not the skeleton', lines > 100, lines + ' lines');

  // =========================================================================
  // 2. A deliberately trivial ask is left alone
  // =========================================================================
  mock.state.thinWritten = false;
  mock.state.expanded = false;
  mock.state.sawExpandAsk = false;
  mock.state.calls = 0;
  await makeChat('substance_trivial', 'mock_substance_provider');
  const trivial = await runTurn({
    port: mock.port,
    chatId: 'substance_trivial',
    message: 'write a hello world script in python'
  });
  check('a "hello world" ask is not pushed to 150 lines',
    !mock.state.sawExpandAsk && trivial.result && trivial.result.toolRuns.length > 0,
    mock.state.sawExpandAsk ? 'expansion fired on a trivial ask' : 'left alone');

  // =========================================================================
  // 3. The trigger itself, including the message that started all this
  // =========================================================================
  {
    // The exact request from the recorded turn. It must NOT be mistaken for a
    // deliberately trivial ask: "just template" is a request for a template, and
    // the user's complaint was that the template came back as three lines.
    const recordedAsk = 'create me some  scripts   python and  bat and one html and one css and one javascriot all them just template i need to test you how good are you';
    check('the recorded request is treated as real work, not a trivial ask',
      !agent.TRIVIAL_ASK.test(recordedAsk));

    check('"hello world" and "a 10-line script" are recognised as deliberately tiny',
      agent.TRIVIAL_ASK.test('print hello world in python')
      && agent.TRIVIAL_ASK.test('write me a 10-line bash script'));

    // What the recorded turn actually wrote.
    const recordedRuns = [
      { name: 'write_file', ok: true, args: { path: 'scripts/test_script.py', content: '# x\n'.repeat(7) }, meta: { lines: 7, bytes: 100 } },
      { name: 'write_file', ok: true, args: { path: 'scripts/test_script.bat', content: '@echo off\n' }, meta: { lines: 2, bytes: 30 } },
      { name: 'write_file', ok: true, args: { path: 'web/index.html', content: '<html></html>\n' }, meta: { lines: 13, bytes: 323 } },
      { name: 'write_file', ok: true, args: { path: 'web/styles.css', content: 'body{}\n' }, meta: { lines: 10, bytes: 144 } },
      { name: 'write_file', ok: true, args: { path: 'web/script.js', content: 'console.log(1)\n' }, meta: { lines: 3, bytes: 62 } }
    ];
    const thin = agent.skeletalFiles(recordedRuns);
    check('the recorded output is recognised as a set of skeletons',
      Array.isArray(thin) && thin.length === 5, thin ? thin.length + ' thin file(s)' : 'not detected');

    check('a project with one substantial file is NOT pushed',
      agent.skeletalFiles([
        { name: 'write_file', ok: true, args: { path: 'app.js' }, meta: { lines: 220, bytes: 8000 } },
        { name: 'write_file', ok: true, args: { path: 'index.html' }, meta: { lines: 12, bytes: 300 } }
      ]) === null);

    check('a single small file is a snippet, not a project to expand',
      agent.skeletalFiles([
        { name: 'write_file', ok: true, args: { path: 'a.py' }, meta: { lines: 5, bytes: 80 } }
      ]) === null);

    check('a failed write is not counted as created work',
      agent.createdFiles([{ name: 'write_file', ok: false, args: { path: 'nope.js' }, meta: { lines: 1, bytes: 5 } }]).length === 0);

    check('the expansion prompt names each file with its real size', (() => {
      const prompt = agent.buildExpandPrompt(thin || []);
      return /scripts\/test_script\.py — 7 lines, 100 bytes/.test(prompt)
        && /web\/index\.html — 13 lines, 323 bytes/.test(prompt)
        && /append/.test(prompt);
    })());
  }

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
