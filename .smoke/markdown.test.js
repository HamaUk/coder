// Regression tests for the Markdown renderer.
//
// Every case here is a bug that was actually observed in a real assistant reply
// rendered by the console, not a hypothetical. The renderer is the single most
// visible surface in the product — it is literally what the model "says" — so
// these are pinned rather than trusted.
const path = require('path');

const md = require(path.join(__dirname, '..', 'public', 'markdown'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const render = (s) => md.render(s);

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
{
  // A URL query string is escaped once. Escaping it twice produced
  // `?a=1&amp;amp;b=2`, which the browser decodes to the literal `&amp;` and 404s.
  const withAmp = render('See [docs](https://example.com/a?x=1&y=2) now');
  check('a link URL with & is escaped exactly once',
    withAmp.includes('href="https://example.com/a?x=1&amp;y=2"'), withAmp);
  check('the double-escaped form does not appear', !withAmp.includes('&amp;amp;'));

  // Emphasis used to be applied over the finished <a href>, rewriting the URL.
  const underscored = render('[t](https://example.com/_foo_)');
  check('underscores in a URL are not turned into <em>',
    underscored.includes('href="https://example.com/_foo_"') && !underscored.includes('<em>'), underscored);

  const bare = render('Go to https://example.com/a?x=1&y=2 please');
  check('a bare URL keeps its query string',
    bare.includes('href="https://example.com/a?x=1&amp;y=2"'), bare);
  check('the autolinked text also keeps it', bare.includes('>https://example.com/a?x=1&amp;y=2</a>'));

  const sentence = render('Read https://example.com/page. Then stop.');
  check('trailing sentence punctuation stays outside the anchor',
    sentence.includes('>https://example.com/page</a>.'), sentence);

  const unsafe = render('[click](javascript:alert(1))');
  check('a javascript: URL is neutralised', unsafe.includes('href="#"') && !unsafe.includes('javascript:'), unsafe);

  // The label is rendered through the same stash — a fresh stash per recursive
  // call deleted the label's contents entirely.
  const codeLabel = render('see [`a.js`](https://e.com) end');
  check('a code span inside a link label survives',
    codeLabel.includes('<code>a.js</code>'), codeLabel);

  const imgLabel = render('[![B](https://i.img/a.png)](https://e.com)');
  check('an image inside a link label survives',
    imgLabel.includes('<img class="md-img" src="https://i.img/a.png"'), imgLabel);
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------
{
  const protectedCode = render('use `**not bold**` here');
  check('emphasis inside a code span is left literal',
    protectedCode.includes('<code>**not bold**</code>') && !protectedCode.includes('<strong>'), protectedCode);

  const fenced = render('```tsx{path=src/App.tsx}\nconst a = 1;\n```');
  check('a fenced block labels itself with its path', fenced.includes('>src/App.tsx</span>'), fenced);
  check('a fenced block highlights its language', fenced.includes('class="tok-k">const</span>'));

  const tilde = render('~~~python\nx = 1\n~~~');
  check('~~~ fences work as well as ```', tilde.includes('class="tok-n">1</span>') && !tilde.includes('~~~'));
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------
{
  // The old parser understood one level and flattened anything deeper, so a
  // three-level outline came back as three siblings.
  const nested = render('- a\n  - b\n    - c');
  check('three list levels nest three deep',
    nested === '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>', nested);

  const ordered = render('3. three\n4. four');
  check('an ordered list keeps its start number', ordered.includes('<ol start="3">'), ordered);

  const mixed = render('1. one\n   - sub a\n   - sub b\n2. two');
  check('an ordered list can contain an unordered one',
    mixed.includes('<ol><li>one<ul><li>sub a</li><li>sub b</li></ul></li><li>two</li></ol>'), mixed);

  const continued = render('- first line\n  continued here\n- second');
  check('an indented continuation joins its item', continued.includes('first line continued here'), continued);

  const tasks = render('- [x] done\n- [ ] todo');
  check('a task list renders disabled checkboxes',
    tasks.includes('<input type="checkbox" disabled checked>') &&
    tasks.includes('<input type="checkbox" disabled>'), tasks);
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
{
  const aligned = render('| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
  check('column alignment is carried to the cells',
    aligned.includes('<th class="ta-l">a</th>') &&
    aligned.includes('<th class="ta-c">b</th>') &&
    aligned.includes('<th class="ta-r">c</th>'), aligned);
  check('a table is wrapped so it can scroll on its own',
    aligned.includes('<div class="md-table-wrap">') && aligned.includes('</table></div>'), aligned);

  const ragged = render('| a | b |\n|---|---|\n| 1 |');
  check('a short row is padded to the header width',
    ragged.includes('<td class="ta-l">1</td>') || ragged.includes('<td>1</td>'), ragged);
  check('no empty cell is emitted for the missing column',
    !/undefined/.test(ragged), ragged);
}

// ---------------------------------------------------------------------------
// Blocks and escaping
// ---------------------------------------------------------------------------
{
  check('a heading drops its closing hashes', render('## Title ##').includes('<h2>Title</h2>'));
  check('two trailing spaces become a hard line break',
    render('line one  \nline two').includes('line one<br>line two'));
  check('==text== is highlighted', render('a ==b== c').includes('<mark>b</mark>'));
  check('~~text~~ is struck through', render('a ~~b~~ c').includes('<del>b</del>'));

  const xss = render('<img src=x onerror=alert(1)>');
  check('raw HTML in a reply is escaped, not executed',
    xss.includes('&lt;img src=x onerror=alert(1)&gt;') && !xss.includes('<img src=x'), xss);

  // The free engine's tool-call wire protocol must never render as prose, even
  // from a transcript saved before the server-side stripping was tightened.
  const leaked = render('Sure.\n\n<|DSML|tool_calls>\n<|DSML|invoke name="list_files">\n</|DSML|invoke>\n</|DSML|tool_calls>\n\nDone.');
  check('DSML tool-call markup is never rendered as prose',
    !/DSML/.test(leaked) && leaked.includes('Sure.') && leaked.includes('Done.'), leaked);

  // A URL that genuinely ends in "&" must keep the entity the escaper produced
  // for it; the punctuation trimmer must not eat the closing ";".
  const entity = md.inline('https://example.com/?a=1&');
  check('an autolink never splits the entity that closes a trailing &',
    entity.includes('href="https://example.com/?a=1&amp;"'), entity);
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exit(1);
