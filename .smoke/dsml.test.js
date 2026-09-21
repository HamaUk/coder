// Regression suite for the DSML leak.
//
// Two symptoms the user actually saw, both from the free Hama AI engine (the one
// with no native tool API):
//
//   1. `<|DSML|tool_calls> … </|DSML|tool_calls>` printed into the reply as
//      prose. The markup is the wire protocol for that engine's tool calls.
//   2. "Workspace is empty." shown twice in a row — the model answering by
//      repeating the tool result it had just been handed.
//
// Part 1 pins the text handling directly; part 2 runs the whole path against a
// stub engine that streams the markup split across chunks in the nastiest way.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const llamacoder = require(path.join(ROOT, 'src', 'llamacoder'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const DSML_BLOCK =
  '<|DSML|tool_calls>\n' +
  '<|DSML|invoke name="list_files">\n' +
  '<|DSML|parameter name="path"></|DSML|parameter>\n' +
  '</|DSML|invoke>\n' +
  '</|DSML|tool_calls>';

// ---------------------------------------------------------------------------
// 1. Text handling
// ---------------------------------------------------------------------------
{
  check('a complete DSML block is removed',
    llamacoder.stripDSML(`Before.\n\n${DSML_BLOCK}\n\nAfter.`) === 'Before.\n\nAfter.',
    JSON.stringify(llamacoder.stripDSML(`Before.\n\n${DSML_BLOCK}\n\nAfter.`)));

  check('an UNCLOSED DSML block is removed',
    !/DSML/.test(llamacoder.stripDSML(`Before.\n\n<|DSML|tool_calls>\n<|DSML|invoke name="read_file">`)),
    llamacoder.stripDSML(`Before.\n\n<|DSML|tool_calls>\n<|DSML|invoke name="read_file">`));

  check('a bare invoke block with no wrapper is removed',
    !/DSML/.test(llamacoder.stripDSML('x <|DSML|invoke name="list_files"><|DSML|parameter name="path">/</|DSML|parameter></|DSML|invoke> y')));

  check('full-width pipe markers are removed too',
    !/DSML/.test(llamacoder.stripDSML('a <｜DSML｜tool_calls> <｜DSML｜invoke name="x"> </｜DSML｜invoke> </｜DSML｜tool_calls> b')));

  check('prose that merely mentions no marker is untouched',
    llamacoder.stripDSML('Nothing to see here.') === 'Nothing to see here.');

  check('tool calls are still parsed out of a block', (() => {
    const p = llamacoder.parseDSML(`ok\n${DSML_BLOCK}`);
    return p.toolCalls.length === 1 && p.toolCalls[0].name === 'list_files';
  })());

  check('multiple invokes in one block are all parsed', (() => {
    const block = '<|DSML|tool_calls>' +
      '<|DSML|invoke name="a"><|DSML|parameter name="p">1</|DSML|parameter></|DSML|invoke>' +
      '<|DSML|invoke name="b"><|DSML|parameter name="p">2</|DSML|parameter></|DSML|invoke>' +
      '</|DSML|tool_calls>';
    const p = llamacoder.parseDSML(block);
    return p.toolCalls.length === 2 && p.toolCalls[0].name === 'a' && p.toolCalls[1].name === 'b';
  })());

  // -------------------------------------------------------------------------
  // Parameter-value shapes the engine really emits
  //
  // Every case below produced an argument object the tool then REFUSED, and the
  // user saw `Error: nothing to write …` for a call the model believed it had
  // sent correctly. The model was not wrong; this parser was.
  // -------------------------------------------------------------------------
  const param = (name, value) => '<|DSML|parameter name="' + name + '">' + value + '</|DSML|parameter>';
  const wrap = (body) => '<|DSML|tool_calls><|DSML|invoke name="write_files">' + body + '</|DSML|invoke></|DSML|tool_calls>';
  const argsOf = (text) => {
    const p = llamacoder.parseDSML(text);
    return p.toolCalls.length ? p.toolCalls[0].args : null;
  };

  check('a JSON parameter wrapped in a Markdown code fence is still JSON',
    JSON.stringify(argsOf(wrap(param('files', '\n```json\n{"a.txt":"A"}\n```\n')))) === '{"files":{"a.txt":"A"}}',
    JSON.stringify(argsOf(wrap(param('files', '\n```json\n{"a.txt":"A"}\n```\n')))));

  check('a fence with no language tag is unwrapped too',
    JSON.stringify(argsOf(wrap(param('files', '```\n{"a.txt":"A"}\n```')))) === '{"files":{"a.txt":"A"}}');

  check('spaces around the parameter name\'s "=" are tolerated',
    JSON.stringify(argsOf('<|DSML|tool_calls><|DSML|invoke name="write_files"><|DSML|parameter name = "files">{"a.txt":"A"}</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>'))
      === '{"files":{"a.txt":"A"}}',
    JSON.stringify(argsOf('<|DSML|tool_calls><|DSML|invoke name="write_files"><|DSML|parameter name = "files">{"a.txt":"A"}</|DSML|parameter></|DSML|invoke></|DSML|tool_calls>')));

  check('an unterminated parameter does not swallow the next one',
    JSON.stringify(argsOf(
      '<|DSML|tool_calls><|DSML|invoke name="x">'
      + '<|DSML|parameter name="a">"1"'
      + '<|DSML|parameter name="b">"2"'
      + '</|DSML|invoke></|DSML|tool_calls>'
    )) === '{"a":"1"}',
    JSON.stringify(argsOf('<|DSML|tool_calls><|DSML|invoke name="x"><|DSML|parameter name="a">"1"<|DSML|parameter name="b">"2"</|DSML|invoke></|DSML|tool_calls>')));

  check('a complete JSON value arrives as an object, not a string',
    (() => {
      const args = argsOf(wrap(param('files', '{"a.txt":"A"}')));
      return args && args.files && typeof args.files === 'object' && args.files['a.txt'] === 'A';
    })(), JSON.stringify(argsOf(wrap(param('files', '{"a.txt":"A"}')))));

  check('a genuinely truncated JSON value is passed through for the tool to judge',
    (() => {
      const args = argsOf('<|DSML|tool_calls><|DSML|invoke name="write_files"><|DSML|parameter name="files">{"a.txt":"A"');
      return args && typeof args.files === 'string' && args.files === '{"a.txt":"A"';
    })());

  check('a JSON body containing escaped quotes survives',
    JSON.stringify(argsOf(wrap(
      param('content', '{"a": "he said \\"hi\\""}') + param('path', '"x.json"')
    ))) === '{"content":{"a":"he said \\"hi\\""},"path":"x.json"}');

  check('an empty parameter is reported as empty, not as a whole block',
    (() => {
      const args = argsOf(wrap(param('files', '')));
      return args && args.files === '';
    })());
}

// ---------------------------------------------------------------------------
// 2. The streaming filter, under adversarial chunking
// ---------------------------------------------------------------------------
{
  const cases = {
    'one delta': [DSML_BLOCK],
    'the opener split in half': ['<|DSM', 'L|tool_calls>', '\n<|DSML|invoke name="list_files">', '</|DSML|invoke>', '</|DSML|tool_calls>'],
    'one character at a time': [...DSML_BLOCK],
    'split at every closing tag': DSML_BLOCK.split(/(?<=>)/),
    'full-width markers, one char at a time': [...DSML_BLOCK.replace(/\|/g, '｜')]
  };

  for (const [label, deltas] of Object.entries(cases)) {
    const filter = llamacoder.makeDSMLFilter();
    let shown = '';
    for (const d of deltas) shown += filter.push(d);
    shown += filter.flush();
    check(`the filter never shows markup — ${label}`, !/DSML/.test(shown), JSON.stringify(shown.slice(0, 80)));
  }

  // Text around the block must survive intact (whitespace-only differences are
  // expected: the markup is replaced by a space rather than deleted, so two
  // words on either side of it never get glued together).
  {
    const filter = llamacoder.makeDSMLFilter();
    let shown = '';
    for (const d of ['I will look. ', '<|DSML|tool_calls>', '<|DSML|invoke name="x">', '</|DSML|invoke>', '</|DSML|tool_calls>', ' Done.']) {
      shown += filter.push(d);
    }
    shown += filter.flush();
    check('the text around a block survives',
      shown.replace(/\s+/g, ' ').trim() === 'I will look. Done.', JSON.stringify(shown));
  }

  // A partial marker at the very end of the stream is not shown either.
  {
    const filter = llamacoder.makeDSMLFilter();
    let shown = filter.push('answer <|DSM');
    shown += filter.flush();
    check('a trailing partial marker is not shown', !/DSML|<\|/.test(shown), JSON.stringify(shown));
  }
}

// ---------------------------------------------------------------------------
// 3. End to end, against a stub of the free engine
// ---------------------------------------------------------------------------
function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const EMPTY_LIST = 'Workspace is empty.';

async function startEngine() {
  let turn = 0;
  return listen((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.endsWith('/api/create-chat')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ chatId: 'stub-chat', lastMessageId: 'msg-' + (++turn) }));
      }
      if (url.pathname.endsWith('/api/get-next-completion-stream-promise')) {
        const payload = JSON.parse(body || '{}');
        const msgId = String(payload.messageId || '');
        let full;
        if (msgId === 'msg-1') {
          // Turn 1: narrate, then emit the tool call SPLIT across chunks exactly
          // the way the real engine does it — this is what used to leak.
          full = 'Let me look at the workspace.\n\n' + DSML_BLOCK;
        } else {
          // Turn 2: answer by echoing the tool result verbatim, then the real reply.
          full = EMPTY_LIST + '\n\n' + EMPTY_LIST + '\n\nThe report lists 11 findings across 2 HIGH and 9 LOW issues.';
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Deliberately awkward chunking: the marker is cut mid-token.
        const chunks = [];
        for (let i = 0; i < full.length; i += 7) chunks.push(full.slice(i, i + 7));
        for (const c of chunks) res.write(JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n');
        res.write(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n');
        return res.end();
      }
      res.writeHead(404); res.end('nope');
    });
  });
}

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-dsml-'));
const WS = path.join(DATA, 'workspace');
const PORT = 3231;
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

(async () => {
  const engine = await startEngine();

  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT),
      HAMA_DATA_DIR: DATA, HAMA_WORKSPACE_DIR: WS,
      HAMA_LLAMACODER_BASE: `http://127.0.0.1:${engine.port}`
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let srvErr = '';
  srv.stderr.on('data', (d) => { srvErr += d.toString(); });

  const finish = () => {
    try { srv.kill(); } catch { /* ignore */ }
    try { engine.srv.close(); } catch { /* ignore */ }
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* ignore */ }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    if (srvErr.trim()) console.log('server stderr:\n' + srvErr.trim().slice(0, 600));
    process.exit(passed === results.length ? 0 : 1);
  };

  for (let i = 0; i < 60; i++) {
    try { await req('GET', '/api/bootstrap'); break; } catch { await sleep(100); }
  }

  // The seeded provider IS the free engine, pointed at the stub.
  const prov = (await req('GET', '/api/providers')).providers.find((p) => p.id === 'prov_llamacoder');
  check('the free engine provider is available', !!prov);

  const events = await chat({
    chatId: null, providerId: 'prov_llamacoder', model: 'stub-model',
    message: 'what is in this report?', tools: { web: false, files: true, code: false }
  });
  const end = events.find((e) => e.type === 'message_end');
  const msg = end && end.message;
  const content = (msg && msg.content) || '';

  check('the turn completed', !!msg, JSON.stringify(events.map((e) => e.type)));
  check('the tool call was parsed and executed',
    ((msg && msg.toolRuns) || []).some((r) => r.name === 'list_files'),
    JSON.stringify(((msg && msg.toolRuns) || []).map((r) => r.name)));
  check('NO DSML markup survives in the reply', !/DSML/.test(content),
    JSON.stringify(content.slice(0, 200)));
  check('the narration around the tool call is kept',
    content.includes('Let me look at the workspace.'), JSON.stringify(content.slice(0, 120)));
  check('the model\'s real answer is kept',
    content.includes('11 findings across 2 HIGH and 9 LOW issues.'), JSON.stringify(content.slice(-120)));
  check('the echoed tool result is not repeated in the reply',
    !content.includes(EMPTY_LIST), JSON.stringify(content.slice(0, 200)));
  check('no DSML markup was streamed to the client either',
    !events.filter((e) => e.type === 'token').some((e) => /DSML/.test(e.text || '')),
    JSON.stringify(events.filter((e) => e.type === 'token').map((e) => e.text).join('').slice(0, 200)));

  // The saved transcript has to be clean too — that is what survives a reload.
  const chats = await req('GET', '/api/chats');
  const chatId = end && end.chat && end.chat.id;
  const full = await req('GET', `/api/chats/${chatId}`);
  const assistant = (full.chat.messages || []).find((m) => m.role === 'assistant');
  check('the PERSISTED reply is clean', assistant && !/DSML/.test(assistant.content),
    JSON.stringify((assistant && assistant.content || '').slice(0, 200)));

  finish();
})().catch((e) => {
  check('dsml suite ran without throwing', false, e && e.stack ? e.stack.split('\n')[0] : String(e));
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(1);
});
