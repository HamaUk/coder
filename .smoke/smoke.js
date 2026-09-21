// End-to-end smoke test against a throwaway data/workspace dir and a demo
// provider. Exercises the real path: route -> payload -> dispatch -> stream ->
// loop -> finalize, over the actual SSE wire format.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SMOKE = path.join(ROOT, '.smoke');
const DATA = path.join(SMOKE, 'data');
const WS = path.join(SMOKE, 'workspace');
const PORT = 3199;

for (const d of [DATA, WS]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [DATA, WS]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify([{
  id: 'prov_demo', name: 'Demo', type: 'demo', presetId: 'custom', apiKey: '',
  baseUrl: '', model: 'demo-model', temperature: 0.7, maxTokens: null,
  customInstructions: '', toolsEnabled: true, enabled: true, modelsCache: [],
  createdAt: 1, updatedAt: 1
}], null, 2));

const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HAMA_DATA_DIR: DATA, HAMA_WORKSPACE_DIR: WS },
  stdio: ['ignore', 'pipe', 'pipe']
});
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stdout.write('[srv:err] ' + d));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject); req.end(data);
  });
}
function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: out }));
    }).on('error', reject);
  });
}

function chatSSE(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      const events = [];
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = raw.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.end(data);
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  // wait for listen
  for (let i = 0; i < 60; i++) {
    try { await get('/api/bootstrap'); break; } catch { await sleep(150); }
  }

  // ---- 1. API keys are not leaked, hasKey is present --------------------
  const boot = JSON.parse((await get('/api/bootstrap')).body);
  const p0 = boot.providers[0];
  check('bootstrap omits apiKey', p0 && !('apiKey' in p0), JSON.stringify(Object.keys(p0 || {}).join(',')));
  check('bootstrap exposes hasKey', p0 && typeof p0.hasKey === 'boolean', 'hasKey=' + (p0 && p0.hasKey));

  // ---- 2. tools catalog includes the planning tool ---------------------
  check('update_todos in toolCatalog', boot.toolCatalog.some(t => t.name === 'update_todos'));

  // ---- 3. cross-origin POST is rejected --------------------------------
  const xo = await new Promise((resolve, reject) => {
    const data = Buffer.from('{}');
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/chats-clear', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Origin': 'http://evil.example' } },
      (res) => { let o = ''; res.on('data', c => o += c); res.on('end', () => resolve({ status: res.statusCode, body: o })); });
    req.on('error', reject); req.end(data);
  });
  check('cross-origin POST rejected', xo.status === 403, 'status ' + xo.status);

  // ---- 4. direct-mode chat end-to-end ----------------------------------
  const ev = await chatSSE({ chatId: null, message: 'build me a demo file please', mode: 'direct', providerId: 'prov_demo' });
  const types = ev.map(e => e.type);
  check('SSE: started', types.includes('started'));
  check('SSE: tokens streamed', types.filter(t => t === 'token').length > 0, types.filter(t => t === 'token').length + ' tokens');
  check('SSE: tool_start + tool_end', types.includes('tool_start') && types.includes('tool_end'));
  check('SSE: message_end terminal', types[types.length - 1] === 'message_end');
  const end = ev.find(e => e.type === 'message_end');
  const msg = end && end.message;
  check('assistant message persisted', msg && msg.role === 'assistant', msg ? `${(msg.content || '').length} chars` : 'none');
  check('tool run recorded', msg && msg.toolRuns && msg.toolRuns.length > 0, msg && msg.toolRuns ? msg.toolRuns.map(r => r.name).join(',') : '');
  check('no error event', !types.includes('error'), JSON.stringify(ev.find(e => e.type === 'error') || {}));
  // The demo returns its tool-call turn as one non-streamed block; the loop now
  // emits that text so the user sees it, which in turn means the separator that
  // divides prose from the tool card is emitted too.
  const streamed = ev.filter(e => e.type === 'token').map(e => e.text).join('');
  check('separator divides prose from tool card', types.includes('separator'));
  check('persisted text keeps the pre-tool narration',
    msg && msg.content.includes('create a welcome file'), (msg && msg.content || '').slice(0, 60));
  check('persisted text keeps the streamed tail',
    msg && streamed && msg.content.includes(streamed.slice(0, 40)), streamed.slice(0, 40));

  // The reply header shows how long the turn took and whether it was stopped, so
  // both have to reach the client — `aborted` was read by the UI for a while
  // before the server actually sent it.
  check('the persisted message carries the turn duration',
    msg && typeof msg.ms === 'number' && msg.ms >= 0, msg && String(msg.ms));
  check('message_end reports aborted=false for a completed turn',
    end && end.aborted === false, end && JSON.stringify(end.aborted));

  // ---- 4b. Stop's response shape (the registry is a Set per chat) -------
  const stopIdle = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/chat/chat_nothing_running/stop', method: 'POST' },
      (res) => { let o = ''; res.on('data', c => o += c); res.on('end', () => resolve(JSON.parse(o))); });
    req.on('error', reject); req.end();
  });
  check('stopping an idle chat is a no-op, not an error',
    stopIdle.ok === true && stopIdle.wasActive === false && stopIdle.stopped === 0, JSON.stringify(stopIdle));

  // ---- 5. the file the tool wrote really exists ------------------------
  const chatId = end && end.chat && (end.chat.id || (msg && msg.chatId));
  const written = path.join(WS, 'chats', chatId || '', 'demo', 'welcome.md');
  check('tool wrote the file to scratch workspace', fs.existsSync(written), written);

  // ---- 6. the chat is in the store ------------------------------------
  const chats = JSON.parse((await get('/api/chats')).body).chats;
  check('chat listed', chats.some(c => c.id === chatId), chats.map(c => c.id).join(','));

  // ---- 7. rename during/after streaming is not reverted ---------------
  const rn = await new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ title: 'renamed-by-smoke' }));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: `/api/chats/${chatId}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => { let o = ''; res.on('data', c => o += c); res.on('end', () => resolve({ status: res.statusCode, body: o })); });
    req.on('error', reject); req.end(data);
  });
  const after = JSON.parse((await get('/api/chats')).body).chats.find(c => c.id === chatId);
  check('rename survives', after && after.title === 'renamed-by-smoke', after && after.title);
  check('messages survive rename', after && after.messageCount >= 2, after && String(after.messageCount));

  // ---- 9. budgets are clamped -----------------------------------------
  const limits = require(path.join(ROOT, 'src', 'middleware', 'limits'));
  const cl = limits.resolveLimits({ maxSteps: 99999, maxAutoContinues: -5 }, {});
  check('maxSteps clamped to ceiling', cl.maxSteps === 400, String(cl.maxSteps));
  check('maxAutoContinues floors at 0', cl.maxAutoContinues === 0, String(cl.maxAutoContinues));

  // ---- 10. SSRF guard ---------------------------------------------------
  const tools = require(path.join(ROOT, 'src', 'tools'));
  const ssrf = await tools.execute('fetch_url', { url: 'http://127.0.0.1:3000/api/bootstrap' });
  check('fetch_url blocks loopback', ssrf.ok === false, String(ssrf.output).slice(0, 80));
  const ssrf2 = await tools.execute('fetch_url', { url: 'http://169.254.169.254/latest/meta-data/' });
  check('fetch_url blocks link-local metadata', ssrf2.ok === false, String(ssrf2.output).slice(0, 80));

  // ---- 11. delete_file refuses the workspace root ---------------------
  const del = await tools.execute('delete_file', { path: '.' }, {});
  check('delete_file refuses root', del.ok === false, String(del.output).slice(0, 80));

  // ---- 12. run_script is not shell-interpreted -------------------------
  await tools.execute('write_file', { path: 'run/hello.js', content: 'console.log("ok " + process.argv.slice(2).join("|"));' }, { chatId: 'smoke' });
  const sh = await tools.execute('run_script', { path: 'run/hello.js', args: ['x & echo INJECTED'] }, { chatId: 'smoke' });
  check('run_script passes args as argv, not shell', sh.ok && !/^INJECTED/m.test(sh.output) && sh.output.includes('x & echo INJECTED'),
    JSON.stringify(String(sh.output).trim().slice(0, 70)));

  // ---- 13. todo tool round-trip ---------------------------------------
  const todo = require(path.join(ROOT, 'src', 'middleware', 'todo'));
  todo.begin('smoke');
  const tr = await tools.execute('update_todos', { todos: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'pending' }] }, { todoKey: 'smoke' });
  check('update_todos ok', tr.ok === true);
  check('open items reported', todo.openItems('smoke').length === 1, todo.renderOpen('smoke'));
  todo.end('smoke');

  srv.kill();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH', e); srv.kill(); process.exit(2); });
