// Authentication for a public deployment.
//
// The console can run shell commands and returns stored API keys, so the only
// thing standing between a public URL and the host is this gate. The suite
// drives the REAL server over HTTP with a token set, because that is the
// configuration a deployment runs and the one no other suite covers.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'test-token-9f3a1c7e5b2d';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-auth-'));
const DATA_DIR = path.join(SCRATCH, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'providers.json'), JSON.stringify([]));
fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify({ agentName: 'HAMA' }));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** One HTTP request returning status, headers and body. */
function request(port, { method = 'GET', path: pathname = '/', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function bootServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const port = await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const m = /http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(out);
      if (m) { clearInterval(timer); resolve(Number(m[1])); }
      if (child.exitCode !== null) { clearInterval(timer); reject(new Error('server exited: ' + err.slice(0, 200))); }
    }, 100);
  });
  return { child, port, stderr: () => err };
}

(async () => {
  // -------------------------------------------------------------------------
  // 1. Without a token the console is unchanged (local use)
  // -------------------------------------------------------------------------
  {
    const local = await bootServer({ HAMA_TOKEN: '', HAMA_DATA_DIR: DATA_DIR, HAMA_WORKSPACE_DIR: path.join(SCRATCH, 'ws') });
    const boot = await request(local.port, { path: '/api/bootstrap' });
    check('no token: the API answers on loopback as before', boot.status === 200, `status ${boot.status}`);
    const root = await request(local.port, { path: '/' });
    check('no token: the console shell is served', root.status === 200 && /HAMA/.test(root.text));
    local.child.kill();
  }

  // -------------------------------------------------------------------------
  // 2. With a token, everything is behind the gate
  // -------------------------------------------------------------------------
  const server = await bootServer({ HAMA_TOKEN: TOKEN, HAMA_DATA_DIR: DATA_DIR, HAMA_WORKSPACE_DIR: path.join(SCRATCH, 'ws') });

  {
    const api = await request(server.port, { path: '/api/bootstrap' });
    check('an unauthenticated API call is refused', api.status === 401, `status ${api.status}`);
    check('the refusal explains where to sign in', /\/login/.test(api.text), api.text.slice(0, 60));

    const page = await request(server.port, { path: '/' });
    check('an unauthenticated page load is redirected to the form',
      page.status === 302 && page.headers.location === '/login', `status ${page.status} → ${page.headers.location}`);

    const asset = await request(server.port, { path: '/app.js' });
    check('static assets are behind the gate too', asset.status === 302, `status ${asset.status}`);

    const health = await request(server.port, { path: '/api/health' });
    check('the health check stays public for the host platform', health.status === 200, `status ${health.status}`);

    const ws = await request(server.port, { path: '/api/workspace/chat_abc123/index.html' });
    check('workspace assets stay public so previews can load',
      ws.status !== 302 && ws.status !== 401, `status ${ws.status}`);

    const form = await request(server.port, { path: '/login' });
    check('the login form is served', form.status === 200 && /name="token"/.test(form.text));
    check('the login form is self-contained (no external assets)', !/<script[^>]+src=/.test(form.text));

    // -----------------------------------------------------------------------
    // A browser inside an embedded preview / in-app browser sends an OPAQUE
    // origin ("null"). The refusal is correct — this console cannot tell that
    // context apart from another site — but it used to answer the sign-in FORM
    // with raw JSON, so the user saw {"error":"Cross-origin request rejected"}
    // and nothing to act on. It must explain itself instead.
    // -----------------------------------------------------------------------
    const nullOrigin = await request(server.port, {
      method: 'POST',
      path: '/login',
      body: { token: TOKEN },
      headers: { Origin: 'null', Accept: 'text/html,application/xhtml+xml' }
    });
    check('an opaque-origin sign-in is still refused', nullOrigin.status === 403, `status ${nullOrigin.status}`);
    check('but it comes back as a page, not as raw JSON',
      /<html/i.test(nullOrigin.text) && !/"error"/.test(nullOrigin.text), nullOrigin.text.slice(0, 60));
    check('and it names the real cause (the embedded context)',
      /opaque/i.test(nullOrigin.text) && /normal browser tab/i.test(nullOrigin.text));

    const jsonClient = await request(server.port, {
      method: 'POST',
      path: '/api/chats',
      body: {},
      headers: { Origin: 'https://evil.example' }
    });
    check('an API call from a foreign origin still gets JSON', jsonClient.status === 403 && /Cross-origin/.test(jsonClient.text),
      `${jsonClient.status} ${jsonClient.text.slice(0, 40)}`);

    const sameOrigin = await request(server.port, {
      method: 'POST',
      path: '/login',
      body: { token: TOKEN },
      headers: { Origin: `http://127.0.0.1:${server.port}` }
    });
    check('the page\u2019s own origin still signs in normally', sameOrigin.status === 302, `status ${sameOrigin.status}`);
  }

  // -------------------------------------------------------------------------
  // 3. The token exchange
  // -------------------------------------------------------------------------
  {
    const wrong = await request(server.port, { method: 'POST', path: '/login', body: { token: 'wrong-token' } });
    check('a wrong token is rejected', wrong.status === 401, `status ${wrong.status}`);
    check('a wrong token sets no session cookie', !wrong.headers['set-cookie'], JSON.stringify(wrong.headers['set-cookie'] || null));

    const right = await request(server.port, { method: 'POST', path: '/login', body: { token: TOKEN } });
    check('the right token is accepted', right.status === 302, `status ${right.status}`);
    const cookie = right.headers['set-cookie'] && right.headers['set-cookie'][0];
    check('a session cookie is issued', Boolean(cookie && /hama_session=/.test(cookie)), String(cookie).slice(0, 40));
    check('the cookie is HttpOnly', /HttpOnly/i.test(String(cookie)));
    check('the cookie is SameSite=Lax over plain HTTP', /SameSite=Lax/i.test(String(cookie)), String(cookie));

    const sessionCookie = String(cookie).split(';')[0];
    const authed = await request(server.port, { path: '/api/bootstrap', headers: { Cookie: sessionCookie } });
    check('the session cookie authenticates an API call', authed.status === 200, `status ${authed.status}`);
    const authedPage = await request(server.port, { path: '/', headers: { Cookie: sessionCookie } });
    check('the session cookie serves the console', authedPage.status === 200 && /HAMA/.test(authedPage.text));

    const bearer = await request(server.port, { path: '/api/bootstrap', headers: { Authorization: `Bearer ${TOKEN}` } });
    check('a Bearer token authenticates without a cookie', bearer.status === 200, `status ${bearer.status}`);
    const badBearer = await request(server.port, { path: '/api/bootstrap', headers: { Authorization: 'Bearer nope' } });
    check('a wrong Bearer token is refused', badBearer.status === 401, `status ${badBearer.status}`);

    const forged = await request(server.port, { path: '/api/bootstrap', headers: { Cookie: 'hama_session=deadbeef' } });
    check('a forged session id is refused', forged.status === 401, `status ${forged.status}`);

    const out = await request(server.port, { path: '/logout', headers: { Cookie: sessionCookie } });
    check('logout redirects to the form', out.status === 302 && out.headers.location === '/login', `status ${out.status}`);
    const afterLogout = await request(server.port, { path: '/api/bootstrap', headers: { Cookie: sessionCookie } });
    check('the session no longer works after logout', afterLogout.status === 401, `status ${afterLogout.status}`);
  }

  // -------------------------------------------------------------------------
  // 4. Guessing is throttled
  // -------------------------------------------------------------------------
  {
    let sawThrottle = false;
    for (let i = 0; i < 14; i++) {
      const r = await request(server.port, { method: 'POST', path: '/login', body: { token: 'guess-' + i } });
      if (r.status === 429) { sawThrottle = true; break; }
    }
    check('repeated wrong tokens are throttled', sawThrottle);
  }

  server.child.kill();
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('CRASH', error);
  process.exit(2);
});
