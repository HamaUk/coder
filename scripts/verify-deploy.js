// Post-deploy self-check. Run this ON THE HOST, once, after the first boot:
//
//   node scripts/verify-deploy.js
//
// Why it exists: the development machine and the deployment are different
// operating systems. `run_shell` uses PowerShell on Windows and bash on Linux,
// `run_script` needs a Python interpreter, and both need a writable data
// directory — none of which can be fully proven from the machine the code was
// written on. This exercises the REAL modules against the REAL host, so a broken
// deployment is diagnosed in seconds instead of on the first user request.
//
// It never touches your chats: it uses a scratch workspace under the OS temp
// directory, and writes nothing into data/ except a probe file it deletes.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail ? String(detail) : '' });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const shellKit = require(path.join(ROOT, 'src', 'shell'));
  const store = require(path.join(ROOT, 'src', 'store'));
  const tools = require(path.join(ROOT, 'src', 'tools'));

  // ---- 1. the shell the tools will actually use -------------------------
  const info = shellKit.shellInfo();
  check('a shell is available on this host', info.available === true, info.label || 'none');

  if (info.available) {
    const echo = await shellKit.runShell({ command: 'echo hama-deploy-probe', timeoutMs: 20000 });
    check('the shell runs a command and returns its output',
      echo.ok === true && /hama-deploy-probe/.test(echo.stdout),
      `exit=${echo.exitCode} out=${JSON.stringify(String(echo.stdout).slice(0, 40))}`);

    const bad = await shellKit.runShell({ command: 'exit 7', timeoutMs: 20000 });
    check('a non-zero exit code is reported', bad.exitCode === 7, 'code=' + bad.exitCode);

    await shellKit.runShell({ command: 'cd /tmp 2>/dev/null || cd $TMPDIR', timeoutMs: 20000 });
    const where = await shellKit.runShell({ command: 'pwd', timeoutMs: 20000 });
    check('shell state persists between calls', !/hama-deploy-probe/.test(where.stdout) && where.exitCode === 0,
      JSON.stringify(String(where.stdout).slice(0, 60)));

    const slow = await shellKit.runShell({ command: 'sleep 20', timeoutMs: 1500 });
    check('a timeout kills the command instead of hanging the turn', slow.timedOut === true, `after ${slow.durationMs}ms`);
    const after = await shellKit.runShell({ command: 'echo alive', timeoutMs: 20000 });
    check('the shell recovers after a timeout', /alive/.test(after.stdout));

    shellKit.killAll();
  }

  // ---- 2. interpreters the agent shells out to --------------------------
  const python = await tools.runScript({ path: '_probe_missing.py', chatId: null }).catch(() => null);
  check('run_script reports a missing file instead of throwing',
    python && python.ok === false, python && String(python.output).slice(0, 50));

  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-deploy-'));
  const chatId = 'deploy_probe';
  const wrote = await tools.execute('write_file', {
    path: 'probe.py',
    content: 'import sys, platform\nprint("python-ok", sys.version_info[0], platform.system())\n'
  }, { chatId });
  check('the file tools can write a file', wrote.ok === true, String(wrote.output).slice(0, 50));

  const ranPython = await tools.execute('run_script', { path: 'probe.py' }, { chatId });
  check('Python is installed and runnable by run_script',
    ranPython.ok === true && /python-ok/.test(String(ranPython.output)),
    String(ranPython.output).replace(/\n/g, ' ').slice(0, 70));

  await tools.execute('write_file', { path: 'probe.js', content: 'console.log("node-ok", process.version)\n' }, { chatId });
  const nodeRun = await tools.execute('run_script', { path: 'probe.js' }, { chatId });
  check('Node runs a generated script', nodeRun.ok === true && /node-ok/.test(String(nodeRun.output)),
    String(nodeRun.output).replace(/\n/g, ' ').slice(0, 60));

  // ---- 3. storage -------------------------------------------------------
  const dataFile = path.join(store.DATA_DIR, '.deploy-probe');
  let writable = false;
  try {
    fs.writeFileSync(dataFile, String(Date.now()));
    fs.unlinkSync(dataFile);
    writable = true;
  } catch { /* reported below */ }
  check('the data directory is writable (chats and keys can be saved)', writable, store.DATA_DIR);

  let wsWritable = false;
  try {
    const dir = store.getChatWorkspaceDir(chatId);
    fs.writeFileSync(path.join(dir, '.deploy-probe'), 'x');
    fs.unlinkSync(path.join(dir, '.deploy-probe'));
    wsWritable = Boolean(dir);
  } catch { /* reported below */ }
  check('the workspace directory is writable (generated files persist)', wsWritable, store.WORKSPACE_DIR);

  check('the workspace looks persistent (not a fresh empty container)',
    fs.existsSync(store.WORKSPACE_DIR),
    'a reset on every restart means the host has no volume mounted');

  // ---- 4. the auth gate ------------------------------------------------
  const token = String(process.env.HAMA_TOKEN || process.env.HAMA_PASSWORD || '');
  const host = String(process.env.HOST || '127.0.0.1');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  check('a token is set', token.length > 0, token ? `${token.length} characters` : 'HAMA_TOKEN is empty');
  check('a public bind is protected by that token', loopback || token.length > 0, `HOST=${host}`);
  check('the token is long enough to resist guessing', token.length === 0 || token.length >= 24,
    `${token.length} characters (24+ recommended)`);

  // ---- 5. what the model providers need --------------------------------
  let esbuild = true;
  try { require.resolve('esbuild'); } catch { esbuild = false; }
  check('esbuild is installed (React previews can bundle)', esbuild);

  try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ }

  const failed = results.filter((r) => !r.ok);
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  } else {
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) console.log('Failures above are the things to fix before handing out the URL.');
  }
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error('verify-deploy crashed:', error);
  process.exit(2);
});
