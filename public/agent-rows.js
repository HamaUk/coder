// How a tool run is described to the user.
//
// This exists because the old renderer printed `JSON.stringify(run.args)` into a
// <pre> for every tool call — and for write_file the arguments *are* the whole
// file, so creating a component dumped its entire source into the transcript.
// What the user asked for instead is what Claude Code shows: one line saying
// what is happening, with the code behind a click.
//
// All of the decision-making is here rather than in app.js because app.js is a
// browser IIFE with no exports and therefore no tests. These are pure functions
// — no DOM, no globals — so `.smoke/ui.test.js` can pin the behaviour that
// matters: a write row names the file and never leaks its contents.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentRows = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const EXT_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', json: 'json',
    md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'bash', sql: 'sql', txt: 'text'
  };

  /** The last path segment, for a target that has to fit on one line. */
  function baseName(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i === -1 ? s : s.slice(i + 1);
  }

  function langOf(p) {
    const name = baseName(p);
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return '';
    return EXT_LANG[name.slice(dot + 1).toLowerCase()] || name.slice(dot + 1).toLowerCase();
  }

  function formatBytes(n) {
    if (n == null) return '';
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '';
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /** Durations as a person reads them: 340ms, 1.2s, 2m 14s. */
  function formatMs(ms) {
    if (ms == null) return '';
    const v = Number(ms);
    if (!Number.isFinite(v) || v < 0) return '';
    if (v < 1000) return Math.round(v) + 'ms';
    if (v < 60000) return (v / 1000).toFixed(1) + 's';
    const m = Math.floor(v / 60000);
    const s = Math.round((v % 60000) / 1000);
    return `${m}m ${s}s`;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
  }

  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  /**
   * Compact relative time, as a structured bucket rather than a string.
   *
   * Keeping the bucket separate from the wording means every surface that dates
   * the same row agrees on it, and the copy can change without touching the
   * arithmetic. `now` is injected so this stays pure and testable.
   */
  function relativeTime(at, now) {
    const diff = Number(now) - Number(at);
    if (!Number.isFinite(diff) || diff < MINUTE) return { unit: 'now', n: 0 };
    if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MINUTE) };
    if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) };
    if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) };
    if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) };
    return { unit: 'years', n: Math.floor(diff / (365 * DAY)) };
  }

  /** The bucket as a short trailing label. */
  function formatRelative(at, now) {
    const { unit, n } = relativeTime(at, now);
    switch (unit) {
      case 'now': return 'just now';
      case 'minutes': return `${n}m ago`;
      case 'hours': return `${n}h ago`;
      case 'days': return n === 1 ? 'yesterday' : `${n}d ago`;
      case 'months': return `${n}mo ago`;
      default: return `${n}y ago`;
    }
  }

  function clip(s, n) {
    const v = String(s ?? '').replace(/\s+/g, ' ').trim();
    return v.length > n ? v.slice(0, n - 1) + '…' : v;
  }

  /**
   * What a step is called when it did NOT succeed.
   *
   * The success labels are past tense ("Created", "Edited") because that reads
   * well on a row that worked. Keeping them past tense on a failure produced rows
   * like "Created · Error: … · failed", which says the write happened and did not
   * in the same breath.
   */
  const FAILED_LABELS = {
    Writing: 'Failed to write',
    Wrote: 'Failed to write',
    'Appended to': 'Failed to append',
    Created: 'Failed to create',
    Updated: 'Failed to update',
    Creating: 'Failed to create',
    Editing: 'Failed to edit',
    Edited: 'Failed to edit',
    Reading: 'Failed to read',
    Read: 'Failed to read',
    Listing: 'Failed to list',
    Listed: 'Failed to list',
    Deleting: 'Failed to delete',
    Deleted: 'Failed to delete',
    'Creating folder': 'Failed to create folder',
    'Created folder': 'Failed to create folder',
    Running: 'Failed to run',
    Ran: 'Failed to run',
    'Running command': 'Command failed',
    'Ran command': 'Command failed',
    'Command timed out': 'Command stopped',
    'Starting job': 'Failed to start the job',
    'Started job': 'Failed to start the job',
    'Reading job': 'Failed to read the job',
    'Read job': 'Failed to read the job',
    'Stopping job': 'Failed to stop the job',
    'Stopped job': 'Failed to stop the job',
    'Listing jobs': 'Failed to list jobs',
    'Listed jobs': 'Failed to list jobs',
    Grepping: 'Grep failed',
    Grepped: 'Grep failed',
    'Searching the web': 'Web search failed',
    'Searched the web': 'Web search failed',
    Fetching: 'Failed to fetch',
    Fetched: 'Failed to fetch',
    'Generating app': 'Failed to generate the app',
    'Generated app': 'Failed to generate the app',
    'Updating tasks': 'Failed to update the task list',
    'Updated tasks': 'Failed to update the task list'
  };

  /**
   * The path as it should read on a one-line row.
   *
   * A leading `./` is noise; everything else is shown exactly as the model wrote
   * it, so a Windows path keeps its backslashes rather than being rewritten into
   * a shape that does not exist on the user's disk.
   */
  function displayPath(p) {
    return String(p == null ? '' : p).trim().replace(/^\.[\\/]/, '');
  }

  /**
   * Argument keys that name what a row acted on, best first — per row kind.
   *
   * This is the part that lets a tool the UI has never seen render sensibly: the
   * kind picks the preference list rather than the tool name picking a hand-written
   * branch, so a new tool that takes a `file_path` (snake_case) still shows its
   * path instead of a dump of its argument names.
   */
  const TARGET_KEYS = {
    write: ['path', 'file_path', 'filename', 'file'],
    edit: ['path', 'file_path', 'filename', 'file'],
    read: ['path', 'file_path', 'filename', 'file'],
    delete: ['path', 'file_path', 'filename', 'file'],
    mkdir: ['path', 'dir', 'directory', 'folder'],
    list: ['path', 'dir', 'directory', 'folder'],
    run: ['path', 'script', 'command', 'file'],
    shell: ['command', 'description', 'id'],
    search: ['query', 'pattern', 'url', 'q'],
    fetch: ['url', 'link', 'href'],
    generate: ['prompt', 'description'],
    other: ['path', 'file_path', 'filename', 'query', 'url', 'command', 'name']
  };

  function pickTarget(kind, args) {
    for (const key of TARGET_KEYS[kind] || TARGET_KEYS.other) {
      const v = args[key];
      if (typeof v === 'string' && v.trim()) return displayPath(v);
    }
    return '';
  }

  /** Row kinds whose summary really is a workspace path. */
  const FILE_KINDS = new Set(['write', 'edit', 'read', 'delete', 'mkdir', 'list', 'run']);

  /** The first non-empty line of a failure, for the collapsed row. */
  function firstLine(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (t) return t;
    }
    return '';
  }

  // A write that changed an existing file is an edit, and the row should say so:
  // "Created" and "Updated" mean different things to someone scanning the list.
  // Falls back to the neutral "Wrote" when meta is missing (a transcript saved
  // before this existed, or a tool that does not report it).
  function writeLabel(run) {
    if (run.pending) return 'Writing';
    const meta = run.meta || {};
    // Appending is its own action: "Updated" would suggest the file was
    // rewritten, when in fact content was added to the end.
    if (meta.appended === true) return 'Appended to';
    const created = meta.created;
    if (created === true) return 'Created';
    if (created === false) return 'Updated';
    return 'Wrote';
  }

  /** Counts the numbered results in a web_search payload. */
  function countResults(text) {
    const m = String(text || '').match(/^\s*\d+\.\s+\S/gm);
    return m ? m.length : 0;
  }

  /**
   * Everything the row header needs, derived from the run alone.
   *
   * `target` is always safe to print: a path, a query, a hostname, a count. It is
   * never file content — see `.smoke/ui.test.js`.
   */
  function describeRun(run) {
    const r = run || {};
    const name = String(r.name || '');
    const args = r.args || {};
    const meta = r.meta || {};
    const pending = !!r.pending;
    const failed = r.ok === false;

    const row = {
      kind: 'other', icon: 'i-tool', label: name, target: '',
      chips: [], badChips: [], pending, failed
    };
    // The path behind a file row, resolved through the same key-preference list
    // the unknown-tool fallback uses — so a call that says `file_path` or
    // `filename` instead of `path` still names the file it touched.
    const fileTarget = () => pickTarget(row.kind, args);
    switch (name) {
      case 'write_file': {
        row.kind = 'write';
        row.icon = 'i-file-plus';
        row.label = writeLabel(r);
        row.target = fileTarget() || '(unnamed)';
        const lang = langOf(args.path);
        if (lang) row.chips.push(lang);
        if (meta.lines != null) row.chips.push(plural(meta.lines, 'line'));
        else if (meta.bytes != null) row.chips.push(formatBytes(meta.bytes));
        break;
      }
      case 'write_files': {
        const files = Array.isArray(args.files) ? args.files : [];
        const n = meta.count != null ? meta.count : files.length;
        row.kind = 'write';
        row.icon = 'i-file-plus';
        row.label = pending ? 'Creating' : 'Created';
        row.target = plural(n, 'file');
        if (n && files.length) {
          row.chips.push(files.length > 1 ? `${baseName(files[0].path)} +${files.length - 1}` : baseName(files[0].path));
        }
        // The server reports each file's size, line count and whether it was
        // created or overwritten; the row used to show none of it, so a batch
        // that overwrote five existing files read exactly like one that created
        // five new ones.
        const reported = Array.isArray(meta.files) ? meta.files : [];
        if (reported.length) {
          row.files = reported;
          const lines = reported.reduce((sum, f) => sum + (Number(f && f.lines) || 0), 0);
          const bytes = reported.reduce((sum, f) => sum + (Number(f && f.bytes) || 0), 0);
          if (lines) row.chips.push(plural(lines, 'line'));
          else if (bytes) row.chips.push(formatBytes(bytes));
          const replaced = reported.filter((f) => f && f.created === false).length;
          if (replaced) row.chips.push(replaced === reported.length ? 'all replaced' : `${replaced} replaced`);
        }
        break;
      }
      case 'edit_file': {
        row.kind = 'edit';
        row.icon = 'i-pencil';
        row.label = pending ? 'Editing' : 'Edited';
        row.target = fileTarget() || '(unnamed)';
        if (!pending && meta.added != null) {
          row.chips.push(`+${meta.added} −${meta.removed}`);
          // The same numbers, structured, so the row can render the stats as
          // their own coloured pair rather than one flat string.
          row.diff = { added: Number(meta.added) || 0, removed: Number(meta.removed) || 0 };
          if (meta.replacements > 1) row.chips.push(`×${meta.replacements}`);
        } else if (langOf(args.path)) {
          row.chips.push(langOf(args.path));
        }
        // The server's own diff is capped; when it was cut, the body shows only
        // part of the edit and the row has to say so rather than let a partial
        // diff read as the whole change.
        if (meta.diffTruncated === true) row.badChips.push('diff truncated');
        break;
      }
      case 'grep': {
        row.kind = 'search';
        row.icon = 'i-search';
        row.label = pending ? 'Grepping' : 'Grepped';
        row.target = clip(args.pattern, 70);
        if (meta.matches != null) row.chips.push(plural(meta.matches, 'match', 'matches'));
        if (meta.files != null) row.chips.push(plural(meta.files, 'file'));
        break;
      }
      case 'read_file': {
        row.kind = 'read';
        row.icon = 'i-file';
        row.label = pending ? 'Reading' : 'Read';
        row.target = fileTarget() || '(unnamed)';
        // A paged read is not the whole file, and the row said nothing about it:
        // a model that had seen the first 200 lines of a 900-line file looked
        // exactly like one that had read all of it.
        if (meta.truncated === true && meta.totalLines != null) {
          row.chips.push(`${meta.lines || 0} of ${meta.totalLines} lines`);
          row.badChips.push('truncated');
        } else if (meta.lines != null) {
          row.chips.push(plural(meta.lines, 'line'));
        }
        break;
      }
      case 'list_files': {
        row.kind = 'list';
        row.icon = 'i-folder';
        row.label = pending ? 'Listing' : 'Listed';
        row.target = fileTarget() || 'workspace root';
        if (meta.count != null) row.chips.push(plural(meta.count, 'entry', 'entries'));
        break;
      }
      case 'delete_file': {
        row.kind = 'delete';
        row.icon = 'i-trash';
        row.label = pending ? 'Deleting' : 'Deleted';
        row.target = fileTarget() || '(unnamed)';
        break;
      }
      case 'create_directory': {
        row.kind = 'mkdir';
        row.icon = 'i-folder';
        row.label = pending ? 'Creating folder' : 'Created folder';
        row.target = fileTarget() || '(unnamed)';
        break;
      }
      case 'run_script': {
        row.kind = 'run';
        row.icon = 'i-terminal';
        row.label = pending ? 'Running' : 'Ran';
        row.target = fileTarget() || 'script';
        if (!pending && meta.exitCode != null) {
          row.chips.push(meta.exitCode === 0 ? 'exit 0' : `exit ${meta.exitCode}`);
          if (meta.ms != null) { row.chips.push(formatMs(meta.ms)); row.timeShown = true; }
        }
        if (Array.isArray(args.args) && args.args.length) row.chips.push(plural(args.args.length, 'arg'));
        // The runner never started at all — a different failure from a script
        // that ran and exited non-zero, and the only signal that says so.
        if (meta.failedToStart) row.badChips.push('never started');
        if (meta.spilled) row.badChips.push('output truncated');
        break;
      }
      case 'run_shell': {
        // The command IS the target: it is what the user wants to read on the
        // row, and the row never shows file content so there is no leak risk.
        row.kind = 'shell';
        row.icon = 'i-terminal';
        row.label = pending ? 'Running command' : (meta.timedOut ? 'Command timed out' : 'Ran command');
        row.target = clip(args.command, 120) || 'command';
        if (!pending) {
          if (meta.exitCode != null) row.chips.push(meta.exitCode === 0 ? 'exit 0' : `exit ${meta.exitCode}`);
          if (meta.shell) row.chips.push(String(meta.shell));
          if (meta.ms != null) { row.chips.push(formatMs(meta.ms)); row.timeShown = true; }
        }
        if (meta.spilled) row.badChips.push('output truncated');
        break;
      }
      case 'start_job': {
        row.kind = 'shell';
        row.icon = 'i-terminal';
        row.label = pending ? 'Starting job' : 'Started job';
        row.target = clip(args.description || args.command, 100) || 'background job';
        if (meta.jobId) row.chips.push(String(meta.jobId));
        if (!pending) row.chips.push('background');
        if (meta.pid) row.chips.push('pid ' + meta.pid);
        break;
      }
      case 'job_output': {
        row.kind = 'shell';
        row.icon = 'i-terminal';
        row.label = pending ? 'Reading job' : 'Read job';
        row.target = String(args.id || 'job');
        if (!pending && meta && meta.status) {
          row.chips.push(String(meta.status));
          if (meta.exitCode != null) row.chips.push(meta.exitCode === 0 ? 'exit 0' : `exit ${meta.exitCode}`);
        }
        // Reading the job succeeded; the JOB failed. The row said "Read job" with
        // a green tick either way, so a background build that died rendered as a
        // success — the one thing a background job must not do.
        if (!pending && meta && meta.exitCode != null && meta.exitCode !== 0) {
          row.badChips.push(meta.exitCode > 0 ? 'job failed' : 'job killed');
        }
        // A running job is not a finished row: the status is what matters, and
        // the row should not claim the work is done because a read returned.
        if (!pending && meta && meta.running) row.pending = false;
        break;
      }
      case 'job_kill': {
        row.kind = 'shell';
        row.icon = 'i-terminal';
        row.label = pending ? 'Stopping job' : 'Stopped job';
        row.target = String(args.id || 'job');
        if (args.reason) row.chips.push(clip(args.reason, 60));
        break;
      }
      case 'job_list': {
        row.kind = 'list';
        row.icon = 'i-terminal';
        row.label = pending ? 'Listing jobs' : 'Listed jobs';
        row.target = 'background jobs';
        if (meta.count != null) row.chips.push(plural(meta.count, 'job'));
        if (meta.running) row.chips.push(`${meta.running} running`);
        break;
      }
      case 'web_search': {
        row.kind = 'search';
        row.icon = 'i-search';
        row.label = pending ? 'Searching the web' : 'Searched the web';
        row.target = clip(args.query, 70);
        if (!pending) {
          const n = countResults(r.result);
          if (n) row.chips.push(plural(n, 'result'));
        }
        break;
      }
      case 'fetch_url': {
        row.kind = 'fetch';
        row.icon = 'i-globe';
        row.label = pending ? 'Fetching' : 'Fetched';
        row.target = String(args.url || '');
        break;
      }
      case 'llamacoder_generate': {
        row.kind = 'generate';
        row.icon = 'i-sparkle';
        row.label = pending ? 'Generating app' : 'Generated app';
        row.target = clip(args.prompt, 60);
        if (args.save_path) row.chips.push(String(args.save_path));
        break;
      }
      case 'update_todos': {
        const t = describeTodos(args);
        row.kind = 'todos';
        row.icon = 'i-checklist';
        row.label = pending ? 'Updating tasks' : 'Updated tasks';
        row.target = `${t.done}/${t.total} done`;
        if (t.total) row.chips.push(`${Math.round((t.done / t.total) * 100)}%`);
        break;
      }
      default: {
        // Unknown tool: still never dump the arguments. The row's kind picks a
        // preference list of argument names, so a tool this UI has never heard of
        // (or one using `file_path` instead of `path`) still names what it acted
        // on; only a genuinely shapeless payload falls back to its key names.
        row.target = pickTarget(row.kind, args);
        if (!row.target) {
          const keys = Object.keys(args);
          row.target = keys.length ? `(${keys.slice(0, 4).join(', ')})` : '';
        }
        break;
      }
    }

    if (failed && !pending) row.failed = true;

    // Facts about the CALL rather than its result, which the row had no way to
    // show before: the loop guard firing (so a repeated row does not read as
    // fresh work), a call the guard refused outright, a file the agent saved
    // from a code block rather than through a tool the model chose.
    if (r.repeat === true) row.badChips.push('repeat');
    if (meta.blocked === true) row.badChips.push('refused');
    if (meta.auto === true) row.chips.push('auto-saved');

    // A failed step must not be labelled as if it succeeded. "Created … failed"
    // is a contradiction on one row: the past tense claims the write happened.
    if (row.failed) row.label = FAILED_LABELS[row.label] || row.label;

    // Three states, not two. A run that timed out or was cut short is not the
    // same as one that failed, and colouring it red tells the user their code is
    // broken when the clock simply ran out.
    row.state = pending ? 'running'
      : !failed ? 'ok'
        : (meta.timedOut === true || meta.interrupted === true || meta.killed === true) ? 'stopped'
          : 'error';

    // A failure REPLACES the row's normal summary, so what went wrong is readable
    // without expanding anything — the alternative is a red X that says nothing.
    if (row.state === 'error' && typeof r.result === 'string') {
      row.errorSummary = firstLine(r.result);
    }

    // The workspace path behind a file row, so the row can offer to open it. Only
    // file kinds qualify — a search's "target" is a query, not a path — and a
    // placeholder like `(unnamed)` is not a path either.
    const path = fileTarget();
    if (path && FILE_KINDS.has(row.kind)) row.filePath = path;

    // How long the step took, surfaced for every row rather than only for a
    // script run — a slow read of a big file is just as worth seeing.
    const ms = typeof r.ms === 'number' ? r.ms : (typeof meta.ms === 'number' ? meta.ms : null);
    if (!pending && ms != null && Number.isFinite(ms)) row.ms = ms;
    return row;
  }

  /**
   * Rolls a turn's tool runs into the one-line receipt shown under the
   * trajectory — "6 steps · 3 files changed · +142 −38 · 2 commands".
   *
   * This is what makes a long run legible at a glance: the rows say what
   * happened step by step, and this says what it added up to.
   */
  function summarizeRuns(runs) {
    const list = Array.isArray(runs) ? runs : [];
    const files = new Set();
    let added = 0;
    let removed = 0;
    let commands = 0;
    let jobs = 0;
    let failed = 0;

    for (const r of list) {
      if (!r) continue;
      if (r.ok === false) failed++;
      const args = r.args || {};
      const meta = r.meta || {};
      if (r.name === 'run_script' || r.name === 'run_shell') commands++;
      // A started job is not a finished command, so it counts on its own line
      // in the receipt rather than inflating "N commands".
      if (r.name === 'start_job') jobs++;
      if (args.path && (r.name === 'write_file' || r.name === 'edit_file' || r.name === 'delete_file')) {
        files.add(String(args.path));
      }
      if (r.name === 'write_files' && Array.isArray(args.files)) {
        for (const f of args.files) if (f && f.path) files.add(String(f.path));
      }
      if (typeof meta.added === 'number') added += meta.added;
      if (typeof meta.removed === 'number') removed += meta.removed;
    }

    return { steps: list.length, files: files.size, added, removed, commands, jobs, failed };
  }

  /** The task list behind an update_todos call. */
  function describeTodos(args) {
    const items = Array.isArray(args && args.todos) ? args.todos : [];
    const clean = items
      .filter(t => t && typeof t === 'object')
      .map(t => ({ text: String(t.text || ''), status: String(t.status || 'pending') }));
    return {
      total: clean.length,
      done: clean.filter(t => t.status === 'completed').length,
      items: clean
    };
  }

  /**
   * A line diff for an edit.
   *
   * The previous version kept the unchanged head and tail of the WHOLE file as
   * context, so editing one line of a thousand-line file put all thousand lines
   * into the row body. It also reported a multi-hunk edit as one giant
   * remove-block followed by one add-block, which is not what the edit did.
   *
   * This is a real LCS diff, emitted in unified-diff shape: only `CONTEXT` lines
   * around a change survive, and separate changes stay separate hunks. Two
   * distant edits read as two edits, not one rewrite.
   */
  const DIFF_CONTEXT = 3;

  function diffLines(find, replace) {
    const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');
    // A trailing newline terminates the last line; it does not start an empty one.
    const split = (s) => {
      const t = norm(s);
      if (t === '') return [];
      const lines = t.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const a = split(find);
    const b = split(replace);

    // Longest common subsequence over lines. Both inputs are a single edit's
    // find/replace text, so they are small; the O(n·m) table is fine and avoids
    // shipping a diff library into a zero-dependency app.
    const n = a.length;
    const m = b.length;
    const lcs = [];
    for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }

    // Walk the table, collecting an op per line: 'ctx', 'del' or 'add'.
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ type: 'ctx', text: a[i] }); i++; j++; }
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
      else { ops.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < n) { ops.push({ type: 'del', text: a[i] }); i++; }
    while (j < m) { ops.push({ type: 'add', text: b[j] }); j++; }

    // Keep only the changes plus `DIFF_CONTEXT` lines around them.
    const keep = new Array(ops.length).fill(false);
    for (let k = 0; k < ops.length; k++) {
      if (ops[k].type === 'ctx') continue;
      const from = Math.max(0, k - DIFF_CONTEXT);
      const to = Math.min(ops.length - 1, k + DIFF_CONTEXT);
      for (let c = from; c <= to; c++) keep[c] = true;
    }
    const out = [];
    for (let k = 0; k < ops.length; k++) {
      if (!keep[k]) continue;
      // A jump between kept lines is hidden content, and must not read as if the
      // two hunks were adjacent.
      if (out.length && k > 0 && !keep[k - 1]) out.push({ type: 'gap', text: '' });
      out.push(ops[k]);
    }
    return out;
  }

  /**
   * What to render when a row is opened. Deliberately a *kind* rather than the
   * content: app.js builds the body lazily on first expand, so a run that wrote
   * forty files never puts forty file bodies in the DOM.
   */
  function bodyKind(run) {
    const r = run || {};
    if (r.ok === false) return 'error';       // the message is the useful part
    if (r.name === 'edit_file') return 'diff';
    if (r.name === 'write_files') return 'files';
    if (r.name === 'update_todos') return 'todos';
    if (r.name === 'web_search' || r.name === 'list_files' || r.name === 'grep') return 'results';
    if (r.name === 'write_file') return 'preview';
    // `kind` is a property of the described ROW, not of the run, and this is
    // always handed a raw run — testing `r.kind` here never matched anything.
    if (r.name === 'run_script') return 'output';
    return 'text';
  }

  /**
   * Slices without ever cutting a surrogate pair in half — an orphaned half
   * renders as a replacement character.
   */
  function safeSlice(s, start, end) {
    let out = s.slice(start, end);
    if (out && /[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
    if (out && /^[\uDC00-\uDFFF]/.test(out)) out = out.slice(1);
    return out;
  }

  /**
   * Caps a body so one open row cannot lock the page up.
   *
   * Keeps the head AND the tail. Clipping to the head alone threw away exactly
   * the part worth reading: the stack trace, the failing assertion and the final
   * error all live at the end of a tool's output.
   */
  function clipBody(text, cap = 4000) {
    const s = String(text ?? '');
    if (s.length <= cap) return { text: s, truncated: false, hiddenLines: 0 };

    const headLen = Math.ceil(cap * 0.6);
    const tailLen = cap - headLen;
    const head = safeSlice(s, 0, headLen);
    const tail = safeSlice(s, s.length - tailLen, s.length);
    const hidden = s.slice(head.length, s.length - tail.length);
    const hiddenLines = hidden ? hidden.split('\n').length - 1 : 0;
    // Say what was hidden in the unit that is actually meaningful: a body with no
    // line breaks has no lines to count, and "0 more lines" would be a lie.
    const what = hiddenLines > 0
      ? `${hiddenLines} more line${hiddenLines === 1 ? '' : 's'}`
      : `${hidden.length} more character${hidden.length === 1 ? '' : 's'}`;
    return {
      text: `${head}\n… ${what} …\n${tail}`,
      truncated: true,
      hiddenLines,
      hiddenChars: hidden.length
    };
  }

  return {
    describeRun,
    describeTodos,
    diffLines,
    bodyKind,
    clipBody,
    formatMs,
    formatBytes,
    langOf,
    baseName,
    countResults,
    summarizeRuns,
    displayPath,
    relativeTime,
    formatRelative,
    // Exported for the row suite: pure, and the reason a tool the UI has never
    // seen still renders a useful summary.
    pickTarget
  };
});
