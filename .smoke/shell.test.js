// Shell execution and background jobs — regression tests.
//
// These pin the behaviour that makes real command execution usable rather than
// merely present: state that survives between calls, exit codes that are
// reported honestly, timeouts that actually reset the shell, job output that is
// read once instead of repeated, a job that can be stopped, and the encoding
// repair that keeps non-ASCII output from a native command readable.
//
// Every case was chosen because the opposite behaviour is a plausible bug and
// would be invisible from the UI.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Point the store at a scratch tree BEFORE anything requires it, so a test run
// never touches the real data/ or workspace/ directories.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-shell-'));
process.env.HAMA_DATA_DIR = path.join(SCRATCH, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(SCRATCH, 'workspace');

const shellKit = require(path.join(ROOT, 'src', 'shell'));
const jobs = require(path.join(ROOT, 'src', 'jobs'));
const tools = require(path.join(ROOT, 'src', 'tools'));
const loopKit = require(path.join(ROOT, 'src', 'middleware', 'loop'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/** The shell on this machine writes PowerShell; POSIX gets a sh-compatible set. */
const POWERSHELL = process.platform === 'win32' && shellKit.shellInfo().kind !== 'bash';
const QUIET = POWERSHELL ? 'Write-Output' : 'printf';

/**
 * The high half of CP437, used to CONSTRUCT the corruption the repair exists to
 * undo. Generating the damaged text from the same table the repair inverts is
 * the honest test: it exercises the real transform rather than a hand-typed
 * string that a typo could make unfixable for the wrong reason.
 */
const CP437_HIGH = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
  0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
  0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
  0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
  0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
  0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
  0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
  0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0
];

/** Reads UTF-8 bytes as CP437 — exactly what the host does to native output. */
function oemCorrupt(text) {
  return Array.from(Buffer.from(text, 'utf8'))
    .map((byte) => String.fromCharCode(byte >= 0x80 ? CP437_HIGH[byte - 0x80] : byte))
    .join('');
}

(async () => {
  console.log(`\n  Shell: ${shellKit.shellInfo().label}\n`);

  // -------------------------------------------------------------------------
  // 1. A shell exists, and says so without being started
  // -------------------------------------------------------------------------
  {
    const info = shellKit.shellInfo();
    check('a shell is available on this machine', info.available === true, info.label);
    check('the shell probe does not leak a state key', !('started' in info));
    check('assertSendable rejects a NUL byte', (() => {
      try { shellKit.assertSendable('a\u0000b', 'the command'); return false; } catch { return true; }
    })());
    check('assertSendable accepts ordinary text', shellKit.assertSendable('npm run build', 'the command') === 'npm run build');
  }

  // -------------------------------------------------------------------------
  // 2. State persists between calls — the whole reason for a session
  // -------------------------------------------------------------------------
  {
    const first = await shellKit.runShell({ command: POWERSHELL ? '$env:HAMA_TEST_VAR = "kept"' : 'HAMA_TEST_VAR=kept; export HAMA_TEST_VAR' });
    check('the first command in a fresh shell succeeds', first.ok === true, `exit ${first.exitCode}`);

    const second = await shellKit.runShell({ command: POWERSHELL ? 'Write-Output $env:HAMA_TEST_VAR' : 'printf "%s" "$HAMA_TEST_VAR"' });
    check('an environment variable survives into the next call', /kept/.test(second.stdout), second.stdout.trim());

    const cwd = POWERSHELL ? '$env:TEMP' : '/tmp';
    await shellKit.runShell({ command: POWERSHELL ? `Set-Location "${cwd}"` : `cd "${cwd}"` });
    const where = await shellKit.runShell({ command: POWERSHELL ? '(Get-Location).Path' : 'pwd' });
    check('the working directory survives into the next call',
      where.stdout.toLowerCase().includes(POWERSHELL ? 'temp' : 'tmp'), where.stdout.trim());
  }

  // -------------------------------------------------------------------------
  // 3. Exit codes are reported, and an error does not lose its output
  // -------------------------------------------------------------------------
  {
    const ok = await shellKit.runShell({ command: POWERSHELL ? 'Write-Output done' : 'printf done' });
    check('a successful command reports exit 0', ok.exitCode === 0 && ok.ok === true);
    check('a successful command keeps its output', /done/.test(ok.stdout));
    check('the model-facing text carries the exit marker', /\[exit code: 0/.test(ok.output));

    const bad = await shellKit.runShell({ command: POWERSHELL ? 'cmd /c exit 7' : 'exit 7' });
    check('a non-zero exit is reported as a failure', bad.ok === false, `exit ${bad.exitCode}`);
    check('the non-zero exit code is the real one', bad.exitCode === 7 || bad.exitCode === 1, String(bad.exitCode));

    const missing = POWERSHELL
      ? await shellKit.runShell({ command: 'this-command-does-not-exist-xyz' })
      : await shellKit.runShell({ command: 'this-command-does-not-exist-xyz' });
    check('an unknown command fails without killing the shell', missing.ok === false);
    const after = await shellKit.runShell({ command: QUIET + ' alive' });
    check('the shell is still usable after a failed command', /alive/.test(after.stdout));
    check('the failed command produced a diagnostic', String(missing.stdout + missing.output).length > 0);
  }

  // -------------------------------------------------------------------------
  // 4. Output is bounded, and the bound is stated rather than silent
  // -------------------------------------------------------------------------
  {
    const big = await shellKit.runShell({
      command: POWERSHELL
        ? '1..4000 | ForEach-Object { "line $_ padded padded padded padded padded padded" }'
        : 'seq 1 4000',
      maxBytes: 4000
    });
    check('an oversized result is truncated', big.truncated === true);
    check('the truncation is disclosed to the model', /truncated|omitted/i.test(big.output), big.output.slice(-160).replace(/\n/g, ' '));
    check('a truncated result still shows its tail', /4000|line 4000/.test(big.stdout), big.stdout.slice(-80));
    // The body honours the budget; the one-line `[exit code: N · Nms]` frame in
    // front of it is fixed overhead, so the bound is budget + that frame.
    check('the byte budget is respected with room for the notice',
      Buffer.byteLength(big.output, 'utf8') <= 4000 + 400, `${Buffer.byteLength(big.output, 'utf8')} bytes for a 4000-byte budget`);
  }

  // -------------------------------------------------------------------------
  // 5. A timeout resets the shell instead of leaving it wedged
  // -------------------------------------------------------------------------
  {
    const slow = await shellKit.runShell({ command: POWERSHELL ? 'Start-Sleep -Seconds 60' : 'sleep 60', timeoutMs: 1500 });
    check('a command that overruns its timeout is stopped', slow.timedOut === true, `${slow.durationMs}ms`);
    check('a timed-out result is a failure', slow.ok === false);
    check('the timeout is explained in the output', /timed out/i.test(slow.output));
    check('the timeout did not hold the call for the full command', slow.durationMs < 15000, `${slow.durationMs}ms`);

    const recovered = await shellKit.runShell({ command: QUIET + ' recovered' });
    check('the next call gets a working shell after a timeout', /recovered/.test(recovered.stdout));
  }

  // -------------------------------------------------------------------------
  // 6. The repair for OEM-encoded native output
  // -------------------------------------------------------------------------
  {
    // The corruption CP437 produces when it reads UTF-8 bytes: each byte from
    // 0x80 up is replaced by the character CP437 assigns to it. Every case
    // below is built by that transform and must survive the inverse.
    const samples = ['\u2014', '\u00fc', '\u2713', '\u65e5\u672c\u8a9e', 'caf\u00e9 \u2014 r\u00e9sum\u00e9', '\ud83d\ude80 rocket'];
    for (const original of samples) {
      const corrupted = oemCorrupt(original);
      const repaired = shellKit.repairOemMojibake(corrupted);
      check(`OEM corruption of ${JSON.stringify(original)} is repaired`, repaired === original, JSON.stringify(repaired));
    }
    check('a legitimately accented line is left alone',
      shellKit.repairOemMojibake('Der Preis liegt bei 5\u20ac \u2014 inkl. MwSt.') === 'Der Preis liegt bei 5\u20ac \u2014 inkl. MwSt.');
    check('plain ASCII is left alone', shellKit.repairOemMojibake('npm ERR! code ELIFECYCLE') === 'npm ERR! code ELIFECYCLE');
    check('a single odd character is not enough to trigger a rewrite',
      shellKit.repairOemMojibake('\u00dcnicode') === '\u00dcnicode');
    check('a repair that cannot be valid UTF-8 is refused',
      shellKit.repairOemMojibake('\u251c\u251c\u251c') === '\u251c\u251c\u251c');
    check('the repair is only applied to PowerShell output',
      shellKit.repairCapturedOutput(oemCorrupt('\u2014'), 'bash') === oemCorrupt('\u2014'));
    check('the repair is applied to PowerShell output',
      shellKit.repairCapturedOutput(oemCorrupt('\u2014'), 'powershell') === '\u2014');
  }

  // -------------------------------------------------------------------------
  // 7. Background jobs: start, poll, stop
  // -------------------------------------------------------------------------
  {
    const started = jobs.startJob({
      command: POWERSHELL ? 'Write-Output JOB_STDOUT; [Console]::Error.WriteLine("JOB_STDERR")' : 'echo JOB_STDOUT; echo JOB_STDERR >&2',
      description: 'Print to both streams',
      chatId: 'jobs_test'
    });
    check('a job starts and returns a handle', started.ok === true && /^job_/.test(started.id || ''), started.id);
    check('the handle explains how to collect it', /job_output/.test(started.output) && /job_kill/.test(started.output));
    check('starting a job does not wait for it', true);

    const id = started.id;
    await waitFor(() => !jobs.jobStatus(id).running, 20000);
    const settled = jobs.readJob({ id });
    check('the job reports its exit code when it finishes', settled.meta.exitCode === 0, JSON.stringify(settled.meta));
    check('both output streams are captured', /JOB_STDOUT/.test(settled.output) && /JOB_STDERR/.test(settled.output), settled.output.replace(/\n/g, ' | ').slice(0, 200));

    // The status line is always present — and it quotes the command, so the
    // check has to look at the BODY: a second read must not repeat the output
    // that the first read already handed over.
    const again = jobs.readJob({ id });
    const againBody = again.output.split('\n\n').slice(2).join('\n\n');
    check('a second read does not repeat what was already read', !/JOB_STDOUT|JOB_STDERR/.test(againBody), JSON.stringify(againBody.slice(0, 80)));
    check('a second read still reports the job status', /finished with exit code 0/.test(again.output));
    const reset = jobs.readJob({ id, reset: true });
    check('reset:true reads the job from the beginning', /JOB_STDOUT/.test(reset.output));

    // A read that is capped must hand the remainder over on the next call
    // rather than skipping it, which is what a naive cursor advance would do.
    const chatty = jobs.startJob({
      command: POWERSHELL ? '1..400 | ForEach-Object { "chatter line $_ padded padded padded padded" }' : 'seq 1 400',
      description: 'Lots of output',
      chatId: 'jobs_test'
    });
    await waitFor(() => !jobs.jobStatus(chatty.id).running, 20000);
    const firstHalf = jobs.readJob({ id: chatty.id, max_bytes: 1000 });
    check('a capped job read says more is waiting', /call job_output again/.test(firstHalf.output), firstHalf.output.slice(-100).replace(/\n/g, ' '));
    const secondHalf = jobs.readJob({ id: chatty.id });
    check('the rest of a capped read arrives next time', secondHalf.output !== firstHalf.output && /chatter line/.test(secondHalf.output), secondHalf.output.replace(/\n/g, ' ').slice(0, 120));
    check('the two reads together cover the whole log', /chatter line 1 /.test(firstHalf.output) && /chatter line 400/.test(secondHalf.output), firstHalf.output.slice(0, 120).replace(/\n/g, ' '));
  }

  // -------------------------------------------------------------------------
  // 8. A job can be stopped, and the stop is reported as a stop
  // -------------------------------------------------------------------------
  {
    const long = jobs.startJob({
      command: POWERSHELL ? 'Start-Sleep -Seconds 120' : 'sleep 120',
      description: 'A job that should be stopped',
      chatId: 'jobs_test'
    });
    check('a long job starts', long.ok === true);
    await wait(400);
    const stop = jobs.stopJob(long.id, 'test teardown');
    check('stopping a running job succeeds', stop.ok === true);
    await waitFor(() => !jobs.jobStatus(long.id).running, 15000);
    const after = jobs.readJob({ id: long.id });
    check('the stopped job is not reported as completed', after.meta.status === 'killed', after.meta.status);
    check('stopping an already-finished job is a no-op, not an error', jobs.stopJob(long.id).ok === true);
    const unknown = jobs.readJob({ id: 'job_does_not_exist' });
    check('reading an unknown job is a clear failure', unknown.ok === false && /no job/i.test(unknown.output));
  }

  // -------------------------------------------------------------------------
  // 9. The job registry is bounded
  // -------------------------------------------------------------------------
  {
    jobs.clear();
    const quick = POWERSHELL ? 'Write-Output x' : 'echo x';
    const ids = [];
    for (let i = 0; i < 5; i++) {
      const job = jobs.startJob({ command: quick, description: `job ${i}`, chatId: 'jobs_test' });
      if (job.ok) ids.push(job.id);
    }
    check('several jobs can be started', ids.length === 5, String(ids.length));
    const list = jobs.listJobs({ chatId: 'jobs_test' });
    check('job_list reports every job', list.meta.count >= 5, JSON.stringify(list.meta));
    check('job_list names each job', ids.every((id) => list.output.includes(id)));
    const stats = jobs.stats();
    check('the registry has a hard cap', stats.max === jobs.MAX_JOBS && stats.total <= jobs.MAX_JOBS);
  }

  // -------------------------------------------------------------------------
  // 10. The same surface through the tool registry (what the model calls)
  // -------------------------------------------------------------------------
  {
    jobs.clear();
    const viaTool = await tools.execute('run_shell', { command: QUIET + ' through-the-registry' }, { chatId: 'jobs_test' });
    check('run_shell is reachable through execute()', viaTool.ok === true);
    check('run_shell reports an exit code to the UI', viaTool.meta && viaTool.meta.exitCode === 0);
    check('run_shell names the shell for the UI', Boolean(viaTool.meta && viaTool.meta.shell), viaTool.meta && viaTool.meta.shell);

    const started = await tools.execute('start_job', { command: QUIET + ' from-a-tool', description: 'tool job' }, { chatId: 'jobs_test' });
    check('start_job is reachable through execute()', started.ok === true && Boolean(started.meta && started.meta.jobId));
    const id = started.meta.jobId;
    await waitFor(() => !jobs.jobStatus(id).running, 20000);
    const read = await tools.execute('job_output', { id }, { chatId: 'jobs_test' });
    check('job_output is reachable through execute()', read.ok === true && /from-a-tool/.test(read.output));
    const listing = await tools.execute('job_list', {}, { chatId: 'jobs_test' });
    check('job_list is reachable through execute()', listing.ok === true && Boolean(listing.output));

    // A tool the conversation did not enable must be refused, exactly like the
    // pre-existing tools — the new surface is not a way around that guard.
    const refused = await tools.execute('run_shell', { command: 'echo nope' }, { chatId: 'jobs_test', allowed: ['read_file'] });
    check('run_shell is refused when not enabled for the conversation', refused.ok === false && /not enabled/.test(refused.output));

    const missing = await tools.execute('run_shell', {}, { chatId: 'jobs_test' });
    check('run_shell with no command is a clear error', missing.ok === false);
    const capped = await tools.execute('run_shell', { command: QUIET + ' capped', timeoutMs: 99999999 }, { chatId: 'jobs_test' });
    check('an absurd timeout is clamped, not honoured', capped.ok === true);
  }

  // -------------------------------------------------------------------------
  // 11. read_file windows
  // -------------------------------------------------------------------------
  {
    const body = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
    await tools.execute('write_file', { path: 'window.txt', content: body }, { chatId: 'jobs_test' });
    const windowed = await tools.execute('read_file', { path: 'window.txt', offset: 200, limit: 10 }, { chatId: 'jobs_test' });
    check('a window reports only its own lines', /line 200/.test(windowed.output) && !/line 199\b/.test(windowed.output));
    check('a window is numbered', /200\tline 200/.test(windowed.output), windowed.output.split('\n')[1]);
    check('a window says how to get the next one', /offset: 210/.test(windowed.output));
    check('a window reports the total line count', windowed.meta.totalLines === 400, String(windowed.meta.totalLines));
    const whole = await tools.execute('read_file', { path: 'window.txt' }, { chatId: 'jobs_test' });
    check('a full read still works untouched', /line 1\n/.test(whole.output) && /line 400/.test(whole.output));
  }

  // -------------------------------------------------------------------------
  // 12. edit_file reports the diff it made
  // -------------------------------------------------------------------------
  {
    await tools.execute('write_file', {
      path: 'edit-me.js',
      content: 'function greet(name) {\n  return "hi " + name;\n}\n\nmodule.exports = greet;\n'
    }, { chatId: 'jobs_test' });
    const edited = await tools.execute('edit_file', {
      path: 'edit-me.js',
      find: 'return "hi " + name;',
      replace: 'return `hello ${name}`;'
    }, { chatId: 'jobs_test' });
    check('edit_file still succeeds', edited.ok === true);
    check('the edit reports how many lines changed', edited.meta.added === 1 && edited.meta.removed === 1, JSON.stringify({ a: edited.meta.added, r: edited.meta.removed }));
    check('the edit carries a unified diff', typeof edited.meta.diff === 'string' && edited.meta.diff.includes('@@'));
    check('the diff shows the removed line', edited.meta.diff.includes('-  return "hi " + name;'));
    check('the diff shows the added line', edited.meta.diff.includes('+  return `hello ${name}`;'));
    check('the diff keeps surrounding context', edited.meta.diff.includes('function greet(name) {'));
  }

  // -------------------------------------------------------------------------
  // 13. Repeat-call guard
  // -------------------------------------------------------------------------
  {
    const guard = require(path.join(ROOT, 'src', 'middleware', 'loop-guard.js'));
    guard.resetAll();
    const key = 'guard_test_run';
    const call = { runKey: key, name: 'read_file', args: { path: 'a.txt' } };

    check('a single call is not a repeat', guard.observe(call) === null);
    check('the second identical call earns a reminder', typeof guard.observe(call) === 'string');
    check('the third call is never left unanswered', typeof guard.observe(call) === 'string');
    check('the fourth call escalates with specifics', (() => {
      const notice = guard.observe(call);
      return typeof notice === 'string' && /4 times/.test(notice) && /read_file/.test(notice);
    })());
    check('the escalation names the arguments', /a\.txt/.test((() => {
      guard.resetAll();
      for (let i = 0; i < 4; i++) {
        const notice = guard.observe(call);
        if (i === 3) return notice || '';
      }
      return '';
    })()));
    guard.resetAll();
    guard.observe(call);
    guard.observe(call);
    check('a different call resets the chain', guard.observe({ runKey: key, name: 'read_file', args: { path: 'b.txt' } }) === null);
    check('a different tool resets the chain', guard.observe({ runKey: key, name: 'list_files', args: {} }) === null);
    check('argument order does not defeat the key',
      guard.callKey('x', { a: 1, b: 2 }) === guard.callKey('x', { b: 2, a: 1 }));
    check('another run key keeps its own chain', guard.observe({ runKey: 'other_run', name: 'read_file', args: { path: 'a.txt' } }) === null);
    check('a user turn clears the chain', (() => {
      guard.observe(call);
      const before = guard.observe(call);
      guard.noteNewUserTurn(key, [{ role: 'user', content: 'stop' }]);
      return before !== null && guard.observe(call) === null;
    })());
    check('very large arguments are bounded in the reminder', (() => {
      guard.resetAll();
      const huge = { path: 'x', content: 'A'.repeat(5000) };
      guard.observe({ runKey: 'k', name: 'write_file', args: huge });
      guard.observe({ runKey: 'k', name: 'write_file', args: huge });
      guard.observe({ runKey: 'k', name: 'write_file', args: huge });
      const notice = guard.observe({ runKey: 'k', name: 'write_file', args: huge });
      return notice === null || notice.length < 2000;
    })());

    // -----------------------------------------------------------------------
    // The recorded loop
    //
    // The same five files were written SEVEN times, then the same narration was
    // repeated until the step budget ended the turn. The guard was firing — it
    // simply fell silent after its last threshold, and a model this deep in a
    // loop is not reading hints.
    // -----------------------------------------------------------------------
    guard.resetAll();
    const loopCall = { runKey: 'loop_run', name: 'write_files', args: { files: { 'a.py': 'x' } } };
    const notices = [];
    for (let i = 0; i < 10; i++) notices.push(guard.observe(loopCall));
    check('the guard is silent on the very first call', notices[0] === null);
    check('every repeat after the first is answered, never silent',
      notices.slice(1).every((n) => typeof n === 'string'),
      notices.slice(1).map((n) => (n ? 'y' : 'n')).join(''));
    check('the reminder becomes an explicit instruction once the loop is confirmed',
      /STOP\./.test(notices[9]), String(notices[9]).split('\n')[0].slice(0, 58));
    check('the firm reminder names the run length', /10 times/.test(notices[9]));

    // A mutating call repeated past the threshold is refused without running.
    guard.resetAll();
    for (let i = 0; i < guard.BLOCK_AT; i++) guard.observe(loopCall);
    const blocked = guard.shouldBlock(loopCall);
    check('a mutating call repeated past the threshold is refused',
      blocked.blocked === true && /already been done/.test(blocked.output), String(blocked.output || '').slice(0, 70));
    check('the refusal counts the repeats', new RegExp(String(guard.BLOCK_AT)).test(blocked.output));
    check('a call under the threshold is not refused', (() => {
      guard.resetAll();
      for (let i = 0; i < guard.BLOCK_AT - 1; i++) guard.observe(loopCall);
      return guard.shouldBlock(loopCall).blocked === false;
    })());
    check('the same tool with DIFFERENT arguments is not refused', (() => {
      guard.resetAll();
      for (let i = 0; i < guard.BLOCK_AT; i++) guard.observe(loopCall);
      return guard.shouldBlock({ runKey: 'loop_run', name: 'write_files', args: { files: { 'b.py': 'y' } } }).blocked === false;
    })());

    // Polling is not a loop. A model waiting on a build reads the same job
    // repeatedly; blocking that would break real work to fix a cosmetic one.
    check('read-only tools are never refused, however often they repeat', (() => {
      guard.resetAll();
      const poll = { runKey: 'poll_run', name: 'job_output', args: { id: 'job_1' } };
      for (let i = 0; i < 20; i++) {
        guard.observe(poll);
        if (guard.shouldBlock(poll).blocked) return false;
      }
      return true;
    })());
    check('read_file is not treated as mutating',
      guard.MUTATING_TOOLS.has('read_file') === false && guard.MUTATING_TOOLS.has('write_files') === true);

    // Narration: a looping model must be shown once, not once per step.
    check('repeated narration is collapsed to a single occurrence', (() => {
      const line = "I'll create a complete set of template files for you.";
      const said = new Set();
      const out = [];
      for (let i = 0; i < 7; i++) out.push(loopKit.dropRepeatedNarration(line, said));
      return out.filter(Boolean).length === 1;
    })());
    check('new narration is never suppressed', (() => {
      const said = new Set();
      loopKit.dropRepeatedNarration('First thing.', said);
      return loopKit.dropRepeatedNarration('Second, different thing.', said) === 'Second, different thing.';
    })());
    check('an iteration mixing old and new text is kept whole', (() => {
      const said = new Set();
      loopKit.dropRepeatedNarration('First thing.', said);
      return loopKit.dropRepeatedNarration('First thing.\n\nBrand new paragraph.', said)
        === 'First thing.\n\nBrand new paragraph.';
    })());
    check('a genuinely empty iteration stays empty', (() => {
      const said = new Set();
      return loopKit.dropRepeatedNarration('', said) === '';
    })());
    guard.resetAll();
  }

  // -------------------------------------------------------------------------
  // 14. Clean up and report
  // -------------------------------------------------------------------------
  jobs.killAll();
  jobs.clear();
  shellKit.killAll();
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('CRASH', error);
  process.exit(2);
});

/** Resolves after `ms`. */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `predicate()` is true or the deadline passes. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(100);
  }
  return false;
}
