// Terminal output → HTML, with SGR colour.
//
// A script's stdout is almost never plain text: build tools, package managers,
// test runners and linters all colour their output, and the escapes were being
// rendered as literal `\x1b[32m` noise (or stripped entirely, losing the one
// signal that says which line failed).
//
// The harness's equivalent leans on the `anser` package; this app has no
// dependencies, so the SGR subset that real tools actually emit is parsed here.
// Kept deliberately narrow: the standard attributes, the 8/16 colours, and the
// 256/truecolor forms. Anything else is stripped rather than shown raw.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ansi = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const ESC = '\u001b';

  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Foreground SGR code → class suffix. 30-37 basic, 90-97 bright.
  const FG = {
    30: 'black', 31: 'red', 32: 'green', 33: 'yellow',
    34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
    90: 'bright-black', 91: 'bright-red', 92: 'bright-green', 93: 'bright-yellow',
    94: 'bright-blue', 95: 'bright-magenta', 96: 'bright-cyan', 97: 'bright-white'
  };
  // Background codes are the foreground codes plus ten (40-47 basic, 100-107 bright).
  const BG = {};
  for (const code of Object.keys(FG)) BG[Number(code) + 10] = FG[code];

  const defaultState = () => ({
    fg: null, bg: null, rgbFg: null, rgbBg: null,
    bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false
  });

  /** Reset attributes that `22`/`23`/`24`/`27`/`29` switch off. */
  function applyOff(state, code) {
    if (code === 22) { state.bold = false; state.dim = false; }
    else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 29) state.strike = false;
  }

  /**
   * Applies one `\x1b[….m` parameter list to the running state.
   * `38`/`48` consume the following parameters (256-colour `5;n`, truecolor `2;r;g;b`).
   */
  function applySgr(state, params) {
    for (let i = 0; i < params.length; i++) {
      const code = params[i];
      if (code === 0) Object.assign(state, defaultState());
      else if (code === 1) state.bold = true;
      else if (code === 2) state.dim = true;
      else if (code === 3) state.italic = true;
      else if (code === 4) state.underline = true;
      else if (code === 7) state.inverse = true;
      else if (code === 9) state.strike = true;
      else if (code === 39) { state.fg = null; state.rgbFg = null; }
      else if (code === 49) { state.bg = null; state.rgbBg = null; }
      else if (code >= 22 && code <= 29) applyOff(state, code);
      else if (FG[code]) { state.fg = FG[code]; state.rgbFg = null; }
      else if (BG[code]) { state.bg = BG[code]; state.rgbBg = null; }
      else if (code === 38 || code === 48) {
        const isFg = code === 38;
        const mode = params[i + 1];
        if (mode === 5 && Number.isFinite(params[i + 2])) {
          const rgb = xterm256(params[i + 2]);
          if (isFg) { state.rgbFg = rgb; state.fg = null; } else { state.rgbBg = rgb; state.bg = null; }
          i += 2;
        } else if (mode === 2 && Number.isFinite(params[i + 2])) {
          const rgb = `rgb(${clamp255(params[i + 2])},${clamp255(params[i + 3])},${clamp255(params[i + 4])})`;
          if (isFg) { state.rgbFg = rgb; state.fg = null; } else { state.rgbBg = rgb; state.bg = null; }
          i += 4;
        }
      }
    }
  }

  const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));

  /** The xterm 256-colour cube → an `rgb(...)` string. */
  function xterm256(n) {
    const i = clamp255(n);
    if (i < 16) {
      const base = [
        [0, 0, 0], [187, 0, 0], [0, 187, 0], [187, 187, 0],
        [0, 0, 187], [187, 0, 187], [0, 187, 187], [187, 187, 187],
        [85, 85, 85], [255, 85, 85], [85, 255, 85], [255, 255, 85],
        [85, 85, 255], [255, 85, 255], [85, 255, 255], [255, 255, 255]
      ][i];
      return `rgb(${base[0]},${base[1]},${base[2]})`;
    }
    if (i < 232) {
      const c = i - 16;
      const steps = [0, 95, 135, 175, 215, 255];
      return `rgb(${steps[Math.floor(c / 36) % 6]},${steps[Math.floor(c / 6) % 6]},${steps[c % 6]})`;
    }
    const g = 8 + (i - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }

  /** The class list for a state, or '' when nothing needs a wrapper. */
  function classFor(state) {
    const cls = [];
    if (state.fg) cls.push('ansi-fg-' + state.fg);
    if (state.bg) cls.push('ansi-bg-' + state.bg);
    if (state.bold) cls.push('ansi-bold');
    if (state.dim) cls.push('ansi-dim');
    if (state.italic) cls.push('ansi-italic');
    if (state.underline) cls.push('ansi-underline');
    if (state.strike) cls.push('ansi-strike');
    if (state.inverse) cls.push('ansi-inverse');
    return cls.join(' ');
  }

  function styleFor(state) {
    const css = [];
    // Under an inverse run the two swap, which is what the terminal does.
    const fg = state.inverse ? (state.rgbBg || null) : state.rgbFg;
    const bg = state.inverse ? (state.rgbFg || null) : state.rgbBg;
    if (fg) css.push('color:' + fg);
    if (bg) css.push('background:' + bg);
    return css.join(';');
  }

  /**
   * Removes escape sequences that carry no visible text: OSC (window title,
   * hyperlinks), private-mode CSI (`\x1b[?25l`), erase-in-line, cursor moves.
   * The caller has already split out the SGR sequences it parses, so every CSI
   * reaching here is one with no display meaning.
   */
  function stripEscapes(line) {
    return String(line)
      // OSC … terminated by BEL or ST
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
      // Any CSI sequence (SGR ones were consumed before this point)
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // Two-character escapes (charset selection, single shift, reset)
      .replace(/\u001b[@-Z\\-_]/g, '')
      // Remaining C0 controls, keeping tab (layout) and newline (handled by caller).
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }

  /**
   * Renders terminal output as HTML for a `<pre>`.
   *
   * @param {string} text raw stdout/stderr, escapes included
   * @returns {string} escaped HTML with `<span>` runs for colour and attributes
   */
  function toHtml(text) {
    const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    const state = defaultState();
    const out = [];

    for (const rawLine of src.split('\n')) {
      // A bare carriage return rewrites the line from column 0 — that is how a
      // progress bar redraws itself. Only the final state of the line is real.
      const line = rawLine.includes('\r') ? rawLine.slice(rawLine.lastIndexOf('\r') + 1) : rawLine;

      let plain = '';
      const spans = [];
      const flush = () => {
        if (!plain) return;
        const cls = classFor(state);
        const style = styleFor(state);
        if (!cls && !style) spans.push(escapeHtml(plain));
        else {
          const attrs = (cls ? ` class="${cls}"` : '') + (style ? ` style="${style}"` : '');
          spans.push(`<span${attrs}>${escapeHtml(plain)}</span>`);
        }
        plain = '';
      };

      // Split on SGR sequences only; other escapes are removed from the text.
      const parts = String(line).split(/\u001b\[([0-9;]*)m/);
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
          flush();
          const params = parts[i] === '' ? [0] : parts[i].split(';').map((p) => Number(p) || 0);
          applySgr(state, params);
        } else {
          plain += stripEscapes(parts[i]);
        }
      }
      flush();
      out.push(spans.join(''));
    }

    return out.join('\n');
  }

  /** True when the text carries any SGR sequence at all. */
  function hasAnsi(text) {
    return /\u001b\[[0-9;]*m/.test(String(text == null ? '' : text));
  }

  return { toHtml, hasAnsi, stripEscapes };
});
