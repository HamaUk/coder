// Mobile shell regressions.
//
// The workspace panel was undismissable on a phone: its header Refresh and Close
// buttons were `display: none`, because the per-row download action reused the
// SAME class name (`.fp-actions`) and its rule came later in the file, so it won
// on source order. On a small screen the panel is a full-height overlay, so that
// left the user with no way out at all.
//
// Reading the stylesheet is the honest test here: the bug was pure source order,
// and it is invisible to every browser-less unit test that only exercises JS.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * The `display` a selector resolves to at the top level of the stylesheet —
 * the LAST top-level declaration wins, which is exactly how the collision
 * happened. Rules inside `@media` are ignored: they only apply conditionally.
 */
function topLevelDisplay(selector) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const stripped = noComments.replace(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  let last = null;
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const decl = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(m[2]);
    if (decl) last = decl[1].trim();
  }
  return last;
}

// ---------------------------------------------------------------------------
// 1. The panel header stays visible
// ---------------------------------------------------------------------------
{
  const headerDisplay = topLevelDisplay('.fp-actions');
  check('the workspace header actions are not hidden',
    headerDisplay !== null && headerDisplay !== 'none', String(headerDisplay));

  const rowDisplay = topLevelDisplay('.fp-row-actions');
  check('the per-row download action is hover-revealed',
    rowDisplay === 'none', String(rowDisplay));

  // The two must not share a class, which is the actual defect.
  check('the header and the row action use different class names',
    !/class="fp-actions"/.test(app) && /class="fp-row-actions"/.test(app));
  check('the hover rule targets the row action',
    /\.fp-row:hover \.fp-row-actions/.test(css));
}

// ---------------------------------------------------------------------------
// 2. There is a way out of the panel on a phone
// ---------------------------------------------------------------------------
{
  check('the panel markup has a close button', /id="fpClose"/.test(html));
  check('the panel markup has a refresh button', /id="fpRefresh"/.test(html));
  check('a scrim exists for the overlay panel', /id="fpScrim"/.test(html));
  check('the scrim closes the panel when tapped',
    /\$\('#fpScrim'\)\.addEventListener\('click'[\s\S]{0,80}fpSetOpen\(false\)/.test(app));
  check('the close button closes the panel',
    /\$\('#fpClose'\)\.addEventListener\('click'[\s\S]{0,80}fpSetOpen\(false\)/.test(app));
  check('opening the panel shows the scrim', /\$\('#fpScrim'\)\.classList\.toggle\('show', on\)/.test(app));
  check('Escape closes the panel', /state\.fpOpen[\s\S]{0,60}fpSetOpen\(false\)/.test(app));
}

// ---------------------------------------------------------------------------
// 3. A closed overlay panel cannot hold focus or cover the page
// ---------------------------------------------------------------------------
{
  // `overflow: hidden` + width 0 hides the panel but leaves its buttons in the
  // tab order, so Tab vanished into an invisible panel.
  check('a closed panel is visibility:hidden at overlay widths',
    /\.files-panel:not\(\.open\)\s*\{[^}]*visibility:\s*hidden/.test(css));
  check('the visibility flip waits for the close animation',
    /visibility 0s \.25s/.test(css));

  // A narrow phone must keep a strip of scrim tappable.
  check('the open panel never covers the whole width',
    /\.files-panel\.open\s*\{\s*width:\s*min\(/.test(css));
  check('the scrim sits below the panel',
    /\.fp-scrim\s*\{[^}]*z-index:\s*65/.test(css) && /z-index:\s*70/.test(css));
}

// ---------------------------------------------------------------------------
// 4. Touch ergonomics
// ---------------------------------------------------------------------------
{
  check('the panel header respects the safe area',
    /\.fp-head\s*\{\s*padding-top:\s*max\(16px, env\(safe-area-inset-top\)\)/.test(css));
  check('the footer respects the safe area',
    /\.fp-foot\s*\{\s*padding-bottom:\s*max\(12px, env\(safe-area-inset-bottom\)\)/.test(css));
  check('the header buttons get a larger tap target on mobile',
    /\.fp-actions \.icon-btn\s*\{\s*width:\s*38px/.test(css));
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exit(1);
