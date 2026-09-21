// Terminal output rendering.
//
// A script's stdout is almost never plain text — build tools, package managers,
// test runners and linters all colour it — so the escapes must become colour,
// not noise and not nothing. Pure functions, so this is pinned here rather than
// eyeballed in the browser.
const path = require('path');

const ansi = require(path.join(__dirname, '..', 'public', 'ansi'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const ESC = '\u001b';

// ---------------------------------------------------------------------------
// Colour and attributes
// ---------------------------------------------------------------------------
{
  const red = ansi.toHtml(`${ESC}[31mfailed${ESC}[0m`);
  check('a basic colour becomes a class',
    red === '<span class="ansi-fg-red">failed</span>', red);

  const bright = ansi.toHtml(`${ESC}[92mok${ESC}[0m`);
  check('a bright colour becomes its own class',
    bright === '<span class="ansi-fg-bright-green">ok</span>', bright);

  const bg = ansi.toHtml(`${ESC}[41mERR${ESC}[0m`);
  check('a background colour becomes a class',
    bg === '<span class="ansi-bg-red">ERR</span>', bg);

  const bold = ansi.toHtml(`${ESC}[1;32mpass${ESC}[0m`);
  check('attributes combine with colour',
    bold === '<span class="ansi-fg-green ansi-bold">pass</span>', bold);

  const italic = ansi.toHtml(`${ESC}[3mnote${ESC}[0m`);
  check('italic is carried', italic === '<span class="ansi-italic">note</span>', italic);

  // 22/24/29 switch an attribute back off without resetting everything.
  const off = ansi.toHtml(`${ESC}[1mbold${ESC}[22mplain`);
  check('22 turns bold back off',
    off === '<span class="ansi-bold">bold</span>plain', off);

  // State persists across lines until reset — that is what a terminal does.
  const across = ansi.toHtml(`${ESC}[31mfirst\nsecond`);
  check('colour carries to the next line',
    across === '<span class="ansi-fg-red">first</span>\n<span class="ansi-fg-red">second</span>', across);

  const reset = ansi.toHtml(`${ESC}[31mred${ESC}[0m plain`);
  check('a reset returns to unstyled text',
    reset === '<span class="ansi-fg-red">red</span> plain', reset);

  // 256-colour and truecolor have no class; they carry an exact style.
  const truecolor = ansi.toHtml(`${ESC}[38;2;18;52;86mdeep${ESC}[0m`);
  check('truecolor carries an exact rgb style',
    truecolor.includes('style="color:rgb(18,52,86)"'), truecolor);

  const x256 = ansi.toHtml(`${ESC}[38;5;196mhot${ESC}[0m`);
  check('256-colour resolves through the xterm cube',
    x256.includes('style="color:rgb(255,0,0)"'), x256);

  const inverse = ansi.toHtml(`${ESC}[7;31mrev${ESC}[0m`);
  check('inverse swaps foreground and background',
    inverse.includes('ansi-inverse'), inverse);
}

// ---------------------------------------------------------------------------
// Escapes that carry no text
// ---------------------------------------------------------------------------
{
  check('a plain string is untouched', ansi.toHtml('hello') === 'hello');
  check('HTML in output is escaped', ansi.toHtml('<script>') === '&lt;script&gt;');

  // A private-mode sequence (hide cursor) must not survive as literal text.
  const cursor = ansi.toHtml(`${ESC}[?25lworking${ESC}[?25h`);
  check('private-mode sequences are removed',
    cursor === 'working', JSON.stringify(cursor));

  const title = ansi.toHtml(`${ESC}]0;my title\u0007done`);
  check('an OSC window-title sequence is removed', title === 'done', JSON.stringify(title));

  const erase = ansi.toHtml(`${ESC}[2Kclean${ESC}[K`);
  check('erase-in-line sequences are removed', erase === 'clean', JSON.stringify(erase));

  check('hasAnsi detects colour', ansi.hasAnsi(`${ESC}[31mx`) === true);
  check('hasAnsi is false for plain text', ansi.hasAnsi('x') === false);
  check('hasAnsi tolerates null', ansi.hasAnsi(null) === false);
}

// ---------------------------------------------------------------------------
// Line rewriting
// ---------------------------------------------------------------------------
{
  // A progress bar redraws its line with \r. Only the final state is real;
  // showing every redraw would print hundreds of stale percentage lines.
  const progress = ansi.toHtml('10%\r55%\r100% done');
  check('a carriage-return redraw keeps only the final line',
    progress === '100% done', JSON.stringify(progress));

  const crlf = ansi.toHtml('one\r\ntwo');
  check('CRLF is treated as one line ending', crlf === 'one\ntwo', JSON.stringify(crlf));

  const coloured = ansi.toHtml(`${ESC}[32mok${ESC}[0m\r${ESC}[31mbad${ESC}[0m`);
  check('a redraw keeps the final colour too',
    coloured === '<span class="ansi-fg-red">bad</span>', coloured);

  // Tabs survive: they are layout in a terminal, not control noise.
  check('tabs are kept', ansi.toHtml('a\tb') === 'a\tb');
}

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------
{
  check('an unterminated sequence does not throw', typeof ansi.toHtml(`${ESC}[31mno reset`) === 'string');
  // An SGR code with no meaning here is dropped, not printed and not guessed at.
  check('an unknown SGR parameter renders as plain text',
    ansi.toHtml(`${ESC}[99mtext${ESC}[0m`) === 'text', JSON.stringify(ansi.toHtml(`${ESC}[99mtext${ESC}[0m`)));
  check('empty input renders empty', ansi.toHtml('') === '');
  check('null input renders empty', ansi.toHtml(null) === '');
  // A stray escape in the middle of HTML-ish text must not break escaping.
  const mixed = ansi.toHtml(`${ESC}[31m<b>${ESC}[0m`);
  check('escaping survives a coloured tag', mixed === '<span class="ansi-fg-red">&lt;b&gt;</span>', mixed);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exit(1);
