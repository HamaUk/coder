// Persistence guarantees: whatever the user SAW must survive into the transcript.
//
// The recorded failure: a turn streamed seven tool steps to the client, the
// client-side handler then crashed, and when the page reloaded the chat held
// only the user's message — the entire turn was gone. Two paths can drop it:
//
//   1. A throw AFTER the main loop (repair, crew, auto-save) discarded the main
//      run's result: the error carried no partial, the route merged nothing,
//      finalize saw an empty result and skipped the save.
//   2. A client that disconnects mid-turn aborts the loop; the route must still
//      persist whatever was streamed before the abort.
//
// This file drives the REAL server (spawned like dsml.test.js does) against a
// mock OpenAI-compatible provider and asserts the transcript after the fact.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-persist-'));
process.env.HAMA_DATA_DIR = path.join(SCRATCH, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(SCRATCH, 'workspace');
fs.mkdirSync(process.env.HAMA_DATA_DIR, { recursive: true });

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The provider the server will talk to, saved BEFORE the server boots. */
let mockPort = 0;
const seenCalls = [];
function startMockProvider() {
  const state = { torn: false, delayFinal: false };
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'persist-mock' }] }));
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
      seenCalls.push(parsed);
      const messages = parsed.messages || [];
      const toolAnswered = messages.some((m) => m.role === 'tool');

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      if (!toolAnswered) {
        send({ choices: [{ delta: { content: 'Building it now. ' } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_persist_1', type: 'function', function: { name: 'write_files', arguments: JSON.stringify({ files: { 'site/index.html': '<!doctype html>', 'site/style.css': 'body{}' } }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else if (state.torn) {
        // Stream part of the answer, then die mid-flight — the adapter throws.
        send({ choices: [{ delta: { content: 'Half an answer' } }] });
        res.write('data: {"choices":[{"delta":{');
        res.end(); // torn stream
        return;
      } else {
        if (state.delayFinal) {
          await wait(2000);
        }
        send({ choices: [{ delta: { content: 'All done.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => {
      mockPort = srv.address().port;
      resolve({ srv, state });
    });
  });
}

/** Saves the provider config the server will read at boot. */
function writeProviderConfig(port) {
  const provider = {
    id: 'prov_persist_mock',
    name: 'Persist Mock',
    type: 'openai',
    enabled: true,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'mock-key',
    model: 'persist-mock',
    temperature: 0.4,
    maxTokens: 20000,
    customInstructions: '',
    toolsEnabled: true,
    modelsCache: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const settings = {
    agentName: 'HAMA',
    defaultProviderId: 'prov_persist_mock',
    globalInstructions: '',
    agent: { mode: 'solo', crewEnabled: false, crewSize: 0, maxSteps: 40, maxAutoContinues: 4 }
  };
  fs.writeFileSync(path.join(process.env.HAMA_DATA_DIR, 'providers.json'), JSON.stringify([provider], null, 2));
  fs.writeFileSync(path.join(process.env.HAMA_DATA_DIR, 'settings.json'), JSON.stringify(settings, null, 2));
}

/** Reads the SSE stream of one chat turn to completion, collecting events. */
function postChat(port, message) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let buf = '';
      const events = [];
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          try { events.push(JSON.parse(data.slice(6))); } catch { /* ignore */ }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ message, tools: { web: false, files: true, code: true } }));
    req.end();
  });
}

/** A chat turn whose socket is destroyed right after the first tool_end. */
function postChatAndHangUp(port, message) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        if (buf.includes('"tool_end"')) {
          // The client crashed here — its reader is gone. Close the socket.
          console.log('[test] hang-up: destroying at ' + Date.now());
          req.destroy();
          resolve(null);
        }
      });
      res.on('end', () => resolve(null));
    });
    req.on('error', () => resolve(null)); // destroying is the expected outcome
    req.write(JSON.stringify({ message, tools: { web: false, files: true, code: true } }));
    req.end();
  });
}

async function getJSON(port, pathname) {
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => resolve({ status: r.statusCode, body }));
    }).on('error', reject);
  });
  return { status: res.status, data: JSON.parse(res.body) };
}

async function bootServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => process.stdout.write('[srv-err] ' + c));
  // The banner prints the port: "running at http://localhost:NNNN".
  const port = await new Promise((resolve) => {
    const timer = setInterval(() => {
      const m = /http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(stdout);
      if (m) { clearInterval(timer); resolve(Number(m[1])); }
    }, 100);
  });
  return { child, port };
}

(async () => {
  const mock = await startMockProvider();
  writeProviderConfig(mockPort);

  const { child, port } = await bootServer();

  // -------------------------------------------------------------------------
  // 1. A clean turn persists everything
  // -------------------------------------------------------------------------
  const events = await postChat(port, 'create a small site with index.html and style.css');
  const messageEnd = events.find((e) => e.type === 'message_end');
  check('a clean turn ends with message_end', Boolean(messageEnd), events.map((e) => e.type).join(','));
  check('the clean turn persisted an assistant message',
    messageEnd && messageEnd.message && messageEnd.chat && messageEnd.chat.messageCount >= 2,
    messageEnd && JSON.stringify(messageEnd.chat));
  check('the persisted message carries the tool runs',
    messageEnd && messageEnd.message && messageEnd.message.toolRuns && messageEnd.message.toolRuns.length === 1,
    messageEnd && messageEnd.message && String((messageEnd.message.toolRuns || []).length));
  check('the persisted run kept its arguments for the UI',
    messageEnd && messageEnd.message.toolRuns[0].args.files && messageEnd.message.toolRuns[0].args.files['site/index.html'] === '<!doctype html>');

  const chatId = messageEnd.chat.id;
  const after = await getJSON(port, `/api/chats/${chatId}`);
  check('the transcript on disk matches what streamed',
    after.data.chat && after.data.chat.messages.length === 2
    && after.data.chat.messages[1].toolRuns.length === 1,
    JSON.stringify((after.data.chat && after.data.chat.messages || []).map((m) => m.role)).slice(0, 80));

  // -------------------------------------------------------------------------
  // 2. A provider that dies mid-answer still persists the partial turn
  // -------------------------------------------------------------------------
  mock.state.torn = true;
  const torn = await postChat(port, 'another small project please');
  const tornEnd = torn.find((e) => e.type === 'message_end');
  check('a torn stream still reaches message_end', Boolean(tornEnd), torn.map((e) => e.type).join(','));
  check('a torn stream persisted the partial answer',
    tornEnd && tornEnd.message && /Building it now|Half an answer/.test(tornEnd.message.content || ''),
    tornEnd && JSON.stringify(String(tornEnd.message && tornEnd.message.content || '').slice(0, 60)));
  check('a torn stream persisted its tool runs',
    tornEnd && tornEnd.message && (tornEnd.message.toolRuns || []).length >= 1,
    tornEnd && String((tornEnd.message && tornEnd.message.toolRuns || []).length));

  // -------------------------------------------------------------------------
  // 3. A client that hangs up mid-turn — the crash that lost a whole turn
  // -------------------------------------------------------------------------
  mock.state.torn = false;
  mock.state.delayFinal = true; // keep the turn alive so the hang-up lands mid-flight
  const hangUpPrompt = 'build one more page and then crash me';
  await postChatAndHangUp(port, hangUpPrompt);
  // The server needs a moment to finish the aborted turn and finalize.
  await wait(2500);

  // Found by its own user message: the chat list is ordered newest-first, so
  // indexing from either end is a guess about ordering rather than a lookup.
  const chats = await getJSON(port, '/api/chats');
  let hangUpChat = null;
  for (const c of chats.data.chats) {
    const d = await getJSON(port, `/api/chats/${c.id}`);
    if ((d.data.chat.messages || []).some((m) => m.role === 'user' && m.content === hangUpPrompt)) {
      hangUpChat = d.data.chat;
      break;
    }
  }
  check('the hung-up turn exists in the store', Boolean(hangUpChat));
  const msgs = hangUpChat.messages;
  const lastAssistant = msgs[msgs.length - 1];
  check('a hung-up turn still persisted its assistant message',
    lastAssistant.role === 'assistant', JSON.stringify(msgs.map((m) => m.role)));
  check('the hung-up turn is marked aborted, not completed',
    lastAssistant.aborted === true,
    JSON.stringify({ aborted: lastAssistant.aborted, content: String(lastAssistant.content).slice(0, 60) }));
  check('the hung-up turn kept its streamed tool runs',
    (lastAssistant.toolRuns || []).length >= 1,
    String((lastAssistant.toolRuns || []).length));
  check('the hung-up turn did NOT receive the answer the provider sent after the hang-up',
    !/All done\./.test(String(lastAssistant.content || '')),
    JSON.stringify(String(lastAssistant.content || '').slice(0, 60)));

  // -------------------------------------------------------------------------
  // 4. Cross-chat confinement of the file API
  //
  // Every one of these returned 200 before: an id that sanitises to nothing
  // (`.`, `..`, `///`) made the base directory fall back to the shared root, and
  // a request naming `chats/<other>/…` then read another conversation's files.
  // The routes that took no chatId at all served the whole workspace.
  // -------------------------------------------------------------------------
  for (const badId of ['..', '.', '///', '%20', 'a/b']) {
    const r = await getJSON(port, `/api/files/raw?chatId=${encodeURIComponent(badId)}&path=${encodeURIComponent('chats/anything/secret.txt')}`);
    check(`/api/files/raw rejects chatId=${JSON.stringify(badId)}`,
      r.status === 400, `status ${r.status}`);
  }
  const noChat = await getJSON(port, '/api/files/raw?path=chats%2Fx%2Fsecret.txt');
  check('/api/files/raw requires a chatId', noChat.status === 400, `status ${noChat.status}`);
  const noChatZip = await getJSON(port, '/api/files/zip');
  check('/api/files/zip requires a chatId', noChatZip.status === 400, `status ${noChatZip.status}`);
  const badTree = await getJSON(port, '/api/files/tree?chatId=..');
  check('/api/files/tree rejects an invalid chatId',
    badTree.status === 400 || (badTree.status === 200 && Array.isArray(badTree.data.tree) && badTree.data.tree.length === 0),
    `status ${badTree.status}`);

  child.kill();
  mock.srv.close();
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('CRASH', error);
  process.exit(2);
});
