// Background jobs: a process the model started and does not have to wait for.
//
// WHY THIS EXISTS
// A turn is a sequence of model calls with a step budget, and a shell call that
// blocks on `npm install`, a test suite or a dev server spends that budget
// sitting still. Worse, the obvious workaround — a short timeout — kills the
// very command the user asked for. The harness solves this by handing the model
// a *task handle* instead of a result: `start_job` returns an id immediately,
// and the model collects the output later with `job_output`, stops it with
// `job_kill`, and sees everything at once with `job_list`.
//
// WHAT OWNS WHAT
// A job owns a child process and a bounded ring buffer of its merged output.
// Reading is a cursor, not a drain: `job_output` returns what arrived since the
// previous read and remembers how far it got, so polling a long build shows each
// line once instead of repeating the whole log every call. The buffer keeps its
// head AND its tail when it overflows, because a failure line is usually the
// last thing a build prints.
//
// LIFETIME
// Jobs are in-memory and per server process, like the task lists in
// middleware/todo.js. A finished job is kept long enough for the model to read
// its output and is then pruned; the registry is capped so a model that starts
// a job per step cannot grow it without limit. Every process is killed when the
// server exits — an orphaned `npm run dev` would hold its port open.
'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const shellKit = require('./shell');

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** How many jobs may exist at once. Starting one more evicts the oldest finished job. */
const MAX_JOBS = 32;
/** Raw output kept per job. The head and the tail survive; the middle is reported as dropped. */
const MAX_BUFFER_BYTES = 160 * 1024;
/** How much of a job's output one `job_output` call returns. */
const MAX_READ_BYTES = 24000;
/** How long a finished job's output stays readable. */
const KEEP_FINISHED_MS = 30 * 60 * 1000;
/** A job with no timeout of its own is stopped after this, so nothing runs forever. */
const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;
/** Cap a caller cannot raise. */
const MAX_JOB_TIMEOUT_MS = 60 * 60 * 1000;
/** How long a job gets to die politely before its tree is forced. */
const KILL_GRACE_MS = 2000;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} live and recently finished jobs, oldest first. */
const jobs = new Map();
/** Sweeper handle, created lazily so importing this module never starts a timer. */
let sweeper = null;
/** Guard so the process-exit cleanup is installed exactly once. */
let exitHookInstalled = false;

/** A short, sortable, unguessable handle. */
function newJobId() {
  return 'job_' + crypto.randomBytes(5).toString('hex');
}

/**
 * Bounded output buffer for one job.
 *
 * Keeps the first and last `MAX_BUFFER_BYTES / 2` characters when a job prints
 * more than that, and counts what it discarded so the model is told the log is
 * incomplete instead of silently reading a gap. A `cursor` is an absolute
 * character offset into the stream, which stays comparable across trimming.
 */
class OutputBuffer {
  constructor() {
    this.head = '';
    this.tail = '';
    this.tailStart = 0; // absolute offset of tail[0]
    this.length = 0; // absolute characters received
    this.dropped = 0;
    this._decoder = new StringDecoder('utf8');
  }

  /**
   * Appends already-decoded text.
   *
   * Before the stream is longer than the window, everything lives in `tail` and
   * no offset bookkeeping is needed. The first overflow promotes what exists to
   * `head` and starts `tail` fresh; after that each chunk appends to `tail` and
   * pushes characters off its front, counting them as dropped.
   */
  _append(text) {
    if (!text) return;
    const half = MAX_BUFFER_BYTES / 2;
    if (this.head.length < half) {
      if (this.tail.length + text.length <= half) {
        this.tail += text;
      } else {
        const whole = this.tail + text;
        this.head = whole.slice(0, half);
        const rest = whole.slice(half);
        this.tailStart = this.length + text.length - rest.length;
        this.tail = rest;
      }
    } else {
      this.tail += text;
      const excess = this.tail.length - half;
      if (excess > 0) {
        this.tail = this.tail.slice(excess);
        this.tailStart += excess;
        this.dropped += excess;
      }
    }
    this.length += text.length;
  }

  /** Appends one raw chunk. */
  push(chunk) {
    this._append(this._decoder.write(chunk));
  }

  /** Flushes the decoder — call once the process has closed. */
  end() {
    const rest = this._decoder.end();
    if (rest) this._append(rest);
  }

  /**
   * Reads everything after an absolute offset.
   *
   * @param {number} from - absolute character offset to read from.
   * @returns {{text: string, next: number, lost: number, complete: boolean}}
   *   `lost` counts characters the caller asked for that trimming removed.
   */
  read(from = 0) {
    const start = Math.max(0, Math.min(Number(from) || 0, this.length));
    const lost = this.dropped > 0 && start < this.tailStart ? Math.min(this.dropped, this.tailStart - start) : 0;
    const effective = Math.max(start, this.tailStart);
    const available = this.tail.slice(Math.max(0, effective - this.tailStart));
    const text = available.length > MAX_READ_BYTES
      ? available.slice(0, MAX_READ_BYTES)
      : available;
    return {
      text,
      next: effective + text.length,
      lost,
      complete: this.dropped === 0
    };
  }
}

/**
 * Starts a detached command as a job.
 *
 * The command runs through the same shell the foreground `run_shell` uses
 * (`src/shell.js` resolution), so PATH, encoding setup and platform behaviour
 * match. The difference is ownership: the job's process is not tied to the
 * turn's abort signal, so a Stop button ends the answer, not the build.
 *
 * @param {object} request - what to run.
 * @param {string} request.command - shell text from the model.
 * @param {string} [request.description] - what it does, for the row and the list.
 * @param {string|null} [request.chatId] - the conversation that started it.
 * @param {string} [request.cwd] - working directory; defaults to the chat workspace.
 * @param {number} [request.timeoutMs] - wall-clock cap for the whole job.
 * @returns {{ok: boolean, id?: string, output: string, meta?: object}}
 */
function startJob({ command, description = '', chatId = null, cwd = null, timeoutMs } = {}) {
  const body = shellKit.assertSendable(command, 'the command').trim();
  if (!body) return { ok: false, output: 'Error: command must be a non-empty string' };

  const shell = shellKit.resolveShell();
  if (!shell) return { ok: false, output: 'Error: no usable shell found on this system.' };

  prune();
  if (jobs.size >= MAX_JOBS) {
    // Only a finished job is evictable; refusing is better than killing the
    // user's build to make room for another one.
    if (!evictOldestFinished()) {
      return { ok: false, output: `Error: ${MAX_JOBS} jobs are already running. Wait for one to finish or stop one with job_kill.` };
    }
  }

  const id = newJobId();
  const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_JOB_TIMEOUT_MS, 5000), MAX_JOB_TIMEOUT_MS);
  const workdir = cwd || workspaceDir(chatId);

  const job = {
    id,
    command: body,
    description: String(description || '').slice(0, 200),
    chatId: chatId ? String(chatId) : null,
    cwd: workdir,
    shell: shell.label,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    timedOut: false,
    killed: false,
    timeoutMs: limit,
    buffer: new OutputBuffer(),
    cursor: 0,
    meta: null
  };
  jobs.set(id, job);

  const isWin = process.platform === 'win32';
  let child;
  try {
    child = spawn(shell.file, jobShellArgs(shell, body), {
      cwd: workdir,
      env: jobEnv(),
      windowsHide: true,
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    job.status = 'failed';
    job.error = err.message;
    job.endedAt = Date.now();
    return { ok: false, output: `Error: the job could not start: ${err.message}` };
  }

  job.pid = child.pid;
  const swallow = () => { /* the close handler owns the outcome */ };
  child.stdout.on('error', swallow);
  child.stderr.on('error', swallow);
  // A job is detached work: after the id is returned, nothing may hold an
  // unhandled stream error against the server process.
  child.on('error', (err) => finish(job, { code: null, signal: null, error: err.message }));
  child.stdout.on('data', (chunk) => job.buffer.push(chunk));
  child.stderr.on('data', (chunk) => job.buffer.push(chunk));
  child.on('close', (code, signal) => finish(job, { code, signal, error: null }));

  job.child = child;
  job.timer = setTimeout(() => {
    job.timedOut = true;
    stopJob(id, 'timed out');
  }, limit);
  job.timer.unref?.();

  ensureSweeper();

  return {
    ok: true,
    id,
    output: [
      `Started background job ${id} (${shell.label}).`,
      `Command: ${body}`,
      `Working directory: ${workdir}`,
      `No timeout applies to this turn — it stops after ${Math.round(limit / 60000) || 1} minute(s) unless you end it first.`,
      '',
      `Collect its output with job_output({ "id": "${id}" }) — that returns only what has arrived since your last read, so call it again to follow a long build.`,
      `Stop it with job_kill({ "id": "${id}" }). List everything with job_list().`
    ].join('\n'),
    meta: { jobId: id, pid: child.pid, cwd: workdir, shell: shell.label, background: true }
  };
}

/**
 * How to run one command in a shell that will exit when it finishes.
 *
 * Deliberately different from the persistent session's wrapper: there is no
 * marker protocol here because the process's own exit status is the answer, and
 * a job that never exits is what `job_kill` and the job timeout exist for.
 *
 * Both PowerShell hosts need `-Command` to be the LAST parameter with the
 * command text as its value — passing anything after it (including the `-` that
 * means "read stdin") makes the host print its usage and exit non-zero.
 *
 * @param {object} shell - the resolved shell from src/shell.js.
 * @param {string} command - the command text.
 * @returns {string[]} argv for the shell binary.
 */
function jobShellArgs(shell, command) {
  if (shell.kind === 'bash' || shell.kind === 'sh') return shell.args.concat(['-c', command]);
  const args = shell.args.filter((arg) => arg !== '-');
  return args.concat([command]);
}

/** The environment a job runs with: the shell's own, minus anything interactive. */
function jobEnv() {
  const env = { ...process.env };
  if (process.platform !== 'win32') {
    env.TERM = 'dumb';
    env.NO_COLOR = '1';
  }
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';
  return env;
}

/** The directory a job for this chat runs in. */
function workspaceDir(chatId) {
  try {
    const store = require('./store');
    const dir = chatId ? store.getChatWorkspaceDir(chatId) : null;
    const target = dir || store.WORKSPACE_DIR;
    require('fs').mkdirSync(target, { recursive: true });
    return target;
  } catch {
    return process.cwd();
  }
}

/** Settles a job exactly once and records how it ended. */
function finish(job, { code, signal, error }) {
  if (job.status !== 'running') return;
  clearTimeout(job.timer);
  job.buffer.end();
  job.endedAt = Date.now();
  job.exitCode = typeof code === 'number' ? code : null;
  job.signal = signal || null;
  job.error = error || null;
  if (error) job.status = 'failed';
  else if (job.killed) job.status = 'killed';
  else job.status = 'completed';
  job.durationMs = job.endedAt - job.startedAt;
}

/** Kills a job's process tree and its timer. Idempotent. */
function stopJob(id, reason = 'stopped') {
  const job = jobs.get(id);
  if (!job) return { ok: false, output: `Error: no job with id "${id}".` };
  if (job.status !== 'running') {
    return { ok: true, output: `Job ${id} is already ${job.status} — nothing to stop.`, meta: { jobId: id, status: job.status } };
  }
  job.killed = true;
  job.killReason = String(reason).slice(0, 120);
  clearTimeout(job.timer);
  shellKit.killTree(job.child, false);
  setTimeout(() => shellKit.killTree(job.child, true), KILL_GRACE_MS).unref?.();
  return { ok: true, output: `Stopping job ${id} (${job.killReason}).`, meta: { jobId: id, status: 'stopping' } };
}

/**
 * Reads what a job has printed since the caller last read it.
 *
 * @param {object} request - the read.
 * @param {string} request.id - job id.
 * @param {boolean} [request.reset] - read from the beginning again.
 * @param {number} [request.max_bytes] - lower the per-call cap.
 * @returns {{ok: boolean, output: string, meta?: object}}
 */
function readJob({ id, reset = false, max_bytes } = {}) {
  const job = jobs.get(String(id || '').trim());
  if (!job) {
    const known = [...jobs.keys()].slice(-5);
    return {
      ok: false,
      output: `Error: no job with id "${id}".` + (known.length ? ` Known jobs: ${known.join(', ')}.` : ' No job has been started yet.')
    };
  }
  const from = reset === true ? 0 : job.cursor;
  const slice = job.buffer.read(from);
  job.cursor = Math.max(job.cursor, slice.next);

  const cap = Math.min(Math.max(Number(max_bytes) || MAX_READ_BYTES, 500), MAX_READ_BYTES);
  let text = slice.text;
  let truncated = false;
  if (Buffer.byteLength(text, 'utf8') > cap) {
    text = text.slice(0, cap);
    truncated = true;
    // The cursor only advances over what was actually handed over, so the rest
    // arrives on the next call instead of being silently skipped.
    job.cursor = Math.max(0, slice.next - (slice.text.length - text.length));
  }

  const header = statusLine(job, { reset });
  const notes = [];
  if (slice.lost > 0) notes.push(`[${slice.lost} earlier characters were dropped — a job keeps a bounded log]`);
  if (truncated) notes.push('[more output is waiting; call job_output again with the same id]');

  const body = text.trim() ? text.replace(/\s+$/, '') : (job.status === 'running' ? '(no output yet)' : '(no output)');
  return {
    ok: true,
    output: [header, '', body, ...(notes.length ? ['', notes.join('\n')] : [])].join('\n'),
    meta: {
      jobId: job.id,
      status: job.status,
      running: job.status === 'running',
      exitCode: job.exitCode,
      command: job.command,
      ...(job.status === 'running' ? {} : { ms: job.durationMs }),
      ...(job.timedOut ? { timedOut: true } : {}),
      ...(truncated ? { truncated: true } : {})
    }
  };
}

/**
 * Looks at a job without consuming any of its output.
 *
 * Separate from {@link readJob} on purpose: reading advances a cursor, so
 * polling a job's progress must not be the same call as collecting its output.
 * The web layer and the tests use this to watch a job; only the model's
 * `job_output` call moves the cursor.
 *
 * @param {string} id - job id.
 * @returns {{id: string, status: string, running: boolean, exitCode: number|null,
 *   unread: number, command: string, description: string, startedAt: number,
 *   durationMs: number|null, cwd: string, shell: string, pid: number|undefined}|null}
 */
function jobStatus(id) {
  const job = jobs.get(String(id || '').trim());
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    running: job.status === 'running',
    exitCode: job.exitCode,
    unread: Math.max(0, job.buffer.length - job.cursor),
    command: job.command,
    description: job.description,
    startedAt: job.startedAt,
    durationMs: job.status === 'running' ? null : job.durationMs,
    cwd: job.cwd,
    shell: job.shell,
    pid: job.pid
  };
}

/** Every known job's status, newest last, without consuming output. */
function allStatuses() {
  return [...jobs.keys()].map(jobStatus);
}

/** One human-readable status line for a job. */
function statusLine(job, { reset = false } = {}) {  const parts = [];
  if (job.status === 'running') {
    parts.push(`Job ${job.id} is still running (${formatDuration(Date.now() - job.startedAt)} so far)`);
  } else {
    const how = job.timedOut ? 'stopped after its time limit'
      : job.killed ? 'stopped' + (job.killReason ? ` (${job.killReason})` : '')
        : job.error ? `could not start: ${job.error}`
          : job.signal ? `killed by signal ${job.signal}`
            : `finished with exit code ${job.exitCode}`;
    parts.push(`Job ${job.id} ${how} in ${formatDuration(job.durationMs || 0)}`);
  }
  if (reset) parts.push('(read from the beginning)');
  if (job.command) parts.push(`— ${job.command}`);
  return parts.join(' ');
}

/** Compact duration for a status line. */
function formatDuration(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  if (value < 1000) return value + 'ms';
  if (value < 60000) return (value / 1000).toFixed(1) + 's';
  return Math.floor(value / 60000) + 'm ' + Math.round((value % 60000) / 1000) + 's';
}

/**
 * Lists the jobs this server knows about.
 *
 * @param {object} [request] - the listing.
 * @param {string|null} [request.chatId] - restrict to one conversation.
 * @returns {{ok: boolean, output: string, meta: object}}
 */
function listJobs({ chatId = null } = {}) {
  const all = [...jobs.values()].filter((job) => !chatId || job.chatId === null || job.chatId === String(chatId));
  if (!all.length) {
    return { ok: true, output: 'No background jobs have been started.', meta: { count: 0, running: 0 } };
  }
  const lines = all.map((job) => {
    const state = job.status === 'running'
      ? `running for ${formatDuration(Date.now() - job.startedAt)}`
      : job.timedOut ? 'timed out'
        : job.killed ? 'stopped'
          : job.error ? 'failed to start'
            : `exit ${job.exitCode} in ${formatDuration(job.durationMs || 0)}`;
    const drift = job.buffer.length - job.cursor;
    return `- ${job.id} [${state}]${drift > 0 ? ` (${drift} unread chars)` : ''}\n    ${job.command.slice(0, 160)}`;
  });
  const running = all.filter((job) => job.status === 'running').length;
  return {
    ok: true,
    output: `${all.length} job(s) — ${running} still running:\n\n${lines.join('\n')}\n\nRead one with job_output and stop one with job_kill.`,
    meta: { count: all.length, running }
  };
}

/** Removes finished jobs whose output has been readable long enough. */
function prune(now = Date.now()) {
  for (const [id, job] of [...jobs]) {
    if (job.status === 'running') continue;
    if (now - (job.endedAt || now) > KEEP_FINISHED_MS) jobs.delete(id);
  }
}

/** Evicts the oldest finished job to make room. Returns false when none can go. */
function evictOldestFinished() {
  for (const [id, job] of jobs) {
    if (job.status !== 'running') {
      jobs.delete(id);
      return true;
    }
  }
  return false;
}

function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => prune(), 60000);
  sweeper.unref?.();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // A job is a process this server owns. Leaving one behind holds its port and
    // its files open after HAMA exits.
    process.once('exit', () => {
      for (const job of jobs.values()) {
        if (job.status === 'running') shellKit.killTree(job.child, true);
      }
    });
  }
}

/** Stops every running job. Exposed for an orderly shutdown and for tests. */
function killAll() {
  let killed = 0;
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      job.killed = true;
      clearTimeout(job.timer);
      shellKit.killTree(job.child, true);
      job.status = 'killed';
      job.endedAt = Date.now();
      job.durationMs = job.endedAt - job.startedAt;
      killed++;
    }
  }
  return { killed };
}

/** Forgets every job without touching its process — tests only. */
function clear() {
  for (const job of jobs.values()) clearTimeout(job.timer);
  jobs.clear();
}

/** How many jobs exist and how many are running. */
function stats() {
  let running = 0;
  for (const job of jobs.values()) if (job.status === 'running') running++;
  return { total: jobs.size, running, max: MAX_JOBS };
}

module.exports = {
  startJob,
  readJob,
  stopJob,
  listJobs,
  jobStatus,
  allStatuses,
  killAll,
  clear,
  stats,
  prune,
  MAX_JOBS,
  MAX_BUFFER_BYTES,
  MAX_READ_BYTES,
  KEEP_FINISHED_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  MAX_JOB_TIMEOUT_MS
};
