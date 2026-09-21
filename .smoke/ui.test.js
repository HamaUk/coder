// The rule the user asked for, asserted directly:
//
//   "should not show codes when createing codes like should show file name
//    createing in progress same as claude agent how it work the ui"
//
// So the load-bearing check here is not "does the row look right" but "can a
// tool row ever print the contents of the file it just wrote". Every tool that
// carries a body is driven with a sentinel in every content-bearing argument,
// and the described row is searched for it. The old renderer failed this: it
// printed JSON.stringify(run.args), which for write_file is the whole file.
const path = require('path');

const rows = require(path.join(__dirname, '..', 'public', 'agent-rows'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// 1. No row may ever carry file content
// ---------------------------------------------------------------------------
{
  const SENTINEL = 'CONTENT_THAT_MUST_NEVER_BE_RENDERED';

  const cases = [
    { name: 'write_file', args: { path: 'src/App.tsx', content: SENTINEL } },
    { name: 'write_files', args: { files: [{ path: 'a.ts', content: SENTINEL }, { path: 'b.ts', content: SENTINEL }] } },
    { name: 'edit_file', args: { path: 'src/App.tsx', find: SENTINEL, replace: SENTINEL } },
    { name: 'read_file', args: { path: 'src/App.tsx' }, result: SENTINEL },
    { name: 'list_files', args: {}, result: SENTINEL },
    { name: 'run_script', args: { path: 'x.py', args: [SENTINEL] }, result: SENTINEL },
    { name: 'web_search', args: { query: 'ok' }, result: SENTINEL },
    { name: 'fetch_url', args: { url: 'https://example.com' }, result: SENTINEL },
    { name: 'llamacoder_generate', args: { prompt: 'ok', save_path: 'a.html' }, result: SENTINEL },
    { name: 'update_todos', args: { todos: [{ text: SENTINEL, status: 'pending' }] } },
    // The shell and job rows print the COMMAND (that is the point of the row),
    // but never a job's output or a file body, so the sentinel goes everywhere
    // except `command`.
    { name: 'run_shell', args: { command: 'npm run build' }, result: SENTINEL },
    { name: 'run_shell', args: { command: 'npm run build' }, ok: false, result: SENTINEL },
    { name: 'start_job', args: { command: 'npm run dev', description: 'Start the dev server' }, result: SENTINEL },
    { name: 'job_output', args: { id: 'job_abc123' }, result: SENTINEL },
    { name: 'job_kill', args: { id: 'job_abc123', reason: 'done' }, result: SENTINEL },
    { name: 'job_list', args: {}, result: SENTINEL },
    { name: 'some_future_tool', args: { path: 'a.ts', payload: SENTINEL, content: SENTINEL } }
  ];

  for (const c of cases) {
    for (const pending of [true, false]) {
      const row = rows.describeRun({ ...c, pending, ok: true });
      const rendered = JSON.stringify(row);
      check(`no content leaks from ${c.name}${pending ? ' (running)' : ' (done)'}`,
        !rendered.includes(SENTINEL),
        rendered.slice(0, 90));
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The row says what happened, in the right tense
// ---------------------------------------------------------------------------
{
  const created = rows.describeRun({
    name: 'write_file', args: { path: 'src/App.tsx' },
    meta: { created: true, lines: 142, bytes: 4774 }, ok: true
  });
  check('a new file reads "Created"', created.label === 'Created', created.label);
  check('the row names the file', created.target === 'src/App.tsx', created.target);
  check('the row carries the language and size',
    created.chips.includes('tsx') && created.chips.includes('142 lines'),
    created.chips.join(', '));

  const updated = rows.describeRun({
    name: 'write_file', args: { path: 'src/App.tsx' },
    meta: { created: false, lines: 150, bytes: 5000 }, ok: true
  });
  check('an overwritten file reads "Updated", not "Created"',
    updated.label === 'Updated', updated.label);

  const running = rows.describeRun({ name: 'write_file', args: { path: 'src/App.tsx' }, pending: true });
  check('a running write reads "Writing" (existence is not known yet)',
    running.label === 'Writing', running.label);

  const legacy = rows.describeRun({ name: 'write_file', args: { path: 'src/App.tsx' }, ok: true });
  check('a run with no meta degrades to "Wrote" instead of throwing',
    legacy.label === 'Wrote', legacy.label);

  const edited = rows.describeRun({
    name: 'edit_file', args: { path: 'src/App.tsx' },
    meta: { added: 12, removed: 4, replacements: 1 }, ok: true
  });
  check('an edit reads "Edited" with its ± counts',
    edited.label === 'Edited' && edited.chips.includes('+12 −4'),
    edited.label + ' ' + edited.chips.join(', '));

  const ran = rows.describeRun({
    name: 'run_script', args: { path: 'scrape.py' },
    meta: { exitCode: 0, ms: 1234 }, ok: true
  });
  check('a script run shows its exit code and duration',
    ran.label === 'Ran' && ran.chips.includes('exit 0') && ran.chips.includes('1.2s'),
    ran.chips.join(', '));

  const ranBad = rows.describeRun({
    name: 'run_script', args: { path: 'scrape.py' }, meta: { exitCode: 1, ms: 90 }, ok: true
  });
  check('a non-zero exit is shown as exit 1', ranBad.chips.includes('exit 1'), ranBad.chips.join(', '));
}

// ---------------------------------------------------------------------------
// 3. Search / task rows
// ---------------------------------------------------------------------------
{
  const search = rows.describeRun({
    name: 'web_search', args: { query: 'recharts area chart' }, ok: true,
    result: 'Web results for "recharts area chart":\n\n1. A\n   https://a\n   snip\n2. B\n   https://b\n3. C\n   https://c'
  });
  check('a search row shows the query', search.target === 'recharts area chart', search.target);
  check('a search row counts its results', search.chips.includes('3 results'), search.chips.join(', '));

  const grep = rows.describeRun({
    name: 'grep', args: { pattern: 'useState', path: '' }, ok: true,
    result: 'src/App.tsx:1: import React, { useState } from "react";', meta: { matches: 1, files: 1 }
  });
  check('a grep row shows the pattern', grep.target === 'useState', grep.target);
  check('a grep row counts its matches', grep.chips.includes('1 match') && grep.chips.includes('1 file'), grep.chips.join(', '));
  check('a grep row opens its matches', rows.bodyKind({ name: 'grep', ok: true }) === 'results');

  const todos = rows.describeTodos({
    todos: [
      { text: 'scaffold', status: 'completed' },
      { text: 'chart', status: 'in_progress' },
      { text: 'form', status: 'pending' }
    ]
  });
  check('the task list reports done/total', todos.total === 3 && todos.done === 1, `${todos.done}/${todos.total}`);

  const todoRow = rows.describeRun({
    name: 'update_todos',
    args: { todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }] },
    ok: true
  });
  check('a task row summarises progress', todoRow.target === '1/2 done', todoRow.target);
}

// ---------------------------------------------------------------------------
// 4. Diffs and bodies
// ---------------------------------------------------------------------------
{
  const d = rows.diffLines('a\nb\nc\nd', 'a\nX\nc\nd');
  check('the diff keeps the unchanged head as context',
    d[0].type === 'ctx' && d[0].text === 'a', JSON.stringify(d.map(x => x.type + ':' + x.text)));
  check('the diff marks the removed line', d.some(x => x.type === 'del' && x.text === 'b'));
  check('the diff marks the added line', d.some(x => x.type === 'add' && x.text === 'X'));
  check('the unchanged tail is context, not a removal',
    d.filter(x => x.type === 'del').length === 1 && d.filter(x => x.type === 'add').length === 1,
    JSON.stringify(d.map(x => x.type)));

  const crlf = rows.diffLines('a\r\nb\r\n', 'a\r\nc\r\n');
  check('a CRLF edit does not report every line as changed',
    crlf.filter(x => x.type === 'del').length === 1 && crlf.filter(x => x.type === 'add').length === 1,
    JSON.stringify(crlf.map(x => x.type + ':' + x.text)));

  check('a failed run opens its error, not a preview',
    rows.bodyKind({ name: 'write_file', ok: false }) === 'error');
  check('a completed edit opens a diff',
    rows.bodyKind({ name: 'edit_file', ok: true }) === 'diff');
  check('a multi-file write opens the file list, not the files',
    rows.bodyKind({ name: 'write_files', ok: true }) === 'files');

  // Clipping keeps the head AND the tail: the stack trace, the failing
  // assertion and the final error all live at the end of a tool's output.
  const manyLines = Array.from({ length: 900 }, (_, i) => 'line ' + i).join('\n');
  const big = rows.clipBody('HEAD\n' + manyLines + '\nTAIL', 4000);
  // The cap bounds the CONTENT; the gap marker is a little extra on top.
  check('a large body is clipped to its cap',
    big.truncated === true && big.text.length <= 4000 + 40, String(big.text.length));
  check('a clipped body is far smaller than the original',
    big.text.length < manyLines.length, `${big.text.length} vs ${manyLines.length}`);
  check('a clipped body keeps its head', big.text.startsWith('HEAD'), JSON.stringify(big.text.slice(0, 20)));
  check('a clipped body keeps its tail', big.text.endsWith('TAIL'), JSON.stringify(big.text.slice(-20)));
  check('a clipped body counts the hidden lines', big.hiddenLines > 0, String(big.hiddenLines));
  check('a clipped body marks the gap', /more lines/.test(big.text), big.text.split('\n… ')[1] || '');

  // A body with no line breaks has no lines to count — the notice must switch
  // unit rather than claim "0 more lines".
  const oneLine = rows.clipBody('x'.repeat(9000), 4000);
  check('a line-less clip counts characters', oneLine.hiddenLines === 0 && oneLine.hiddenChars > 0,
    `${oneLine.hiddenLines} lines / ${oneLine.hiddenChars} chars`);
  check('a line-less clip says characters', /more characters/.test(oneLine.text));

  const small = rows.clipBody('hello', 4000);
  check('a small body is left alone',
    small.text === 'hello' && small.truncated === false && small.hiddenLines === 0);

  // No half a surrogate pair at a cut.
  const emoji = rows.clipBody('🙂'.repeat(50), 21);
  check('a clipped body never splits a surrogate pair',
    !/[\uD800-\uDBFF]\n…/.test(emoji.text) && !/\n… [^…]*[\uDC00-\uDFFF]/.test(emoji.text),
    JSON.stringify(emoji.text.slice(0, 14)));
}

// ---------------------------------------------------------------------------
// 5. Durations
// ---------------------------------------------------------------------------
{
  check('sub-second durations read in ms', rows.formatMs(340) === '340ms', rows.formatMs(340));
  check('seconds read in seconds', rows.formatMs(1234) === '1.2s', rows.formatMs(1234));
  check('long durations read in minutes', rows.formatMs(134000) === '2m 14s', rows.formatMs(134000));
  check('a missing duration renders empty, not NaN', rows.formatMs(null) === '', JSON.stringify(rows.formatMs(null)));
}

// ---------------------------------------------------------------------------
// 6. The trajectory: structured stats + the turn's receipt
// ---------------------------------------------------------------------------
{
  // The old row carried `+12 −4` as one flat string. The row now renders the
  // stats as their own coloured pair, which needs them as numbers.
  const edited = rows.describeRun({
    name: 'edit_file', ok: true, args: { path: 'src/middleware/loop.js' },
    meta: { added: 47, removed: 23, replacements: 1 }, ms: 900
  });
  check('an edit exposes its stats as numbers',
    edited.diff && edited.diff.added === 47 && edited.diff.removed === 23,
    JSON.stringify(edited.diff));
  check('the stats are still available as the flat chip too',
    edited.chips.includes('+47 −23'), edited.chips.join(', '));

  check('a step carries its duration', edited.ms === 900, String(edited.ms));
  const read = rows.describeRun({ name: 'read_file', ok: true, args: { path: 'a.ts' }, result: 'x', ms: 12 });
  check('a read row carries its duration too', read.ms === 12, String(read.ms));
  const ran = rows.describeRun({ name: 'run_script', ok: true, args: { path: 'x.py' }, result: '', meta: { exitCode: 0, ms: 1200 } });
  check('a run row does not show its duration twice', ran.timeShown === true, String(ran.timeShown));

  // The receipt under the trajectory.
  const runs = [
    { name: 'read_file', ok: true, args: { path: 'src/App.tsx' } },
    { name: 'edit_file', ok: true, args: { path: 'src/App.tsx' }, meta: { added: 47, removed: 23 } },
    { name: 'edit_file', ok: true, args: { path: 'src/middleware/loop.js' }, meta: { added: 9, removed: 6 } },
    { name: 'write_file', ok: true, args: { path: 'new.txt' }, meta: {} },
    { name: 'run_script', ok: true, args: { path: 'check.js' }, meta: { exitCode: 0, ms: 300 } },
    { name: 'run_script', ok: false, args: { path: 'bad.js' }, meta: { exitCode: 1, ms: 90 } }
  ];
  const s = rows.summarizeRuns(runs);
  check('the receipt counts the steps', s.steps === 6, String(s.steps));
  check('the receipt counts distinct files, not operations',
    s.files === 3, String(s.files));
  check('the receipt sums the diff stats', s.added === 56 && s.removed === 29, `${s.added}/${s.removed}`);
  check('the receipt counts commands', s.commands === 2, String(s.commands));
  check('the receipt counts failures', s.failed === 1, String(s.failed));
  check('an empty turn has no receipt', rows.summarizeRuns([]).steps === 0);
  check('a missing run list does not throw', rows.summarizeRuns(null).steps === 0);
  check('runs without args are tolerated',
    rows.summarizeRuns([{ name: 'update_todos', ok: true }]).files === 0);
}

// ---------------------------------------------------------------------------
// 7. Row state, inline failures and argument-name tolerance
//    (ported from the harness's ToolRow model)
// ---------------------------------------------------------------------------
{
  const rowsOf = (run) => rows.describeRun(run);

  check('a pending run is running', rowsOf({ name: 'read_file', args: {}, pending: true }).state === 'running');
  check('a completed run is ok', rowsOf({ name: 'read_file', ok: true, args: {} }).state === 'ok');
  check('a failed run is an error',
    rowsOf({ name: 'write_file', ok: false, args: { path: 'a' }, result: 'boom' }).state === 'error');
  // A timeout is not the same as broken code, and must not be coloured as one.
  check('a timed-out run is stopped, not failed',
    rowsOf({ name: 'run_script', ok: false, args: { path: 'x.py' }, meta: { timedOut: true }, result: 'timed out' }).state === 'stopped');
  check('an interrupted run is stopped',
    rowsOf({ name: 'write_file', ok: false, args: { path: 'a' }, meta: { interrupted: true } }).state === 'stopped');

  // A failure replaces the row's summary so it reads without expanding.
  const failed = rowsOf({
    name: 'write_file', ok: false, args: { path: 'notes.txt' },
    result: '\n  Error: EPERM: operation not permitted\nmore detail here'
  });
  check('a failure surfaces its first line on the collapsed row',
    failed.errorSummary === 'Error: EPERM: operation not permitted', JSON.stringify(failed.errorSummary));
  check('a success carries no error summary',
    rowsOf({ name: 'write_file', ok: true, args: { path: 'a' }, result: 'ok' }).errorSummary === undefined);

  check('a leading ./ is dropped from a displayed path', rows.displayPath('./src/App.tsx') === 'src/App.tsx');
  check('a Windows path keeps its backslashes', rows.displayPath('src\\App.tsx') === 'src\\App.tsx');

  // The argument-name tolerance that lets a tool the UI has never seen render.
  check('a file_path argument is understood',
    rowsOf({ name: 'read_file', ok: true, args: { file_path: 'src/x.ts' } }).target === 'src/x.ts');
  check('a filename argument is understood',
    rowsOf({ name: 'write_file', ok: true, args: { filename: 'a/b.txt' } }).target === 'a/b.txt');
  check('a script argument is understood',
    rowsOf({ name: 'run_script', ok: true, args: { script: 'tool.py' } }).target === 'tool.py');
  check('an unknown tool names what it acted on',
    rowsOf({ name: 'brand_new_tool', ok: true, args: { file_path: 'src/deep/new.ts' } }).target === 'src/deep/new.ts');
  check('an unknown tool falls back to key names only when shapeless',
    rowsOf({ name: 'brand_new_tool', ok: true, args: { alpha: 1, beta: 2 } }).target === '(alpha, beta)');
  check('key preference is ordered, not first-wins',
    rows.pickTarget('search', { url: 'https://x', query: 'needle' }) === 'needle');

  // Only a real path is offered as openable.
  check('a real file row exposes an openable path',
    rowsOf({ name: 'edit_file', ok: true, args: { path: './src/App.tsx' }, meta: { added: 1, removed: 0 } }).filePath === 'src/App.tsx');
  check('a placeholder is not offered as an openable path',
    rowsOf({ name: 'read_file', ok: true, args: {}, result: 'x' }).filePath === undefined);
  check('a non-file row exposes no path',
    rowsOf({ name: 'web_search', ok: true, args: { query: 'x' }, result: '1. a' }).filePath === undefined);
}

// ---------------------------------------------------------------------------
// 8. Relative time (the chat list's trailing age)
// ---------------------------------------------------------------------------
{
  const NOW = 1_800_000_000_000;
  const ago = (ms) => rows.formatRelative(NOW - ms, NOW);
  const MIN = 60000;

  check('a fresh row reads "just now"', ago(0) === 'just now', ago(0));
  check('seconds still read "just now"', ago(59_000) === 'just now', ago(59_000));
  check('minutes read in minutes', ago(5 * MIN) === '5m ago', ago(5 * MIN));
  check('hours read in hours', ago(3 * 60 * MIN) === '3h ago', ago(3 * 60 * MIN));
  check('one day reads as yesterday', ago(25 * 60 * MIN) === 'yesterday', ago(25 * 60 * MIN));
  check('several days read in days', ago(4 * 24 * 60 * MIN) === '4d ago', ago(4 * 24 * 60 * MIN));
  check('months read in months', ago(70 * 24 * 60 * MIN) === '2mo ago', ago(70 * 24 * 60 * MIN));
  check('years read in years', ago(800 * 24 * 60 * MIN) === '2y ago', ago(800 * 24 * 60 * MIN));

  // A clock skew must not produce "-3m ago".
  check('a future timestamp degrades to "just now"',
    rows.formatRelative(NOW + 10 * MIN, NOW) === 'just now', rows.formatRelative(NOW + 10 * MIN, NOW));
  check('a missing timestamp does not throw',
    typeof rows.formatRelative(undefined, NOW) === 'string');
  check('the bucket is exposed separately from the wording',
    rows.relativeTime(NOW - 90 * MIN, NOW).unit === 'hours' &&
    rows.relativeTime(NOW - 90 * MIN, NOW).n === 1);
}

// ---------------------------------------------------------------------------
// 9. A failed step must not be labelled as if it succeeded
// ---------------------------------------------------------------------------
{
  // The transcript that prompted this read "Created · Error: "files" array is
  // required… · failed" — the past tense claims the write happened, in the same
  // row that says it did not.
  const failedWrite = rows.describeRun({
    name: 'write_files', ok: false, args: {},
    result: 'Error: "files" array is required and must not be empty'
  });
  check('a failed multi-file write is not labelled "Created"',
    failedWrite.label === 'Failed to create', failedWrite.label);

  check('a failed single write is not labelled "Wrote"',
    rows.describeRun({ name: 'write_file', ok: false, args: { path: 'a' }, result: 'Error: EPERM' }).label === 'Failed to write');
  check('a failed edit is not labelled "Edited"',
    rows.describeRun({ name: 'edit_file', ok: false, args: { path: 'a' }, result: 'Error: nope' }).label === 'Failed to edit');
  check('a failed read is not labelled "Read"',
    rows.describeRun({ name: 'read_file', ok: false, args: { path: 'a' }, result: 'Error: nope' }).label === 'Failed to read');

  // The label still has to read correctly when the step succeeded.
  check('a successful write is still labelled "Created"',
    rows.describeRun({ name: 'write_file', ok: true, args: { path: 'a' }, meta: { created: true } }).label === 'Created');
  check('a successful edit is still labelled "Edited"',
    rows.describeRun({ name: 'edit_file', ok: true, args: { path: 'a' }, meta: { added: 1, removed: 0 } }).label === 'Edited');
  // A run cut short is "stopped", not failed, and keeps its attempt wording.
  check('a timed-out run is labelled as a failure to run',
    rows.describeRun({ name: 'run_script', ok: false, args: { path: 'x.py' }, meta: { timedOut: true } }).label === 'Failed to run');
  // An unknown tool keeps its own name rather than gaining a wrong verb.
  check('an unknown tool keeps its own name on failure',
    rows.describeRun({ name: 'brand_new', ok: false, args: {}, result: 'boom' }).label === 'brand_new');
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
