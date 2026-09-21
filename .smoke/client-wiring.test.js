// Client wiring checks.
//
// WHY THIS FILE EXISTS
// `applyToolProgress` was added next to `toolCard()` at module scope while
// reading `toolNodesById`, a `const` declared 800 lines below inside the stream
// function. That is the temporal dead zone: the function parses, the page loads,
// and it throws "toolNodesById is not defined" the first time a progress event
// arrives. The throw happens inside the SSE switch, so the handler dies there —
// the turn stays "running" forever, the finished tool row never renders, and the
// user sees "Creating 0 files" for work the server had already completed.
//
// No existing test could catch it: the stream tests drive the server, and the UI
// tests exercise pure functions in agent-rows.js. Neither runs app.js, which is
// the file that broke. This file closes that hole by analysing app.js itself.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const appPath = path.join(ROOT, 'public', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');
const lines = source.split('\n');

/**
 * The 1-based line where the function starting at `fromLine` closes.
 *
 * Brace counting from the signature, so a function that contains nested
 * callbacks and object literals still ends where it really ends — an
 * indentation heuristic mistakes a nested callback's `});` for the outer
 * function's terminator.
 *
 * @param {number} fromLine - 1-based line of the `function` keyword.
 * @returns {number} 1-based line of the closing brace.
 */
function functionBodyEnd(fromLine) {
  let depth = 0;
  let started = false;
  for (let j = fromLine - 1; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') {
        depth--;
        if (started && depth === 0) return j + 1;
      }
    }
  }
  return lines.length;
}

// ---------------------------------------------------------------------------
// 1. Stream-scope helpers must live in the stream scope
//
// The bug: `applyToolProgress` was written next to `toolCard()` at MODULE scope
// while reading `toolNodesById`, a `const` declared 800 lines below inside the
// stream function. `const` is not hoisted, so the function parsed and the page
// loaded, then threw "toolNodesById is not defined" the first time a progress
// event arrived. The throw was inside the SSE switch, so the handler died there:
// the turn stayed "running", the completed tool row never rendered, and the user
// saw "Creating 0 files" for a write the server had already finished.
//
// The guard is deliberately specific rather than a general scope analysis. A
// general version was attempted and abandoned: app.js is one large IIFE whose
// functions close over hundreds of locals, and any indent-based scope heuristic
// flagged hundreds of legitimate closures. A check that cries wolf gets
// ignored, which is worse than no check. What follows is narrow, exact, and
// covers the failure that actually happened, plus the one shape a future edit
// would repeat it in.
// ---------------------------------------------------------------------------
{
  const declLine = lines.findIndex((l) => /const toolNodesById = new Map/.test(l)) + 1;
  const progressLine = lines.findIndex((l) => /function applyToolProgress/.test(l)) + 1;
  const elapsedLine = lines.findIndex((l) => /function setElapsed/.test(l)) + 1;
  const indentOf = (n) => (n > 0 ? lines[n - 1].length - lines[n - 1].trimStart().length : -1);

  check('toolNodesById is declared before both helpers that read it',
    declLine > 0 && declLine < progressLine && declLine < elapsedLine,
    `map ${declLine}, progress ${progressLine}, elapsed ${elapsedLine}`);
  check('both helpers sit at the map\'s own indent, so they share its scope',
    indentOf(progressLine) === indentOf(declLine) && indentOf(elapsedLine) === indentOf(declLine),
    `map indent ${indentOf(declLine)}, progress ${indentOf(progressLine)}, elapsed ${indentOf(elapsedLine)}`);

  // The exact shape of the original mistake: a second copy of either helper left
  // at module scope, where `toolNodesById` is not in scope at all.
  const moduleScopeCopies = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}function\s+(applyToolProgress|setElapsed)\s*\(/.exec(lines[i]);
    if (m) moduleScopeCopies.push(`${m[1]}() at line ${i + 1}`);
  }
  check('no module-scope copy of a stream-scope helper exists',
    moduleScopeCopies.length === 0,
    moduleScopeCopies.length ? moduleScopeCopies.join(', ') : 'one definition each, both in scope');

  check('each helper is defined exactly once', (() => {
    const count = (name) => lines.filter((l) => new RegExp('^\\s*function\\s+' + name + '\\s*\\(').test(l)).length;
    return count('applyToolProgress') === 1 && count('setElapsed') === 1;
  })(), `applyToolProgress ×${lines.filter((l) => /^\s*function applyToolProgress\s*\(/.test(l)).length}, setElapsed ×${lines.filter((l) => /^\s*function setElapsed\s*\(/.test(l)).length}`);

  // The reference parser the other checks lean on must itself be right, so it is
  // verified against a function whose extent is known by construction:
  // renderAttachRow opens at 1521 and closes at 1538.
  const probeStart = lines.findIndex((l) => /^ {2}function renderAttachRow\s*\(/.test(l)) + 1;
  const probeEnd = functionBodyEnd(probeStart);
  check('the brace-counting parser finds a known function body exactly',
    probeEnd > probeStart && /^\s{2}\}\s*$/.test(lines[probeEnd - 1]),
    `renderAttachRow ${probeStart}–${probeEnd}`);

  // The invariant is about SCOPE, so it is checked by scope and not by line
  // number. This check used to compare against a hard-coded line where handleSSE
  // happened to sit; every edit above it moved the target, and the assertion
  // then failed (or passed) for reasons that had nothing to do with the bug it
  // exists to catch. Both the declaration and handleSSE must resolve to the same
  // ENCLOSING function — the streaming turn's own scope.
  const enclosingFunction = (fromLine) => {
    for (let i = fromLine - 1; i >= 1; i--) {
      const m = /^ {2}(?:async\s+)?function\s+(\w+)\s*\(/.exec(lines[i - 1]);
      if (m) return { name: m[1], line: i };
    }
    return null;
  };
  const handleSseLine = lines.findIndex((l) => /^\s{4}function handleSSE\s*\(/.test(l)) + 1;
  const declOwner = enclosingFunction(declLine);
  const handlerOwner = enclosingFunction(handleSseLine);
  check('the stream locals are declared inside the same function as handleSSE',
    Boolean(declOwner && handlerOwner) && declOwner.line === handlerOwner.line,
    `toolNodesById in ${declOwner ? declOwner.name + '():' + declOwner.line : '?'}, handleSSE in ${handlerOwner ? handlerOwner.name + '():' + handlerOwner.line : '?'}`);
  check('that function is the streaming turn itself, not the module scope',
    Boolean(declOwner) && declOwner.name === 'sendMessage', declOwner ? declOwner.name + '()' : 'not found');
}

// ---------------------------------------------------------------------------
// 2. The SSE switch handles every event the server emits
//
// An unhandled event name is silent: the switch falls through and nothing
// happens. That reads as a feature that "just does not work".
// ---------------------------------------------------------------------------
{
  const handled = new Set();
  for (const line of lines) {
    const m = /^\s*case '([a-z_]+)':/.exec(line);
    if (m) handled.add(m[1]);
  }

  // The server's emitters: every emit('name') / send('name') in the loop, the
  // route and the providers.
  const serverFiles = [
    path.join(ROOT, 'src', 'middleware', 'loop.js'),
    path.join(ROOT, 'src', 'agent.js'),
    path.join(ROOT, 'src', 'routes', 'chat.js'),
    path.join(ROOT, 'src', 'crew.js')
  ];
  const emitted = new Set();
  for (const file of serverFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/\b(?:emit|send)\(\s*'([a-z_]+)'/g)) emitted.add(m[1]);
    // The loop's token channel is configurable (`tokenEvent`), so its name is
    // read from the call site rather than the source.
  }
  const known = [...emitted].filter((name) => name !== 'thinking');
  const unhandled = known.filter((name) => !handled.has(name));
  check('every event the server emits has a case in the client switch',
    unhandled.length === 0,
    unhandled.length ? 'unhandled: ' + unhandled.join(', ') : handled.size + ' cases, ' + known.length + ' emitted names');
  check('the client handles tool_progress', handled.has('tool_progress'));
  check('the client handles the terminal message_end', handled.has('message_end'));

  // The switch needs a default, or an unknown event from a newer server is a
  // silent no-op with no way to notice.
  check('the SSE switch has a default branch', /^\s*default:/m.test(source));
}

// ---------------------------------------------------------------------------
// 3. The stale-backend guard
//
// The badge is what makes an unreloaded server visible. If its wiring is
// dropped, the failure mode is silent again: a fix that "did not work".
// ---------------------------------------------------------------------------
{
  check('the stale badge is created by the client', /function setStaleBadge/.test(source));
  check('a stale server is rechecked on a timer', /function startStaleWatch/.test(source));
  check('the recheck uses the dedicated health endpoint', /fetch\('\/api\/health'/.test(source));
  check('the badge is removed once the server is current',
    /if \(!stale\) \{ if \(existing\) existing\.remove\(\); return; \}/.test(source));
  check('bootstrap applies the stale flag to the badge', /setStaleBadge\(Boolean\(data\.staleCode\)\)/.test(source));

  const serverCode = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('the server exposes /api/health', /p === '\/api\/health'/.test(serverCode));
  check('/api/health reports staleCode', /staleCode: stale/.test(serverCode));
  check('the boot banner prints a code version', /code version \$\{VERSION\}/.test(serverCode));
  check('the version is derived from the newest source mtime', /const VERSION = new Date\(BOOT_CODE_MTIME\)/.test(serverCode));
}

// ---------------------------------------------------------------------------
// 4. The turn receipt is chips, and it updates live
//
// It used to be one sentence joined by dots — `12 steps · 5 files changed ·
// +142 −38 · 3 commands` — inside a bordered card. The numbers worth scanning
// were buried in connectors and the card competed with the tool rows above it.
// Each fact is now its own chip, and an elapsed time ticks while the turn runs
// so a long step still looks alive.
// ---------------------------------------------------------------------------
{
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
  const summaryLine = lines.findIndex((l) => /function turnSummaryEl\s*\(/.test(l)) + 1;
  const summaryEnd = summaryLine ? functionBodyEnd(summaryLine) : 0;
  const summary = summaryLine ? lines.slice(summaryLine - 1, summaryEnd).join('\n') : '';

  check('the receipt builder was located', summary.length > 0, `turnSummaryEl at ${summaryLine}`);
  check('the receipt renders chips, not one dot-joined sentence',
    /ts-chip/.test(summary) && !/bits\.join\(/.test(summary));
  check('the diff is its own coloured pair', /ts-add/.test(summary) && /ts-del/.test(summary));
  check('a failure is its own chip', /ts-fail/.test(summary));
  check('the receipt carries an elapsed-time slot', /ts-elapsed/.test(summary));
  check('the elapsed slot is styled', /\.ts-elapsed\s*\{/.test(css));
  check('the receipt is a caption, not a bordered card', /\.turn-summary\s*\{[^}]*border:\s*0/.test(css));

  // Live updates: the composer clock drives the receipt, so the two can never
  // disagree and there is one interval to clear rather than two.
  check('the stream clock publishes ticks to listeners',
    /function onStreamTick/.test(source) && /function emitStreamTick/.test(source));
  check('the receipt elapsed time rides the stream clock', /onStreamTick\(applySummaryElapsed\)/.test(source));
  check('the clock clears the live state when the turn ends', /emitStreamTick\(null\)/.test(source));
  check('refresh replaces chips in place so the timer survives a step',
    /chips\.innerHTML = nextChips\.innerHTML/.test(source));
  check('a saved turn shows its own duration, pinned',
    /ms: m\.ms/.test(source) && /classList\.add\('on', 'final'\)/.test(source));
}

// ---------------------------------------------------------------------------
// 5. Every tool the server offers has a UI row
//
// A tool with no case still renders (the fallback names its arguments), but it
// renders badly — which is how a brand-new tool ends up looking broken.
// ---------------------------------------------------------------------------
{
  const rows = fs.readFileSync(path.join(ROOT, 'public', 'agent-rows.js'), 'utf8');
  const tools = require(path.join(ROOT, 'src', 'tools.js'));
  const names = tools.defsFor({ web: true, files: true, code: true }).map((t) => t.name);
  const missing = names.filter((name) => !new RegExp("case '" + name + "':").test(rows));
  check('every registered tool has a hand-written row in agent-rows.js',
    missing.length === 0,
    missing.length ? 'no case for: ' + missing.join(', ') : names.length + ' tools covered');

  // And a running row must be able to show elapsed time, which is the element
  // the tool_progress handler writes into.
  check('the tool row carries an elapsed-time slot', /tr-elapsed/.test(source));
  check('the elapsed slot is styled', /\.tr-elapsed/.test(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')));
}

// ---------------------------------------------------------------------------
// 5. Bugs found by audit, pinned so they cannot come back
//
// Each of these was a real, user-visible defect: three controls that could not
// be reached, a sidebar that wedged, a Send button that did nothing, a preview
// that rendered blank, a Refresh that was dead on one tab.
// ---------------------------------------------------------------------------
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  // The three composer tool groups once shipped with `hidden` and nothing
  // removed it, so Web search / File tools / App engine never rendered at all.
  // They are now deliberately gone from the composer: three always-on switches
  // standing between the user and Send were clutter, and the decision belongs
  // where it is actually made — per provider, in Settings. What must never come
  // back is the original bug: a control that is present but unreachable. So this
  // pins the removal, and pins that the client survives their absence.
  const hiddenChips = (html.match(/class="chip tool-chip hidden"/g) || []).length;
  check('no tool toggle is shipped in a hidden-but-present state', hiddenChips === 0,
    hiddenChips ? hiddenChips + ' still hidden' : 'none');
  check('the composer no longer carries per-conversation tool toggles',
    !/id="toolWeb"|id="toolFiles"|id="toolCode"/.test(html));
  check('the client tolerates their absence instead of throwing on a null',
    /#toolWeb'\)\?\.addEventListener/.test(source)
    && /#toolFiles'\)\?\.addEventListener/.test(source)
    && /#toolCode'\)\?\.addEventListener/.test(source));
  check('the composer names the provider and the model, including on a phone',
    /id="composerProvBtn"/.test(html) && /class="model-select-wrap mobile-only"/.test(html)
    && /id="composerModelName"/.test(html)
    && /\.composer-row \.model-chip \.model-chip-name/.test(fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8')));

  // Enter that commits an IME composition must not send.
  check('Enter during IME composition does not send', /e\.isComposing \|\| e\.keyCode === 229/.test(source));

  // Deleting the chat that held the active tag filter must clear the filter.
  check('deleting a chat clears a tag filter it had emptied',
    /state\.activeTagFilter &&[\s\S]{0,120}!Object\.values\(state\.chatTags\)\.some/.test(source));

  // An attachment with no text is a complete request.
  check('a message with only an attachment is allowed to send',
    /const pending = \(state\.attachments \|\| \[\]\)\.length;/.test(source) && /if \(!text && !pending\) return;/.test(source));

  // React projects ship index.html too; the bundle must win.
  check('the preview prefers a React entry point over a raw index.html',
    /if \(reactFile\) \{[\s\S]{0,200}else if \(htmlFile\) \{/.test(source));

  // Refresh has to answer on every tab.
  check('Refresh handles the markdown tab', /activeSandboxTab === 'markdown'\) setupMarkdownView/.test(source));

  // A disabled provider cannot be the default: the app requires `enabled`.
  check('the default-provider list only offers enabled providers',
    /sDefaultProvider[\s\S]{0,600}\.filter\(p => p\.enabled\)/.test(source));

  // Server-side confinement of every chat-scoped file route.
  const serverCode2 = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('the raw file route requires a valid chatId',
    /\/api\/files\/raw'[\s\S]{0,800}store\.isValidChatId\(chatId\)/.test(serverCode2));
  check('the zip route requires a valid chatId',
    /\/api\/files\/zip'[\s\S]{0,800}store\.isValidChatId\(chatId\)/.test(serverCode2));
  check('a file run requires a valid chatId',
    /filePath && !store\.isValidChatId\(chatId\)/.test(serverCode2));
  check('an invalid chatId is refused instead of widening to the shared root',
    /isValidChatId\(chatId\)\) \{\s*throw new Error\('Invalid chatId/.test(fs.readFileSync(path.join(ROOT, 'src', 'tools.js'), 'utf8')));
  check('base URLs are validated before they are stored',
    /function validateBaseUrl/.test(serverCode2) && (serverCode2.match(/validateBaseUrl\(/g) || []).length >= 3);
  check('the preview iframe is not granted same-origin',
    !/sandbox="[^"]*allow-same-origin/.test(html));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
