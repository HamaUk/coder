// End-to-end provider test.
//
// The user-facing promise is "connect any provider and it works — as an agent and
// as a plain chat". This suite proves it against real mock endpoints that speak
// each protocol, exercising the whole path: add provider -> list models -> test
// connection -> probe -> normal chat -> agent chat (tool call + result) ->
// global rules reaching every model, and disappearing again when cleared.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Mock providers — one per wire protocol. Each records what it was sent, which
// is how the global-rules assertions can inspect the real system prompt.
// ---------------------------------------------------------------------------
function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const seen = [];

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function startOpenAICompat() {
  return listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }] }));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const body = await readBody(req);
      seen.push({ kind: 'openai', auth: req.headers.authorization || '', body });
      const messages = body.messages || [];
      const system = (messages.find((m) => m.role === 'system') || {}).content || '';
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const toolAnswered = messages.some((m) => m.role === 'tool');
      const userText = messages.filter((m) => m.role === 'user').map((m) => String(m.content || '')).join(' ');
      const send = sse(res);
      // Deliberately emit a tool call for a tool that was NOT offered, so the
      // executor's enabled-set check can be observed from the outside.
      if (/hallucinate/.test(userText) && !toolAnswered) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_h', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'mock/forbidden.txt', content: 'should never exist' }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (hasTools && !toolAnswered) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: 'mock/hello.txt', content: 'hi from the mock provider' }) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const t of ['MOCK-', 'REPLY-', 'OK']) send({ choices: [{ delta: { content: t } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404); res.end('not found');
  });
}

async function startAnthropic() {
  return listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'claude-mock' }] }));
    }
    if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
      const body = await readBody(req);
      seen.push({ kind: 'anthropic', key: req.headers['x-api-key'] || '', body });
      const send = sse(res);
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ANTHROPIC-OK' } });
      send({ type: 'message_stop' });
      return res.end();
    }
    res.writeHead(404); res.end('not found');
  });
}

async function startGoogle() {
  return listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: [{ name: 'models/gemini-mock', supportedGenerationMethods: ['generateContent'] }] }));
    }
    if (req.method === 'POST' && url.pathname.includes(':streamGenerateContent')) {
      const body = await readBody(req);
      seen.push({ kind: 'google', key: req.headers['x-goog-api-key'] || '', body });
      const send = sse(res);
      send({ candidates: [{ content: { parts: [{ text: 'GOOGLE-OK' }] } }] });
      return res.end();
    }
    res.writeHead(404); res.end('not found');
  });
}

// ---------------------------------------------------------------------------
// HAMA server on a scratch store
// ---------------------------------------------------------------------------
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-prov-'));
const WS = path.join(DATA, 'workspace');
const PORT = 3221;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function chat(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      const events = [];
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(6))); } catch { /* skip */ }
        }
      });
      res.on('end', () => resolve(events));
    });
    r.on('error', reject); r.end(data);
  });
}

const lastByKind = (kind) => [...seen].reverse().find((s) => s.kind === kind);

(async () => {
  const openai = await startOpenAICompat();
  const anthropic = await startAnthropic();
  const google = await startGoogle();

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HAMA_DATA_DIR: DATA, HAMA_WORKSPACE_DIR: WS },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let srvErr = '';
  srv.stderr.on('data', (d) => { srvErr += d.toString(); });

  const finish = () => {
    try { srv.kill(); } catch { /* ignore */ }
    for (const s of [openai, anthropic, google]) { try { s.srv.close(); } catch { /* ignore */ } }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    if (srvErr.trim()) console.log('server stderr:\n' + srvErr.trim().slice(0, 800));
    process.exit(passed === results.length ? 0 : 1);
  };

  // Wait for boot.
  for (let i = 0; i < 60; i++) {
    try { await req('GET', '/api/bootstrap'); break; } catch { await sleep(100); }
  }
  // The store seeds a free engine on first read. Take it out of play so nothing
  // in this suite reaches the real network.
  await req('PUT', '/api/providers/prov_llamacoder', { enabled: false });

  // -------------------------------------------------------------------------
  // 1. Add a provider through the real API
  // -------------------------------------------------------------------------
  const created = await req('POST', '/api/providers', {
    name: 'Mock OpenAI', type: 'openai', presetId: 'custom',
    apiKey: 'sk-mock-key',
    baseUrl: `http://127.0.0.1:${openai.port}/v1`,
    model: 'mock-small',
    temperature: 0.5, maxTokens: null,
    customInstructions: '', toolsEnabled: true, enabled: true, modelsCache: []
  });
  const prov = created.provider;
  check('a provider can be added', !!prov && !!prov.id, JSON.stringify(created).slice(0, 120));
  check('the new provider reports hasKey', prov && prov.hasKey === true);
  check('the API key is never returned to the browser', prov && prov.apiKey === undefined,
    JSON.stringify(Object.keys(prov || {})).slice(0, 140));

  // It must appear in bootstrap, selected-ready.
  const boot = await req('GET', '/api/bootstrap');
  check('the new provider appears in bootstrap',
    boot.providers.some((p) => p.id === prov.id));

  // -------------------------------------------------------------------------
  // 2. Model listing + connection test
  // -------------------------------------------------------------------------
  const models = await req('POST', '/api/models', { type: 'openai', baseUrl: `http://127.0.0.1:${openai.port}/v1`, apiKey: 'sk-mock-key', providerId: prov.id });
  check('models can be fetched for the new provider',
    models.ok === true && models.models.includes('mock-small'), JSON.stringify(models).slice(0, 140));

  const tested = await req('POST', `/api/providers/${prov.id}/test`, {});
  check('the connection test succeeds', tested.ok === true, JSON.stringify(tested).slice(0, 160));

  const probe = await req('POST', '/api/models/check', {
    type: 'openai', baseUrl: `http://127.0.0.1:${openai.port}/v1`, apiKey: 'sk-mock-key', providerId: prov.id, models: ['mock-small']
  });
  check('the model probe runs', probe.ok === true && Array.isArray(probe.results),
    JSON.stringify(probe).slice(0, 160));
  const probeRow = (probe.results || [])[0] || {};
  check('the probe reports the tool-call capability',
    probeRow.ok === true && probeRow.canCallTools === true, JSON.stringify(probeRow).slice(0, 160));

  // -------------------------------------------------------------------------
  // 3. Normal (tool-free) chat works
  // -------------------------------------------------------------------------
  // Isolate the provider path: with the seeded free engine still enabled, a
  // "project-like" request would dispatch the multi-model team and call it over
  // the real network, which has nothing to do with what is under test here.
  await req('PUT', '/api/settings', { agent: { mode: 'solo' } });

  const normal = await chat({
    chatId: null, providerId: prov.id, model: 'mock-small',
    message: 'say hi', tools: { web: false, files: false, code: false }
  });
  const normalEnd = normal.find((e) => e.type === 'message_end');
  check('a normal chat completes', !!normalEnd && !!normalEnd.message, JSON.stringify(normal.map((e) => e.type)));
  check('a normal chat streams the reply',
    normalEnd && /MOCK-REPLY-OK/.test(normalEnd.message.content || ''),
    normalEnd && (normalEnd.message.content || '').slice(0, 60));
  check('a normal chat sends no tools to the provider',
    lastByKind('openai') && lastByKind('openai').body.tools === undefined,
    JSON.stringify((lastByKind('openai').body.tools) || null).slice(0, 80));
  check('the normal chat sends no tool runs', normalEnd && (normalEnd.message.toolRuns || []).length === 0);
  const normalSys = ((lastByKind('openai').body.messages || []).find((m) => m.role === 'system') || {}).content || '';
  check('a tool-free chat is told it has no tools',
    /No external tools are enabled/.test(normalSys), normalSys.slice(-140));

  // A model that names a tool it was never offered must be refused, not obeyed.
  const hallucinated = await chat({
    chatId: null, providerId: prov.id, model: 'mock-small',
    message: 'hallucinate a tool call', tools: { web: false, files: false, code: false }
  });
  const hEnd = hallucinated.find((e) => e.type === 'message_end');
  const hRuns = (hEnd && hEnd.message && hEnd.message.toolRuns) || [];
  check('a tool the conversation never offered is refused',
    hRuns.some((r) => r.ok === false && /not enabled for this conversation/.test(String(r.result))),
    JSON.stringify(hRuns.map((r) => r.name + ':' + r.ok)).slice(0, 120));
  const hChatId = hEnd && hEnd.chat && hEnd.chat.id;
  check('the refused tool produced no file',
    !fs.existsSync(path.join(WS, 'chats', hChatId || '', 'mock', 'forbidden.txt')));

  // -------------------------------------------------------------------------
  // 4. Agent chat works: the tool is called, executed and answered
  // -------------------------------------------------------------------------
  const agent = await chat({
    chatId: null, providerId: prov.id, model: 'mock-small',
    message: 'create the mock file', tools: { web: false, files: true, code: false }
  });
  const agentEnd = agent.find((e) => e.type === 'message_end');
  check('an agent chat completes', !!agentEnd && !!agentEnd.message);
  check('the agent chat exposes the tool definitions',
    lastByKind('openai') && Array.isArray(lastByKind('openai').body.tools) && lastByKind('openai').body.tools.length > 0);
  const runs = (agentEnd && agentEnd.message && agentEnd.message.toolRuns) || [];
  check('the tool call was executed', runs.some((r) => r.name === 'write_file' && r.ok === true),
    runs.map((r) => r.name + (r.ok ? '' : ':fail')).join(','));
  const chatId = agentEnd && agentEnd.chat && agentEnd.chat.id;
  const written = path.join(WS, 'chats', chatId || '', 'mock', 'hello.txt');
  check('the tool really wrote the file', fs.existsSync(written), written);
  check('the agent still delivers a final answer',
    /MOCK-REPLY-OK/.test((agentEnd && agentEnd.message && agentEnd.message.content) || ''),
    (agentEnd && agentEnd.message && agentEnd.message.content || '').slice(0, 60));
  check('the tool result was fed back to the provider',
    seen.some((s) => s.body.messages && s.body.messages.some((m) => m.role === 'tool')));

  // -------------------------------------------------------------------------
  // 5. Global rules reach every model, then fall back to default when cleared
  // -------------------------------------------------------------------------
  const RULE = 'OPERATOR-RULE-SENTINEL: always answer in French.';
  await req('PUT', '/api/settings', { globalInstructions: RULE });

  seen.length = 0;
  await chat({ chatId: null, providerId: prov.id, model: 'mock-small', message: 'bonjour', tools: { web: false, files: false, code: false } });
  const withRule = lastByKind('openai');
  const sysWith = ((withRule.body.messages || []).find((m) => m.role === 'system') || {}).content || '';
  check('global rules reach the system prompt', sysWith.includes(RULE), sysWith.slice(-120));
  check('global rules are stated as binding for every model',
    /binding for every model and every reply/i.test(sysWith));

  // "All models" has to mean all of them, not just the OpenAI-compatible path.
  const aProvForRules = (await req('POST', '/api/providers', {
    name: 'Rules Anthropic', type: 'anthropic', presetId: 'anthropic', apiKey: 'sk-ant-mock',
    baseUrl: `http://127.0.0.1:${anthropic.port}`, model: 'claude-mock',
    temperature: 0.5, maxTokens: 1024, customInstructions: '', toolsEnabled: true, enabled: true, modelsCache: []
  })).provider;
  await chat({ chatId: null, providerId: aProvForRules.id, model: 'claude-mock', message: 'bonjour', tools: { web: false, files: false, code: false } });
  check('global rules reach an Anthropic provider',
    String(lastByKind('anthropic').body.system || '').includes(RULE));

  const gProvForRules = (await req('POST', '/api/providers', {
    name: 'Rules Google', type: 'google', presetId: 'google', apiKey: 'gmock',
    baseUrl: `http://127.0.0.1:${google.port}/v1beta`, model: 'gemini-mock',
    temperature: 0.5, maxTokens: null, customInstructions: '', toolsEnabled: true, enabled: true, modelsCache: []
  })).provider;
  await chat({ chatId: null, providerId: gProvForRules.id, model: 'gemini-mock', message: 'bonjour', tools: { web: false, files: false, code: false } });
  check('global rules reach a Google provider',
    String(lastByKind('google').body.systemInstruction?.parts?.[0]?.text || '').includes(RULE));

  // Clearing must restore the default prompt exactly — the rule has to disappear.
  await req('PUT', '/api/settings', { globalInstructions: '' });
  seen.length = 0;
  await chat({ chatId: null, providerId: prov.id, model: 'mock-small', message: 'hello again', tools: { web: false, files: false, code: false } });
  const withoutRule = lastByKind('openai');
  const sysWithout = ((withoutRule.body.messages || []).find((m) => m.role === 'system') || {}).content || '';
  check('clearing global rules returns to the default prompt',
    !sysWithout.includes(RULE) && !/Operator rules/i.test(sysWithout), sysWithout.slice(-120));
  check('the default prompt is still the full agent prompt',
    sysWithout.includes('professional AI support agent') && sysWithout.includes('Response quality'));

  seen.length = 0;
  await chat({ chatId: null, providerId: aProvForRules.id, model: 'claude-mock', message: 'hello again', tools: { web: false, files: false, code: false } });
  check('clearing global rules also clears them for an Anthropic provider',
    !String(lastByKind('anthropic').body.system || '').includes(RULE));

  // -------------------------------------------------------------------------
  // 6. Anthropic and Google adapters work for a freshly added provider
  // -------------------------------------------------------------------------
  const aProv = (await req('POST', '/api/providers', {
    name: 'Mock Anthropic', type: 'anthropic', presetId: 'anthropic', apiKey: 'sk-ant-mock',
    baseUrl: `http://127.0.0.1:${anthropic.port}`, model: 'claude-mock',
    temperature: 0.5, maxTokens: 1024, customInstructions: '', toolsEnabled: true, enabled: true, modelsCache: []
  })).provider;
  const aChat = await chat({ chatId: null, providerId: aProv.id, model: 'claude-mock', message: 'hi', tools: { web: false, files: false, code: false } });
  const aEnd = aChat.find((e) => e.type === 'message_end');
  check('an Anthropic-compatible provider works',
    aEnd && /ANTHROPIC-OK/.test((aEnd.message && aEnd.message.content) || ''),
    aEnd && (aEnd.message && aEnd.message.content || '').slice(0, 60));
  check('the Anthropic request carries its API key header',
    lastByKind('anthropic') && lastByKind('anthropic').key === 'sk-ant-mock');
  check('the Anthropic request carries the system prompt separately',
    lastByKind('anthropic') && typeof lastByKind('anthropic').body.system === 'string'
      && lastByKind('anthropic').body.system.includes('professional AI support agent'));

  const gProv = (await req('POST', '/api/providers', {
    name: 'Mock Google', type: 'google', presetId: 'google', apiKey: 'gmock',
    baseUrl: `http://127.0.0.1:${google.port}/v1beta`, model: 'gemini-mock',
    temperature: 0.5, maxTokens: null, customInstructions: '', toolsEnabled: true, enabled: true, modelsCache: []
  })).provider;
  const gChat = await chat({ chatId: null, providerId: gProv.id, model: 'gemini-mock', message: 'hi', tools: { web: false, files: false, code: false } });
  const gEnd = gChat.find((e) => e.type === 'message_end');
  check('a Google-compatible provider works',
    gEnd && /GOOGLE-OK/.test((gEnd.message && gEnd.message.content) || ''),
    gEnd && (gEnd.message && gEnd.message.content || '').slice(0, 60));
  check('the Google request carries a systemInstruction',
    lastByKind('google') && typeof lastByKind('google').body.systemInstruction?.parts?.[0]?.text === 'string');

  // -------------------------------------------------------------------------
  // 7. A provider with tools switched off stays a normal chat
  // -------------------------------------------------------------------------
  await req('PUT', `/api/providers/${prov.id}`, { toolsEnabled: false });
  seen.length = 0;
  const noTools = await chat({ chatId: null, providerId: prov.id, model: 'mock-small', message: 'hi', tools: { web: true, files: true, code: true } });
  const noToolsEnd = noTools.find((e) => e.type === 'message_end');
  check('a tools-disabled provider ignores the composer toggles',
    lastByKind('openai') && lastByKind('openai').body.tools === undefined);
  const noToolsSys = ((lastByKind('openai').body.messages || []).find((m) => m.role === 'system') || {}).content || '';
  check('a tools-disabled provider is told it has no tools',
    /No external tools are enabled/.test(noToolsSys), noToolsSys.slice(-160));
  check('a tools-disabled provider still answers',
    noToolsEnd && /MOCK-REPLY-OK/.test((noToolsEnd.message && noToolsEnd.message.content) || ''));

  // -------------------------------------------------------------------------
  // 8. Per-provider custom rules are scoped to that provider
  // -------------------------------------------------------------------------
  await req('PUT', `/api/providers/${prov.id}`, { toolsEnabled: true, customInstructions: 'PROVIDER-RULE-SENTINEL' });
  seen.length = 0;
  await chat({ chatId: null, providerId: prov.id, model: 'mock-small', message: 'hi', tools: { web: false, files: false, code: false } });
  const pSys = ((lastByKind('openai').body.messages || []).find((m) => m.role === 'system') || {}).content || '';
  check('per-provider custom rules reach that provider', pSys.includes('PROVIDER-RULE-SENTINEL'));

  seen.length = 0;
  await chat({ chatId: null, providerId: aProv.id, model: 'claude-mock', message: 'hi', tools: { web: false, files: false, code: false } });
  const aSys = (lastByKind('anthropic').body.system) || '';
  check('per-provider rules do not leak to another provider', !aSys.includes('PROVIDER-RULE-SENTINEL'));

  // -------------------------------------------------------------------------
  // 9. Deleting a provider
  // -------------------------------------------------------------------------
  const del = await req('DELETE', `/api/providers/${gProv.id}`);
  check('a provider can be deleted', del.ok === true);
  const afterDel = await req('GET', '/api/providers');
  check('the deleted provider is gone', !afterDel.providers.some((p) => p.id === gProv.id));
  check('the other providers survive the delete',
    afterDel.providers.some((p) => p.id === prov.id) && afterDel.providers.some((p) => p.id === aProv.id));

  // -------------------------------------------------------------------------
  // 10. A second provider joining the team cannot break the lead's answer
  // -------------------------------------------------------------------------
  const broken = (await req('POST', '/api/providers', {
    name: 'Mock Broken', type: 'openai', presetId: 'custom', apiKey: 'x',
    baseUrl: 'http://127.0.0.1:9/v1', model: 'nope',
    temperature: null, maxTokens: null, customInstructions: '', toolsEnabled: true, enabled: true, modelsCache: []
  })).provider;
  check('a second provider can be added alongside the first', !!broken && !!broken.id);

  // Only the unreachable provider may be dispatched, so the failure path is
  // deterministically the one under test rather than whichever mock is picked.
  for (const extra of [aProv, aProvForRules, gProvForRules]) {
    if (extra) await req('PUT', `/api/providers/${extra.id}`, { enabled: false });
  }

  await req('PUT', '/api/settings', { agent: { mode: 'crew', crewEnabled: true, crewSize: 2 } });
  seen.length = 0;
  const withBrokenTeam = await chat({
    chatId: null, providerId: prov.id, model: 'mock-small',
    message: 'build me a project please', tools: { web: false, files: true, code: false }
  });
  const btEnd = withBrokenTeam.find((e) => e.type === 'message_end');
  check('the team actually dispatched the second provider',
    withBrokenTeam.some((e) => e.type === 'crew'),
    JSON.stringify(withBrokenTeam.filter((e) => e.type === 'crew').map((e) => e.index)).slice(0, 60));
  check('an unreachable team member does not lose the lead answer',
    btEnd && /MOCK-REPLY-OK/.test((btEnd.message && btEnd.message.content) || ''),
    btEnd && (btEnd.message && btEnd.message.content || '').slice(0, 60));
  check('the unreachable member is reported, not hidden',
    withBrokenTeam.some((e) => e.type === 'status' && /team reviewer\s*\d*\s*failed/i.test(e.text || '')),
    JSON.stringify(withBrokenTeam.filter((e) => e.type === 'status').map((e) => e.text)).slice(0, 300));

  finish();
})().catch((e) => {
  check('provider suite ran without throwing', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(1);
});
