// Hardening regression tests.
//
// These pin the guards that protect the user's own machine and their stored
// data: the fetch_url SSRF check, the workspace sandbox, the edit_file string
// handling, the auto-save skip set, the corrupt-store behaviour and the
// context-window bound. Each case is a bug that was actually present.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Point the store at a scratch directory BEFORE anything requires it, so these
// tests never touch the real data/ or workspace/ trees.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-hardening-'));
process.env.HAMA_DATA_DIR = path.join(SCRATCH, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(SCRATCH, 'workspace');

const tools = require(path.join(ROOT, 'src', 'tools'));
const { boundHistory, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS } = require(path.join(ROOT, 'src', 'routes', 'chat'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// 1. The private-address guard behind fetch_url
// ---------------------------------------------------------------------------
{
  const priv = tools.ipIsPrivate;
  const cases = [
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.16.0.1', true], ['192.168.1.1', true],
    ['169.254.169.254', true], ['0.0.0.0', true], ['::1', true],
    ['::ffff:127.0.0.1', true], ['::ffff:7f00:1', true], ['::ffff:a9fe:a9fe', true],
    ['fc00::1', true], ['fe80::1', true], ['fec0::1', true],
    ['999.1.1.1', true],                       // unparseable must fail CLOSED
    ['8.8.8.8', false], ['1.1.1.1', false], ['2606:4700::1111', false]
  ];
  for (const [ip, want] of cases) {
    check(`ipIsPrivate(${ip}) === ${want}`, priv(ip) === want, String(priv(ip)));
  }

  const host = tools.isPrivateHost;
  check('localhost is private', host('localhost') === true);
  check('localhost. (trailing dot) is private', host('localhost.') === true);
  check('a trailing dot does not defeat the .local suffix check', host('printer.local.') === true);
  check('example.com is public', host('example.com') === false);

  // The DNS half is what catches a public name that resolves to loopback.
  (async () => {
    const rejected = async (url) => {
      try { await tools.assertPublicUrl(url); return false; } catch { return true; }
    };
    check('assertPublicUrl rejects loopback', await rejected('http://127.0.0.1:3080/'));
    check('assertPublicUrl rejects IPv4-mapped loopback', await rejected('http://[::ffff:127.0.0.1]/'));
    check('assertPublicUrl rejects a dotted localhost', await rejected('http://localhost.:3080/'));
    check('assertPublicUrl rejects a non-http scheme', await rejected('file:///etc/passwd'));

    // The DNS half needs a resolver; skip it rather than fail on an offline box.
    let dnsWorks = true;
    try { await tools.assertPublicUrl('https://example.com/'); } catch { dnsWorks = false; }
    if (dnsWorks) {
      check('assertPublicUrl allows a public host', true);
      check('assertPublicUrl rejects a public name that resolves to loopback',
        await rejected('http://localtest.me/'));
    } else {
      console.log('SKIP  DNS-dependent SSRF assertions (no resolver available)');
    }
    // The text-protocol engines have no schema validation, so `files` arrives in
    // whatever shape the model felt like. Rejecting a clear request cost the whole
    // call — the transcript showed a multi-file write failing with
    // `Error: "files" array is required and must not be empty` while five single
    // writes went through fine.
    const chatId = 'chat_hardening';
    const onDisk = (rel) => fs.existsSync(tools.safePath(rel, chatId));

    const arr = await tools.execute('write_files', {
      files: [{ path: 'multi/a.txt', content: 'A' }]
    }, { chatId });
    check('write_files accepts the documented array', arr.ok === true && onDisk('multi/a.txt'),
      String(arr.output).slice(0, 80));

    const json = await tools.execute('write_files', {
      files: JSON.stringify([{ path: 'multi/b.txt', content: 'B' }])
    }, { chatId });
    check('write_files accepts a JSON string for files', json.ok === true && onDisk('multi/b.txt'),
      String(json.output).slice(0, 80));

    const single = await tools.execute('write_files', {
      path: 'multi/c.txt', content: 'C'
    }, { chatId });
    check('write_files accepts one file sent at the top level', single.ok === true && onDisk('multi/c.txt'),
      String(single.output).slice(0, 80));

    // An entry with no path used to be skipped, so a malformed call reported
    // "Successfully created 0 files" and the user was told it worked.
    //
    // The entry carries neither a path key nor a content key. (An entry that is
    // only `{ content: 'x' }` is NOT this case: as a bare object it is the map
    // form, meaning a file literally named "content" — see the map tests below.)
    const noPath = await tools.execute('write_files', { files: [{ payload: 'x' }] }, { chatId });
    check('write_files fails honestly when no entry has a path',
      noPath.ok === false && /no entry had a "path"/i.test(String(noPath.output)), String(noPath.output).slice(0, 90));

    const empty = await tools.execute('write_files', {}, { chatId });
    check('write_files explains the shape it expects',
      empty.ok === false && /"files"/.test(String(empty.output)), String(empty.output).slice(0, 90));

    // A mixed batch writes what it can and says what it skipped.
    const mixed = await tools.execute('write_files', {
      files: [{ path: 'multi/d.txt', content: 'D' }, { content: 'no path' }]
    }, { chatId });
    check('a mixed batch writes the valid entries and reports the rest',
      mixed.ok === true && onDisk('multi/d.txt') && /Skipped 1/.test(String(mixed.output)),
      String(mixed.output).replace(/\n/g, ' ').slice(0, 120));

    // ---- the shape that actually failed in production ----------------------
    //
    // A model asked for "python and bat and one html and one css and one js"
    // answered by keying the files BY PATH — `{"files": {"template.py": "…",
    // "index.html": "…"}}`. That is a natural way to send a set of files, and it
    // was rejected three times in a row on three separate chats with "no entry
    // had a path", after which the model fell back to six separate write_file
    // calls. The map form is now first-class.
    const map = await tools.execute('write_files', {
      files: { 'site/index.html': '<!doctype html>', 'site/style.css': 'body{}', 'site/app.js': 'void 0;' }
    }, { chatId });
    check('write_files accepts a path→content MAP',
      map.ok === true && onDisk('site/index.html') && onDisk('site/style.css') && onDisk('site/app.js'),
      String(map.output).replace(/\n/g, ' | ').slice(0, 120));

    const mapObjects = await tools.execute('write_files', {
      files: { 'obj/a.py': { content: 'print(1)' }, 'obj/b.bat': { content: '@echo off' } }
    }, { chatId });
    check('a map whose values are objects writes the inner content, not the wrapper',
      mapObjects.ok === true
      && fs.readFileSync(tools.safePath('obj/a.py', chatId), 'utf8') === 'print(1)'
      && fs.readFileSync(tools.safePath('obj/b.bat', chatId), 'utf8') === '@echo off',
      String(mapObjects.output).replace(/\n/g, ' | ').slice(0, 120));

    const mapNested = await tools.execute('write_files', {
      files: { 'nested/c.txt': { content: { content: 'deep' } } }
    }, { chatId });
    check('a doubly-nested content wrapper writes the inner text',
      mapNested.ok === true && fs.readFileSync(tools.safePath('nested/c.txt', chatId), 'utf8') === 'deep',
      String(mapNested.output).slice(0, 90));

    // The other recorded failure: the map arrived as a JSON *string* whose bodies
    // contained raw newlines, which is not valid JSON. `JSON.parse` rejects the
    // whole document, so five complete files were lost to a formatting slip.
    const rawNewlines = '{"script.py": "import sys\nprint(sys.version)\n", "page.html": "<!doctype html>\n<p>hi</p>\n"}';
    const recovered = await tools.execute('write_files', { files: rawNewlines }, { chatId });
    check('write_files recovers a map whose string values contain raw newlines',
      recovered.ok === true
      && fs.readFileSync(tools.safePath('script.py', chatId), 'utf8') === 'import sys\nprint(sys.version)\n'
      && fs.readFileSync(tools.safePath('page.html', chatId), 'utf8') === '<!doctype html>\n<p>hi</p>\n',
      String(recovered.output).replace(/\n/g, ' | ').slice(0, 120));

    // The text-protocol engine NARRATES before it sends: the parameter body was
    // `Here are the files:\n{…}`, which `JSON.parse` rejects outright. The JSON
    // was correct and the whole call was lost to a sentence in front of it.
    const prosePrefix = 'Here are the files:\n{"narr/a.txt": "A", "narr/b.txt": "B"}';
    const prefixed = await tools.execute('write_files', { files: prosePrefix }, { chatId });
    check('write_files finds the JSON behind a sentence of narration',
      prefixed.ok === true && onDisk('narr/a.txt') && onDisk('narr/b.txt'),
      String(prefixed.output).replace(/\n/g, ' | ').slice(0, 110));

    const proseBoth = 'Sure, here you go:\n{"narr/c.txt": "C"}\nLet me know if you want changes!';
    const wrapped = await tools.execute('write_files', { files: proseBoth }, { chatId });
    check('write_files ignores prose after the JSON as well',
      wrapped.ok === true && onDisk('narr/c.txt'), String(wrapped.output).slice(0, 90));

    const proseFenced = 'Here are the files:\n```json\n{"narr/d.txt": "D"}\n```';
    const fencedProse = await tools.execute('write_files', { files: proseFenced }, { chatId });
    check('narration around a fenced JSON block is tolerated too',
      fencedProse.ok === true && onDisk('narr/d.txt'), String(fencedProse.output).slice(0, 90));

    // A response that ran out of room mid-JSON has no matching brace. It must be
    // refused rather than half-written from a guessed-at partial document.
    const truncated = '{"index.html": "<!doctype html>", "style.css": "body { margin: 0; }';
    const cut = await tools.execute('write_files', { files: truncated }, { chatId });
    check('a truncated payload is refused instead of partly written',
      cut.ok === false && /nothing to write/.test(String(cut.output)), String(cut.output).slice(0, 70));

    const doubled = JSON.stringify(JSON.stringify({ 'dbl/a.txt': 'A', 'dbl/b.txt': 'B' }));
    const twice = await tools.execute('write_files', { files: doubled }, { chatId });
    check('write_files unwraps a double-encoded map string',
      twice.ok === true && onDisk('dbl/a.txt') && onDisk('dbl/b.txt'),
      String(twice.output).replace(/\n/g, ' | ').slice(0, 100));

    // Deliberately broken input must still be refused rather than half-written:
    // the caller gets the shape it should have sent, not a broken project.
    const broken = await tools.execute('write_files', { files: '{"a.txt": ' }, { chatId });
    check('write_files refuses an unrecoverable payload instead of guessing',
      broken.ok === false && /"files"/.test(String(broken.output)), String(broken.output).slice(0, 90));

    // Alternate key names are the same request in a different dialect.
    const altKeys = await tools.execute('write_files', {
      files: [{ filename: 'alt/one.js', code: 'let a = 1;' }, { file_path: 'alt/two.txt', text: 'two' }]
    }, { chatId });
    check('write_files accepts filename/code and file_path/text entries',
      altKeys.ok === true && onDisk('alt/one.js') && onDisk('alt/two.txt'),
      String(altKeys.output).replace(/\n/g, ' | ').slice(0, 120));

    // An empty body is a real request, not a missing one.
    const emptyBody = await tools.execute('write_files', { files: { 'blank/a.txt': '', 'blank/b.txt': 'B' } }, { chatId });
    check('a map entry with an empty body still creates the file',
      emptyBody.ok === true && onDisk('blank/a.txt') && fs.statSync(tools.safePath('blank/a.txt', chatId)).size === 0,
      String(emptyBody.output).replace(/\n/g, ' | ').slice(0, 100));

    // ---- write_file append: the ceiling on how large one file can be --------
    //
    // A file is built inside ONE model response, so without append a file longer
    // than that response allows simply cannot be written — the model shortens it.
    // Every request for a substantial file ("a template", "a dashboard", "a real
    // scraper") produced 30-line stubs for exactly this reason.
    const appendMissing = await tools.execute('write_file', { path: 'app/absent.txt', content: 'x', append: true }, { chatId });
    check('append refuses a file that does not exist yet',
      appendMissing.ok === false && /does not exist/.test(String(appendMissing.output)), String(appendMissing.output).slice(0, 80));

    await tools.execute('write_file', { path: 'app/grown.js', content: 'const a = 1;\n' }, { chatId });
    const firstAppend = await tools.execute('write_file', { path: 'app/grown.js', content: 'const b = 2;\n', append: true }, { chatId });
    await tools.execute('write_file', { path: 'app/grown.js', content: 'const c = 3;\n', append: true }, { chatId });
    check('append extends a file instead of replacing it',
      fs.readFileSync(tools.safePath('app/grown.js', chatId), 'utf8') === 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
      JSON.stringify(fs.readFileSync(tools.safePath('app/grown.js', chatId), 'utf8')));
    check('append reports the whole file\'s new size, not just the addition',
      /now \d/.test(String(firstAppend.output)) && firstAppend.meta.appended === true, String(firstAppend.output).slice(0, 80));
    check('append is marked in meta so the row can say so',
      firstAppend.meta.created === false && firstAppend.meta.lines === 2, JSON.stringify(firstAppend.meta));

    // A file whose last line has no newline must not swallow the next section.
    await tools.execute('write_file', { path: 'app/glue.txt', content: 'first' }, { chatId });
    await tools.execute('write_file', { path: 'app/glue.txt', content: 'second', append: true }, { chatId });
    check('a missing trailing newline is inserted before the appended part',
      fs.readFileSync(tools.safePath('app/glue.txt', chatId), 'utf8') === 'first\nsecond');

    // The text-protocol engines send the flag as a string, not a boolean.
    await tools.execute('write_file', { path: 'app/strflag.txt', content: 'A' }, { chatId });
    const strFlag = await tools.execute('write_file', { path: 'app/strflag.txt', content: 'B', append: 'true' }, { chatId });
    check('append accepts the string "true" from a text-protocol engine',
      strFlag.ok === true && fs.readFileSync(tools.safePath('app/strflag.txt', chatId), 'utf8') === 'A\nB');

    check('a write without append still overwrites',
      await (async () => {
        await tools.execute('write_file', { path: 'app/over.txt', content: 'one' }, { chatId });
        await tools.execute('write_file', { path: 'app/over.txt', content: 'two' }, { chatId });
        return fs.readFileSync(tools.safePath('app/over.txt', chatId), 'utf8') === 'two';
      })());

    // The point of the feature: a file bigger than any single response.
    await tools.execute('write_file', { path: 'app/big.py', content: '# part 1\n' }, { chatId });
    for (let i = 2; i <= 12; i++) {
      await tools.execute('write_file', { path: 'app/big.py', content: '# part ' + i + '\n' + 'x = 1\n'.repeat(40), append: true }, { chatId });
    }
    const grown = fs.readFileSync(tools.safePath('app/big.py', chatId), 'utf8');
    check('appending can build a file far larger than one tool call',
      grown.split('\n').length > 400 && Buffer.byteLength(grown) > 2000,
      grown.split('\n').length + ' lines, ' + Buffer.byteLength(grown) + ' bytes');

    const appendEscape = await tools.execute('write_file', { path: '../escape.txt', content: 'x', append: true }, { chatId });
    check('append cannot escape the workspace sandbox',
      appendEscape.ok === false && /escapes the workspace/i.test(String(appendEscape.output)), String(appendEscape.output).slice(0, 70));

    finish();
  })();
}

// ---------------------------------------------------------------------------
// 2. The workspace sandbox
// ---------------------------------------------------------------------------
function sandboxChecks() {
  const chatId = 'chat_hardening';
  const base = tools.resolveBaseDir(chatId);

  const rejects = (rel) => { try { tools.safePath(rel, chatId); return false; } catch { return true; } };
  check('a parent-directory escape is rejected', rejects('../outside.txt'));
  check('a deep parent-directory escape is rejected', rejects('../../../../etc/passwd'));
  check('an absolute path is neutralised or rejected', rejects('C:/Windows/win.ini'));
  check('a normal workspace path is allowed', !rejects('src/App.tsx'));

  // A UNC-looking path is not an escape here: the leading slashes are stripped
  // and it becomes an ordinary workspace-relative name. What matters is that it
  // stays inside the sandbox.
  const unc = tools.safePath('//server/share/file', chatId);
  check('a UNC path is contained inside the workspace', unc.startsWith(base + path.sep), unc);

  // A junction inside the workspace pointing outside it: the lexical check passed
  // because the unresolved path was still "inside".
  const linkPath = path.join(base, 'escape-link');
  let linked = false;
  try {
    fs.symlinkSync(os.tmpdir(), linkPath, 'junction');
    linked = true;
  } catch { /* symlink creation needs privileges on Windows */ }

  if (linked) {
    check('a link that points outside the workspace is rejected', rejects('escape-link/secret.txt'));
  } else {
    console.log('SKIP  junction containment (could not create a link in this environment)');
  }
}

// ---------------------------------------------------------------------------
// 3. edit_file string handling
// ---------------------------------------------------------------------------
function editChecks() {
  const chatId = 'chat_hardening';
  const write = (rel, text) => {
    const full = tools.safePath(rel, chatId);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
    return full;
  };
  const read = (rel) => fs.readFileSync(tools.safePath(rel, chatId), 'utf8');

  // `$&` in a string replacement expands to the matched text. The model writes
  // plenty of code that legitimately contains `$&`.
  write('dollar.js', 'const x = PLACEHOLDER;\n');
  tools.editFile({ path: 'dollar.js', find: 'PLACEHOLDER', replace: "s.replace(/x/g, '$&')", chatId });
  check('edit_file does not expand $& in the replacement',
    read('dollar.js').includes("'$&'"), read('dollar.js').trim());
  check('edit_file does not expand $ in a dollar-sign replacement',
    !read('dollar.js').includes('PLACEHOLDER'));

  // A CRLF file edited with LF `find` text must keep its line endings.
  write('crlf.txt', 'alpha\r\nbeta\r\ngamma\r\n');
  tools.editFile({ path: 'crlf.txt', find: 'beta', replace: 'BETA', chatId });
  const crlf = read('crlf.txt');
  check('a CRLF file stays CRLF after a normalized edit',
    crlf === 'alpha\r\nBETA\r\ngamma\r\n', JSON.stringify(crlf));

  // The auto-save skip set must agree with the paths the saver derives.
  check('normWorkspacePath folds ./ and //',
    tools.normWorkspacePath('./src//App.tsx') === 'src/App.tsx',
    tools.normWorkspacePath('./src//App.tsx'));
  check('normWorkspacePath folds backslashes',
    tools.normWorkspacePath('src\\App.tsx') === 'src/App.tsx');
  const skip = tools.artifactPathsFromToolRuns([{ name: 'write_file', args: { path: './src/App.tsx' } }]);
  check('a tool-written path is in the skip set', skip.has('src/App.tsx'), [...skip].join(','));
  const saved = tools.extractAndSaveCodeBlocks(
    'Here you go:\n\n```tsx{path=src/App.tsx}\nconst a = 1;\n```\n',
    { chatId, skip }
  );
  check('the auto-saver does not overwrite a file a tool already wrote',
    saved.length === 0, JSON.stringify(saved));
}

// ---------------------------------------------------------------------------
// 4. Context-window bound
// ---------------------------------------------------------------------------
function historyChecks() {
  const many = [];
  for (let i = 0; i < 120; i++) many.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  const bounded = boundHistory(many);
  check('a long transcript is trimmed', bounded.trimmed === true);
  check('the trimmed transcript respects the cap',
    bounded.messages.length <= MAX_HISTORY_MESSAGES, String(bounded.messages.length));
  check('a trimmed transcript still starts with a user turn',
    bounded.messages[0].role === 'user', bounded.messages[0].role);
  check('trimming keeps the newest turn',
    bounded.messages[bounded.messages.length - 1].content === 'm119');

  const huge = boundHistory([{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 5000) }]);
  check('an oversized message is clipped', huge.messages[0].content.length < MAX_MESSAGE_CHARS + 200);
  check('the clip is explained to the model', /characters omitted/.test(huge.messages[0].content));

  const short = boundHistory([{ role: 'user', content: 'hi' }]);
  check('a short transcript is untouched', short.trimmed === false && short.messages.length === 1);
}

try {
  sandboxChecks();
  editChecks();
  historyChecks();
} catch (e) {
  check('hardening suite ran without throwing', false, e && e.message);
  finish();
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) process.exit(1);
}
