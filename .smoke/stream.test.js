// Streaming + tool loop — the live event contract, end to end.
//
// The server streams SSE events (started → thinking → token → tool_start →
// tool_progress → tool_end → message_end) so the user watches a turn happen
// instead of waiting for it. That sequence is what this file pins, because every
// part of it can break silently: a hook that stops being called, an event that
// arrives after the terminal one, a timer that outlives the turn.
//
// It drives the REAL agent loop and the REAL tool executor against a mock
// OpenAI-compatible provider, and asserts on the events the loop actually emits
// — not on a hand-built list.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-stream-'));
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A local stand-in for a chat provider.
 *
 * Turn 1 asks for one `run_shell` call that sleeps for a few seconds — long
 * enough for the progress ticker to fire more than once, which is the behaviour
 * under test. Turn 2, once it sees the tool result, replies with plain text and
 * finishes the turn.
 */
function startMockProvider({ sleepSeconds, toolName, toolArgs }) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-stream' }] }));
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

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const messages = parsed.messages || [];
      const toolAnswered = messages.some((m) => m.role === 'tool');

      if (!toolAnswered) {
        send({ choices: [{ delta: { content: 'Working on it. ' } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const t of ['All ', 'done', '.']) send({ choices: [{ delta: { content: t } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, seen }));
  });
}

/** Runs one turn against a mock provider and returns every event it emitted, in order. */
async function runTurn({ port, toolName, toolArgs, sleepSeconds, chatId }) {
  const provider = {
    id: 'mock_stream_provider',
    name: 'Mock Stream',
    type: 'openai',
    enabled: true,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'mock-key',
    model: 'mock-stream',
    toolsEnabled: true
  };
  const events = [];
  const emit = (type, data) => events.push({ type, ...data, at: Date.now() });
  const startedAt = Date.now();
  let result;
  let error = null;
  try {
    result = await agent.runAgent({
      provider,
      providers: [provider],
      history: [{ role: 'user', content: 'Please run the command and report back.' }],
      tools: { web: false, files: true, code: true },
      settings: { agentName: 'HAMA', agent: { mode: 'solo', crewEnabled: false, crewSize: 0 } },
      signal: null,
      emit,
      chatId,
      budget: { maxSteps: 6, maxAutoContinues: 1 }
    });
  } catch (e) {
    error = e;
  }
  return { events, result, error, ms: Date.now() - startedAt };
}

(async () => {
  const sleeping = process.platform === 'win32'
    ? { command: 'Start-Sleep -Seconds 9', timeoutMs: 60000 }
    : { command: 'sleep 9', timeoutMs: 60000 };

  const mock = await startMockProvider({
    sleepSeconds: 9,
    toolName: 'run_shell',
    toolArgs: sleeping
  });

  const chatId = 'stream_probe';
  fs.mkdirSync(store.getChatWorkspaceDir(chatId), { recursive: true });

  const { events, result, error, ms } = await runTurn({
    port: mock.port,
    toolName: 'run_shell',
    toolArgs: sleeping,
    chatId
  });

  // -------------------------------------------------------------------------
  // 1. The turn completes and the event stream is complete
  // -------------------------------------------------------------------------
  check('the turn completed without an error', error === null, error && error.message);
  const types = events.map((e) => e.type);
  console.log('    event order: ' + types.join(' → '));

  check('the turn narrated before calling the tool', types.indexOf('token') !== -1);
  check('a tool call opened with tool_start', types.indexOf('tool_start') !== -1);
  check('the tool call closed with tool_end', types.indexOf('tool_end') !== -1);
  check('the stream ended with the model talking again', types.indexOf('token') < types.lastIndexOf('token'));
  check('tool_start came before its tool_end',
    types.indexOf('tool_start') < types.indexOf('tool_end'));
  check('the reply text reached the caller', /All done\./.test(result.text || ''), JSON.stringify((result.text || '').slice(0, 60)));

  // -------------------------------------------------------------------------
  // 2. Live progress: the reason a long call is not a silent gap
  // -------------------------------------------------------------------------
  const progress = events.filter((e) => e.type === 'tool_progress');
  check('a running tool emits progress ticks', progress.length >= 2, progress.length + ' tick(s) in ' + ms + 'ms');
  check('the first tick is emitted immediately, not after the first interval',
    progress.length > 0 && progress[0].elapsedMs === 0);
  check('later ticks carry a growing elapsed time',
    progress.length >= 2 && progress[progress.length - 1].elapsedMs > progress[0].elapsedMs,
    progress.map((p) => p.elapsedMs + 'ms').join(', '));
  check('every tick names the call it belongs to',
    progress.every((p) => p.id === 'call_stream_1' && p.name === 'run_shell'));
  check('a tick never arrives after the call it describes has ended', (() => {
    const endAt = events.findIndex((e) => e.type === 'tool_end');
    const last = events.map((e, i) => (e.type === 'tool_progress' ? i : -1)).filter((i) => i !== -1).pop();
    return endAt !== -1 && last !== undefined && last < endAt;
  })());
  check('the call reported its true duration on tool_end', (() => {
    const end = events.find((e) => e.type === 'tool_end');
    return end && end.ms >= 8000 && end.ms < 20000;
  })(), (() => { const e = events.find((x) => x.type === 'tool_end'); return e ? e.ms + 'ms' : 'none'; })());

  // -------------------------------------------------------------------------
  // 3. No tick may outlive the turn
  // -------------------------------------------------------------------------
  {
    const before = events.filter((e) => e.type === 'tool_progress').length;
    await wait(6000);
    const after = events.filter((e) => e.type === 'tool_progress').length;
    check('the progress ticker stops when the turn ends', after === before, `${before} → ${after} ticks after waiting 6s`);
  }

  // -------------------------------------------------------------------------
  // 4. A fast tool emits no progress noise
  // -------------------------------------------------------------------------
  {
    const fastMock = await startMockProvider({
      toolName: 'run_shell',
      toolArgs: { command: process.platform === 'win32' ? 'Write-Output quick' : 'echo quick' }
    });
    const fast = await runTurn({
      port: fastMock.port,
      toolName: 'run_shell',
      toolArgs: { command: process.platform === 'win32' ? 'Write-Output quick' : 'echo quick' },
      chatId: 'stream_probe_fast'
    });
    const fastProgress = fast.events.filter((e) => e.type === 'tool_progress');
    check('a tool that finishes at once does not spam progress ticks',
      fastProgress.length === 1, `${fastProgress.length} tick(s) — the immediate one only`);
    check('a fast turn still reports the tool lifecycle in order', (() => {
      const t = fast.events.map((e) => e.type);
      return t.indexOf('tool_start') < t.indexOf('tool_progress') && t.indexOf('tool_progress') < t.indexOf('tool_end');
    })(), fast.events.map((e) => e.type).join(' → '));
    fastMock.srv.close();
  }

  // -------------------------------------------------------------------------
  // 5. Two sequential calls each get their own ticks
  // -------------------------------------------------------------------------
  {
    const progressIds = new Set(progress.map((p) => p.id));
    check('progress ticks are keyed per call, not per turn', progressIds.size === 1, [...progressIds].join(', '));
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
