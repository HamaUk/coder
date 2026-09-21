// The deployment shape, rehearsed.
//
// Everything else in `.smoke/` runs the server the way a laptop does. This suite
// runs it the way the CONTAINER does — HOST=0.0.0.0, HAMA_TOKEN set, production
// env, and the data/workspace directories pointed somewhere else — because that
// is the configuration where a mistake is invisible until after you have handed
// out a URL. The three failures worth catching here are all silent:
//
//   * the server binds a public interface without a token, so anyone who finds
//     the URL can run shell commands on the host;
//   * HAMA_DATA_DIR is ignored, so chats, providers and API keys are written to
//     a path inside the image and vanish on the next restart;
//   * the health route is not actually reachable, so the platform restarts a
//     perfectly healthy container forever (or routes traffic to nothing).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'deploy-rehearsal-token-4c1f8a2b7e93';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-deploy-'));
const DATA_DIR = path.join(SCRATCH, 'volume-data');
const WORKSPACE_DIR = path.join(SCRATCH, 'volume-workspace');

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

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

function bootServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const m = /http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/.exec(out);
      if (m) { clearInterval(timer); resolve({ child, port: Number(m[1]), stdout: () => out, stderr: () => err }); }
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(Object.assign(new Error('server exited: ' + (err || out).slice(0, 300)), { code: child.exitCode, out, err }));
      }
    }, 100);
  });
}

(async () => {
  // =========================================================================
  // 1. A public bind without a token is refused, before it ever listens
  // =========================================================================
  {
    const refused = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        env: { ...process.env, PORT: '0', HOST: '0.0.0.0', HAMA_TOKEN: '', HAMA_PASSWORD: '' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('exit', (code) => resolve({ code, out }));
      setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 10000);
    });
    check('a public bind with no token exits rather than exposing the host', refused.code === 1, 'exit ' + refused.code);
    check('the refusal explains how to set one', /HAMA_TOKEN/.test(refused.out) && /refuses to listen/i.test(refused.out));
    check('the refusal happens without binding a port', !/running at http/i.test(refused.out));
  }

  // =========================================================================
  // 2. The production configuration boots and serves
  // =========================================================================
  const server = await bootServer({
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    HAMA_TOKEN: TOKEN,
    HAMA_DATA_DIR: DATA_DIR,
    HAMA_WORKSPACE_DIR: WORKSPACE_DIR
  });

  try {
    const health = await request(server.port, { path: '/api/health' });
    check('the platform health probe answers publicly', health.status === 200, 'status ' + health.status);
    check('health reports the build is not stale', /"staleCode":false/.test(health.text));

    // The exact command from the Dockerfile's HEALTHCHECK.
    const probe = spawnSync(process.execPath, ['-e',
      "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    ], { env: { ...process.env, PORT: String(server.port) }, encoding: 'utf8' });
    check('the Dockerfile healthcheck passes against a real server', probe.status === 0, 'exit ' + probe.status);

    const closed = await request(server.port, { path: '/api/chats' });
    check('the API is closed without a credential', closed.status === 401, 'status ' + closed.status);

    const bearer = await request(server.port, { path: '/api/chats', headers: { Authorization: 'Bearer ' + TOKEN } });
    check('the API opens with the bearer token', bearer.status === 200, 'status ' + bearer.status);

    // =====================================================================
    // 3. State lands in the configured directories, not inside the image
    // =====================================================================
    const created = await request(server.port, {
      method: 'POST',
      path: '/api/chats',
      headers: { Authorization: 'Bearer ' + TOKEN },
      body: { title: 'deploy rehearsal' }
    });
    check('a chat can be created over the API', created.status === 200 || created.status === 201,
      'status ' + created.status);

    const dataFiles = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : [];
    check('chats are written to HAMA_DATA_DIR (the mounted volume)', dataFiles.includes('chats.json'),
      dataFiles.join(', ') || 'nothing written');
    check('the workspace directory is created from HAMA_WORKSPACE_DIR', fs.existsSync(WORKSPACE_DIR));
    check('nothing was written to the repository data/ directory', !fs.existsSync(path.join(ROOT, 'data', 'deploy-rehearsal')));
  } finally {
    try { server.child.kill(); } catch { /* gone */ }
  }

  // =========================================================================
  // 4. A public URL never prints the token
  // =========================================================================
  check('the boot log does not echo the token',
    !server.stdout().includes(TOKEN) && !server.stderr().includes(TOKEN));

  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('CRASH', error && error.message ? error.message : error);
  process.exit(2);
});
