// Lightweight, dependency-free Markdown renderer + syntax highlighter.
// (The app's preview environment blocks CDNs, so everything is self-contained.)
//
// Rendering order matters and is the source of most historical bugs here:
//
//   1. inline code is lifted out first, because its body is literal;
//   2. images and links are lifted out next, because their URLs must never be
//      escaped a second time, emphasised, or autolinked;
//   3. only then is the remaining text HTML-escaped and run through the
//      emphasis / autolink passes.
//
// Doing emphasis over an already-built <a href="..."> used to rewrite the URL
// itself (`/_foo_` became `/<em>foo</em>`), and escaping a link URL after the
// document had been escaped produced `?a=1&amp;amp;b=2` — a url that decodes to
// the literal text `&amp;` and 404s. Both are regression-tested in
// .smoke/markdown.test.js.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // ------------------------------------------------------------------
  // Syntax highlighting — single-pass tokenizer on raw text, escaping
  // each token as it is emitted (safe against double-processing).
  // ------------------------------------------------------------------
  const KEYWORDS = 'const|let|var|function|return|if|elif|else|for|while|do|class|extends|import|from|export|default|async|await|new|try|catch|finally|throw|throws|switch|case|break|continue|typeof|instanceof|in|of|delete|this|super|null|undefined|true|false|None|True|False|def|lambda|with|as|pass|raise|yield|global|nonlocal|is|not|and|or|print|public|private|protected|static|void|int|long|float|double|char|string|bool|boolean|fn|mut|impl|struct|enum|match|pub|use|mod|where|type|interface|namespace|package|go|func|chan|defer|select|require|module|exports|self';
  const TOKEN_RE = new RegExp(
    '(' + '\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*' + ')' +          // 1: comments
    '|(' + '"(?:[^"\\\\\\n]|\\\\.)*"?|' + "'(?:[^'\\\\\\n]|\\\\.)*'?|" + '`(?:[^`\\\\]|\\\\.)*`?' + ')' + // 2: strings
    '|(\\b\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b)' +                     // 3: numbers
    '|\\b(' + KEYWORDS + ')\\b',                                           // 4: keywords
    'gi'
  );

  function highlightCode(src, lang) {
    if (lang === 'json') {
      return escapeHtml(src).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?/g,
        (m, s, colon) => colon ? `<span class="tok-f">${s}</span>${colon}` : `<span class="tok-s">${s}</span>`);
    }
    let out = '';
    let last = 0;
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(src))) {
      out += escapeHtml(src.slice(last, m.index));
      const cls = m[1] ? 'tok-c' : m[2] ? 'tok-s' : m[3] ? 'tok-n' : 'tok-k';
      out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
      last = TOKEN_RE.lastIndex;
      if (m[0] === '') TOKEN_RE.lastIndex++; // safety
    }
    out += escapeHtml(src.slice(last));
    return out;
  }

  // ------------------------------------------------------------------
  // Inline formatting
  // ------------------------------------------------------------------
  // Placeholders use private-use unicode markers so plain numbers in the text
  // are never mistaken for stashed fragments, and so they survive escapeHtml.
  const OPEN = '\uE000';
  const CLOSE = '\uE001';
  const STASH_RE = new RegExp(OPEN + '(\\d+)' + CLOSE, 'g');

  const SAFE_URL = /^(https?:|mailto:|tel:|#|\/)/i;

  // `stash` is threaded through the recursive call for link labels: a label is
  // rendered after the outer pass has already lifted code/images out, so the
  // label text carries placeholders that index the OUTER array. A fresh array
  // per call resolved them to '' and silently deleted the label's contents
  // (`[![badge](img)](url)` and `[\`code\`](url)` both rendered an empty anchor).
  function renderInline(text, stash = []) {
    const keep = (html) => {
      stash.push(html);
      return OPEN + (stash.length - 1) + CLOSE;
    };

    let s = String(text == null ? '' : text);

    // 1. Inline code — content is literal, so it is lifted out before escaping.
    //    A single leading/trailing space is padding, per CommonMark.
    s = s.replace(/(`+)([\s\S]*?)\1/g, (m, ticks, code) => {
      if (!code.length) return m;
      return keep('<code>' + escapeHtml(code.replace(/^ ([\s\S]*) $/, '$1')) + '</code>');
    });

    // 2. Images — rendered from the raw match so the URL is escaped exactly once.
    s = s.replace(/!\[([^\]]*)\]\(\s*([^\s)]+?)(?:\s+"([^"]*)")?\s*\)/g, (m, alt, url, title) => {
      if (!/^(https?:|data:image\/|\/)/i.test(url)) return m;
      return keep('<img class="md-img" src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) + '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') + ' loading="lazy">');
    });

    // 3. Links. A label may itself contain code/emphasis, so it recurses — into
    //    the SAME stash, so the outer placeholders resolve.
    s = s.replace(/\[([^\]]*)\]\(\s*([^\s)]+?)(?:\s+"([^"]*)")?\s*\)/g, (m, label, url, title) => {
      const safe = SAFE_URL.test(url) ? url : '#';
      return keep('<a href="' + escapeHtml(safe) + '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') +
        ' target="_blank" rel="noopener noreferrer">' + renderInline(label, stash) + '</a>');
    });

    // 4. Everything left is plain text.
    s = escapeHtml(s);

    // 5. Autolink bare URLs. They are escaped already, so the URL is used as-is
    //    in the href (escaping again would corrupt `&` in a query string).
    //    Trailing sentence punctuation is pushed back outside the anchor.
    s = s.replace(/https?:\/\/[^\s<>"'`]+/g, (url) => {
      let trail = '';
      for (;;) {
        const m = url.match(/[.,;:!?)\]}]+$/);
        if (!m) break;
        // Never cut an HTML entity in half: the `;` closing `&amp;` is not
        // sentence punctuation, and removing it would corrupt the href.
        if (m[0].startsWith(';') && /&[a-zA-Z]+$/.test(url.slice(0, -1))) break;
        trail = m[0] + trail;
        url = url.slice(0, url.length - m[0].length);
      }
      // A URL that is only a scheme is not a link.
      if (!/^https?:\/\/[^\s/.]/i.test(url)) return url + trail;
      return keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>') + trail;
    });

    // 6. Emphasis runs on text that can no longer contain a URL or a tag.
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/==([^=]+)==/g, '<mark>$1</mark>');

    // 7. Put the stashed fragments back.
    return s.replace(STASH_RE, (m, i) => stash[Number(i)] ?? '');
  }

  // ------------------------------------------------------------------
  // Block parsing
  // ------------------------------------------------------------------
  const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

  const indentOf = (ws) => String(ws || '').replace(/\t/g, '    ').length;

  /** Renders one list node, recursing into nested lists carried by its items. */
  function listNodeHtml(node) {
    const tag = node.ordered ? 'ol' : 'ul';
    const attr = node.ordered && node.start > 1 ? ` start="${node.start}"` : '';
    let html = `<${tag}${attr}>`;
    for (const it of node.items) {
      let inner;
      const task = it.text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === 'x';
        inner = `<label class="md-task"><input type="checkbox" disabled${checked ? ' checked' : ''}>` +
          `<span>${renderInline(task[2])}</span></label>`;
      } else {
        inner = renderInline(it.text);
      }
      if (it.list && it.list.items.length) inner += listNodeHtml(it.list);
      html += `<li>${inner}</li>`;
    }
    return html + `</${tag}>`;
  }

  /**
   * Parses a run of list lines into a tree, one node per indentation level.
   *
   * The previous version only understood a single nesting level and flattened
   * anything deeper ("- a / - b / - c" came out as a, b, c siblings), which is
   * very visible in a model's bulleted answer.
   */
  function parseList(lines, startIdx) {
    const firstMatch = lines[startIdx].match(LIST_ITEM_RE);
    const rootOrdered = /^\d/.test(firstMatch[2]);
    const root = {
      ordered: rootOrdered,
      start: rootOrdered ? (parseInt(firstMatch[2], 10) || 1) : 1,
      items: []
    };

    const stack = [{ indent: indentOf(firstMatch[1]), list: root }];
    let i = startIdx;

    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === '') {
        // A blank line only continues the list when the next line is still an
        // item at this depth or deeper.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const next = j < lines.length ? lines[j].match(LIST_ITEM_RE) : null;
        if (next && indentOf(next[1]) >= stack[stack.length - 1].indent) { i = j; continue; }
        break;
      }

      const m = line.match(LIST_ITEM_RE);
      if (!m) {
        // Lazy continuation: an unindented follow-on line belongs to the item.
        const top = stack[stack.length - 1];
        const last = top.list.items[top.list.items.length - 1];
        if (last && indentOf(line.match(/^\s*/)[0]) >= top.indent) {
          last.text += ' ' + line.trim();
          i++;
          continue;
        }
        break;
      }

      const indent = indentOf(m[1]);
      const isOrdered = /^\d/.test(m[2]);
      const item = { text: m[3], list: null };

      while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();

      const top = stack[stack.length - 1];
      if (indent > top.indent) {
        const parent = top.list.items[top.list.items.length - 1];
        if (!parent) break;
        // Reuse an existing nested list rather than dropping the items already
        // collected in it when the indentation drifts back and forth.
        if (!parent.list) {
          parent.list = {
            ordered: isOrdered,
            start: isOrdered ? (parseInt(m[2], 10) || 1) : 1,
            items: []
          };
        }
        stack.push({ indent, list: parent.list });
      } else if (indent === top.indent && top.list.items.length === 0) {
        top.list.ordered = isOrdered;
        top.list.start = isOrdered ? (parseInt(m[2], 10) || 1) : 1;
      }

      stack[stack.length - 1].list.items.push(item);
      i++;
    }

    return { html: listNodeHtml(root), next: i };
  }

  const splitRow = (r) => String(r).trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

  function tableAlignClass(cell) {
    const l = cell.startsWith(':');
    const r = cell.endsWith(':');
    if (l && r) return ' class="ta-c"';
    if (r) return ' class="ta-r"';
    if (l) return ' class="ta-l"';
    return '';
  }

  function parseFenceMeta(info) {
    // ```tsx{path=src/App.tsx title="App"}  →  { lang, label }
    const m = String(info || '').match(/^([\w+#.-]*)\s*(?:\{([^}]*)\})?\s*$/);
    const lang = (m && m[1] ? m[1] : '').toLowerCase();
    const rawMeta = (m && m[2]) || '';
    let label = '';
    const pathMatch = rawMeta.match(/(?:path|file|filename)\s*=\s*"?([^"\s}]+)"?/i);
    if (pathMatch) label = pathMatch[1];
    else {
      const titleMatch = rawMeta.match(/title\s*=\s*"([^"]*)"/i);
      if (titleMatch) label = titleMatch[1];
    }
    return { lang, label };
  }

  function renderMarkdown(src, opts) {
    if (!src) return '';
    // Above this many lines a fenced block renders collapsed, behind a summary
    // chip. A streamed 140-line component would otherwise bury the narration
    // that says what it is doing. 0 / undefined = never collapse, so every
    // existing call site keeps its behaviour.
    const collapseAt = Number(opts && opts.collapseCodeLines) || 0;
    src = String(src).replace(/\r\n?/g, '\n');
    // Safety net for a reply saved before the server-side stripping was
    // tightened: the free engine's `<|DSML|…>` tool-call markup is a wire
    // protocol, never prose, and must not be shown even from an old transcript.
    src = src
      .replace(/<[|｜]DSML[|｜]tool_calls>[\s\S]*?(?:<\/[|｜]DSML[|｜]tool_calls>|$)/gi, '')
      .replace(/<[|｜]DSML[|｜][^>]*>/gi, '');
    // Chat-wrapper tags. Amazon's Nova models — and a few others reached through
    // an OpenAI-compatible endpoint — put their whole answer inside
    // `<response>…</response>`. Because this renderer escapes HTML rather than
    // dropping it, those tags were printed verbatim in the reply (and in a saved
    // transcript, so this net also cleans up old ones). Only tags that cannot be
    // real markup are listed: `<output>`, `<details>` and friends are valid HTML.
    src = src.replace(/<\/?response\s*>/gi, '');
    const lines = src.split('\n');
    const out = [];
    let i = 0;
    let para = [];

    const flushPara = () => {
      if (!para.length) return;
      // Two trailing spaces (or a trailing backslash) is an explicit line break.
      let html = '';
      for (let n = 0; n < para.length; n++) {
        const raw = para[n];
        const br = /\s{2,}$/.test(raw) || /\\$/.test(raw);
        const text = raw.replace(/\s+$/, '').replace(/\\$/, '');
        html += renderInline(text) + (br ? '<br>' : ' ');
      }
      out.push(`<p>${html.trimEnd()}</p>`);
      para = [];
    };

    const isTableDelim = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');

    while (i < lines.length) {
      const line = lines[i];

      // fenced code — ``` or ~~~, with an optional {path=...} meta block
      const fence = line.match(/^(`{3,}|~{3,})(.*)$/);
      if (fence) {
        flushPara();
        const marker = fence[1][0];
        const closeRe = new RegExp('^\\s*' + (marker === '`' ? '`{3,}' : '~{3,}') + '\\s*$');
        const { lang, label } = parseFenceMeta(fence[2]);
        const buf = [];
        i++;
        while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // skip closing fence (if any)
        const raw = buf.join('\n');
        const isPreviewable = lang === 'html' || lang === 'svg' || /<!doctype html|<html[\s>]|<body[\s>]|<svg[\s>]/i.test(raw);
        const block =
          `<div class="code-block"><div class="code-head"><span class="lang">${escapeHtml(label || lang || 'code')}</span>` +
          `<div style="display:flex;align-items:center">` +
          (isPreviewable ? `<button class="preview-code-btn" data-code="${encodeURIComponent(raw)}"><svg class="ic"><use href="#i-eye"/></svg><span>Preview</span></button>` : '') +
          `<button class="copy-code" data-code="${encodeURIComponent(raw)}"><svg class="ic"><use href="#i-copy"/></svg><span>Copy</span></button></div></div>` +
          `<pre><code>${highlightCode(raw, lang)}</code></pre></div>`;

        if (collapseAt && buf.length >= collapseAt) {
          out.push(
            `<details class="code-fold">` +
            `<summary><svg class="ic"><use href="#i-code-bracket"/></svg>` +
            `<span class="cf-lang">${escapeHtml(label || lang || 'code')}</span>` +
            `<span class="cf-lines">${buf.length} lines</span>` +
            `<span class="cf-hint">show code</span></summary>` +
            block +
            `</details>`
          );
        } else {
          out.push(block);
        }
        continue;
      }

      // headings — trailing closing hashes are decoration
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const text = h[2].replace(/\s+#+\s*$/, '').trim();
        out.push(`<h${h[1].length}>${renderInline(text)}</h${h[1].length}>`);
        i++;
        continue;
      }

      // hr
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }

      // blockquote
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
        continue;
      }

      // table
      if (line.includes('|') && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
        flushPara();
        const headers = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(tableAlignClass);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let html = '<div class="md-table-wrap"><table><thead><tr>' +
          headers.map((c, n) => `<th${aligns[n] || ''}>${renderInline(c)}</th>`).join('') +
          '</tr></thead><tbody>';
        for (const r of rows) {
          // Pad or clip to the header width so a ragged row cannot shift columns.
          const cells = headers.map((_, n) => (r[n] === undefined ? '' : r[n]));
          html += '<tr>' + cells.map((c, n) => `<td${aligns[n] || ''}>${renderInline(c)}</td>`).join('') + '</tr>';
        }
        out.push(html + '</tbody></table></div>');
        continue;
      }

      // Indented code block (four spaces or a tab) — the other way a model
      // presents code, and the one this renderer had no rule for. The indent was
      // simply stripped and the code was re-flowed into the surrounding
      // paragraph, so an answer that used indentation instead of fences appeared
      // to contain no code at all.
      //
      // Gated on `!para.length`: an indented CONTINUATION line of a wrapping
      // paragraph is prose, not code, and turning it into a code block would
      // shred ordinary sentences.
      if (!para.length && line.trim() !== '' && /^(?: {4}|\t)/.test(line)) {
        const buf = [];
        while (i < lines.length) {
          const l = lines[i];
          if (l.trim() === '') { buf.push(''); i++; continue; }
          if (!/^(?: {4}|\t)/.test(l)) break;
          buf.push(l.replace(/^(?: {4}|\t)/, ''));
          i++;
        }
        while (buf.length && buf[buf.length - 1].trim() === '') buf.pop();
        out.push(`<pre class="md-indent"><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // lists (arbitrary nesting)
      if (LIST_ITEM_RE.test(line)) {
        flushPara();
        const parsed = parseList(lines, i);
        out.push(parsed.html);
        i = parsed.next;
        continue;
      }

      // blank line
      if (line.trim() === '') { flushPara(); i++; continue; }

      // Leading indent is stripped, but trailing spaces are kept: two of them
      // are an explicit hard line break and trimming here would erase the signal.
      para.push(line.replace(/^\s+/, ''));
      i++;
    }
    flushPara();
    return out.join('\n');
  }

  return { render: renderMarkdown, highlight: highlightCode, escape: escapeHtml, inline: renderInline };
});
