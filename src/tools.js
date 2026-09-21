// Tool definitions + executors: live web search, page fetching, sandboxed file
// operations (create / read / edit / delete / list), real shell execution and
// background jobs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dns = require('dns').promises;
const store = require('./store');
const spill = require('./spill');
const { WORKSPACE_DIR } = store;
const llamacoder = require('./llamacoder');
const todo = require('./middleware/todo');
const shellKit = require('./shell');
const jobs = require('./jobs');
const diffKit = require('./diff');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * The directory a chat's file operations are rooted at.
 *
 * An invalid id FAILS here rather than falling back to the shared root. The
 * fallback was a cross-chat data leak: `getChatWorkspaceDir` returns null for an
 * id that sanitises to nothing (`.`, `..`, `///`, a space), the root was then
 * used, and a request naming `chats/<other>/secret.txt` read another
 * conversation's workspace — reachable from any URL, including the preview
 * iframe. A chat-scoped caller gets its own directory or an error.
 *
 * @param {string|null} chatId - the chat to scope to, or null for the scratch root.
 * @returns {string} the absolute base directory.
 */
function resolveBaseDir(chatId) {
  if (chatId) {
    if (!store.isValidChatId(chatId)) {
      throw new Error('Invalid chatId: a chat-scoped path needs an id of letters, digits, "-" or "_".');
    }
    const dir = store.getChatWorkspaceDir(chatId);
    if (dir) return dir;
  }
  return WORKSPACE_DIR;
}

/**
 * The real location of a path, tolerating a path whose leaf does not exist yet:
 * it walks up to the nearest existing ancestor, resolves that, and re-appends
 * the missing segments.
 */
function realPathOf(target) {
  let current = target;
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  let real = current;
  try { real = (fs.realpathSync.native || fs.realpathSync)(current); } catch { /* keep the literal path */ }
  return tail.length ? path.join(real, ...tail) : real;
}

/**
 * Resolves a workspace-relative path and refuses anything that leaves the
 * sandbox — including *through* a symlink or Windows junction.
 *
 * The lexical check alone was not containment: a junction created inside the
 * workspace (run_script can create one) pointed at the user's home directory,
 * and read_file / write_file / delete_file all followed it, because the
 * unresolved path was still nominally "inside" the workspace.
 */
function safePath(rel, chatId) {
  const base = resolveBaseDir(chatId);
  const clean = String(rel || '').replace(/^[/\\]+/, '');
  const resolved = path.resolve(base, clean);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path escapes the workspace sandbox. Use paths relative to the workspace root.');
  }
  let realBase = base;
  try { realBase = (fs.realpathSync.native || fs.realpathSync)(base); } catch { /* keep the literal path */ }
  const realResolved = realPathOf(resolved);
  if (realResolved !== realBase && !realResolved.startsWith(realBase + path.sep)) {
    throw new Error('Path escapes the workspace sandbox: it resolves outside the workspace (a symlink or junction).');
  }
  return resolved;
}

const stripTags = (s) => s.replace(/<[^>]+>/g, '');

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// A page we cannot read in full is not worth the process's memory. The previous
// code buffered whatever the server sent and only clipped the extracted text
// afterwards, so a multi-gigabyte response could take the server down.
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Reads a response body, stopping at MAX_FETCH_BYTES. */
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
    try { res.body?.cancel(); } catch { /* ignore */ }
    throw new Error(`response is too large (${fmtBytes(declared)})`);
  }
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    out += decoder.decode(value, { stream: true });
    if (bytes >= MAX_FETCH_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  out += decoder.decode();
  return out;
}

/**
 * Fetches a public URL, validating every hop.
 *
 * `redirect: 'follow'` made the private-address guard meaningless, because only
 * the first URL was ever inspected: a public host answering
 * `302 Location: http://127.0.0.1:3080/api/providers` was followed straight to
 * the console's own API — which returns the stored provider keys. Redirects are
 * therefore followed by hand and re-validated against the private-address rules.
 */
async function fetchText(url, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let current = String(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(current);
      const res = await fetch(current, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
        signal: ac.signal,
        redirect: 'manual'
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        try { res.body?.cancel(); } catch { /* ignore */ }
        if (!loc) throw new Error(`HTTP ${res.status} without a Location header`);
        current = new URL(loc, current).href;
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await readCapped(res);
    }
    throw new Error('too many redirects');
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Web search — multi-engine fallback chain (no API key required):
//   1. Bing HTML   2. DuckDuckGo lite   3. DDG Instant Answer API
// ---------------------------------------------------------------------------
function decodeBingUrl(url) {
  // Bing wraps links as https://www.bing.com/ck/a?...&u=a1<base64url(real url)>
  const m = String(url).match(/[?&]u=a1([^&]+)/);
  if (!m) return url;
  try {
    let s = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64').toString('utf8');
  } catch { return url; }
}

function parseBing(htmlSrc, max) {
  const results = [];
  const linkRe = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(htmlSrc)) && links.length < max) {
    const url = decodeBingUrl(decodeEntities(m[1]));
    const title = decodeEntities(stripTags(m[2])).trim();
    if (title && /^https?:\/\//.test(url)) links.push({ title, url });
  }
  const snippets = [];
  const snipRe = /<div class="b_caption"[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = snipRe.exec(htmlSrc)) && snippets.length < max) {
    snippets.push(decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim());
  }
  links.forEach((l, i) => results.push({ ...l, snippet: snippets[i] || '' }));
  return results;
}

function parseDDGLite(html, max) {
  const results = [];
  const links = [];
  const linkRe = /<a[^>]+href="\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)[^"]*"[^>]*>([\s\S]+?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && links.length < max) {
    const url = decodeEntities(decodeURIComponent(m[1]));
    const title = decodeEntities(stripTags(m[2])).trim();
    if (title && url) links.push({ title, url });
  }
  const snippets = [];
  const snipRe = /<td class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/g;
  while ((m = snipRe.exec(html)) && snippets.length < max) {
    snippets.push(decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim());
  }
  links.forEach((l, i) => results.push({ ...l, snippet: snippets[i] || '' }));
  return results;
}

function parseDDGHtml(html, max) {
  const results = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]+?)<\/a>/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) && links.length < max) {
    let url = decodeEntities(m[1]);
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const title = decodeEntities(stripTags(m[2])).trim();
    if (title && url) links.push({ title, url });
  }
  const snippets = [];
  const snipRe = /<a[^>]+class="result__snippet"[\s\S]*?>([\s\S]*?)<\/a>/g;
  while ((m = snipRe.exec(html)) && snippets.length < max) {
    snippets.push(decodeEntities(stripTags(m[1])).replace(/\s+/g, ' ').trim());
  }
  links.forEach((l, i) => results.push({ ...l, snippet: snippets[i] || '' }));
  return results;
}

async function instantAnswers(q, max) {
  // The abort timer is held so it can be cleared. Leaving it referenced kept the
  // event loop alive for ten seconds per call, and the fallback chain can make
  // several of these in a row.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  let res;
  try {
    res = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: ac.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const results = [];
  if (j.AbstractText && j.AbstractURL) {
    results.push({ title: j.Heading || j.AbstractURL, url: j.AbstractURL, snippet: j.AbstractText });
  }
  for (const topic of j.RelatedTopics || []) {
    if (results.length >= max) break;
    const t = topic.Topics ? topic.Topics[0] : topic;
    if (t?.FirstURL && t?.Text) results.push({ title: t.Text.split(' - ')[0].slice(0, 90), url: t.FirstURL, snippet: t.Text });
  }
  return results;
}

async function webSearch({ query, max_results = 6 }) {
  if (!query || !String(query).trim()) return { ok: false, output: 'Error: query is required' };
  const q = encodeURIComponent(String(query).trim());
  const max = Math.min(Number(max_results) || 6, 10);
  let results = [];

  // Engine 1: Bing HTML
  try {
    const html = await fetchText(`https://www.bing.com/search?q=${q}&count=${max}`);
    results = parseBing(html, max);
  } catch { /* try next */ }
  // Engine 2: DuckDuckGo lite / html
  if (!results.length) {
    try {
      const html = await fetchText(`https://lite.duckduckgo.com/lite/?q=${q}`);
      results = parseDDGLite(html, max);
    } catch { /* try next */ }
  }
  if (!results.length) {
    try {
      const html = await fetchText(`https://html.duckduckgo.com/html/?q=${q}`);
      results = parseDDGHtml(html, max);
    } catch { /* try next */ }
  }
  // Engine 3: DuckDuckGo instant answers
  if (!results.length) {
    try { results = await instantAnswers(q, max); } catch { /* give up */ }
  }

  if (!results.length) {
    return { ok: false, output: `Error: no results found (or search is temporarily unavailable) for "${query}"` };
  }
  const out = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n');
  return { ok: true, output: `Web results for "${query}":\n\n${out}` };
}

// Blocks the fetch_url tool from being pointed at the machine it runs on or at
// a private network. The tool's input is model-authored and the model can be
// steered by the content of a page it just read, so without this a fetched page
// could talk it into reading /api/files/raw or a cloud metadata endpoint.
//
// Purely lexical matching was not enough: `[::ffff:127.0.0.1]`, `localhost.`,
// `fec0::1` and `127.0.0.1.nip.io` all slipped through, and an unparseable
// octet (`.999`) failed OPEN. Anything unparseable now fails closed, and
// assertPublicUrl additionally resolves the name and re-checks the real address.
function ipIsPrivate(ip) {
  const addr = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0].trim();
  if (!addr) return true;

  if (addr.includes(':')) {
    // An IPv4-mapped address must be judged by the IPv4 address inside it, or
    // `::ffff:127.0.0.1` reads as an ordinary (public-looking) IPv6 literal.
    const dotted = addr.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
    if (dotted) return ipIsPrivate(dotted[1]);
    const hexMapped = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return ipIsPrivate([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
    }
    if (addr === '::1' || addr === '::') return true;         // loopback / unspecified
    if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;         // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;         // fe80::/10 link-local
    if (/^fec[0-9a-f]:/.test(addr)) return true;              // fec0::/10 site-local
    return false;
  }

  const m = addr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;                                       // a hostname — DNS decides
  const octets = m.slice(1).map(Number);
  if (octets.some(n => n > 255)) return true;                 // malformed → fail closed
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;                      // 192.0.0.0/24, 192.0.2.0/24
  if (a === 100 && b >= 64 && b <= 127) return true;          // carrier-grade NAT
  if (a >= 224) return true;                                  // multicast + reserved
  return false;
}

function isPrivateHost(hostname) {
  // "localhost." is the same host as "localhost" — a trailing dot must not slip
  // past the suffix checks.
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (h.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return ipIsPrivate(h);
  return false;
}

/**
 * Rejects a URL whose host is local or private — including one that only
 * becomes private after DNS resolution (any `*.nip.io`-style name pointing at
 * loopback) or after an HTTP redirect.
 */
async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new Error('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http(s) URLs can be fetched');
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(`${u.hostname} is a local or private address`);
  }
  let addrs;
  try {
    addrs = await dns.lookup(u.hostname, { all: true });
  } catch {
    throw new Error(`could not resolve ${u.hostname}`);
  }
  for (const a of addrs) {
    if (ipIsPrivate(a.address)) {
      throw new Error(`${u.hostname} resolves to the private address ${a.address}`);
    }
  }
  return u;
}

async function fetchUrl({ url, chatId } = {}) {
  if (!url || !/^https?:\/\//i.test(String(url))) {
    return { ok: false, output: 'Error: a valid http(s) url is required' };
  }
  try {
    // Validated here as well as inside fetchText so the user gets a clear
    // message instead of a generic fetch failure.
    await assertPublicUrl(String(url));
    let html = await fetchText(String(url), 15000);
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ');
    const text = decodeEntities(stripTags(html))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    // A long article is worth far more than the first 7,000 characters, and the
    // part worth reading is rarely at the top. Keep a preview inline and leave
    // the whole page on disk for the model to read or search.
    const bounded = spill.boundResult({
      chatId,
      label: 'fetch_url',
      suggestedName: 'fetched-page.txt',
      text,
      maxBytes: 7000
    });
    return {
      ok: true,
      output: `Content of ${url}:\n\n${bounded.text}`,
      meta: bounded.spilled ? { spilled: bounded.spilled.locator, spilledBytes: bounded.spilled.bytes } : undefined
    };
  } catch (e) {
    return { ok: false, output: `Error fetching ${url}: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// File tools (sandboxed to WORKSPACE_DIR)
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// A trailing newline is a terminator, not an extra empty line — otherwise every
// file would read one line longer than it is and the `+N −M` on an edit row
// would be off by one for the most common case.
function countLines(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const n = s.split('\n').length;
  return s.endsWith('\n') ? n - 1 : n;
}

// Every tool that touches the workspace returns a `meta` object alongside its
// human-readable `output`. The output string is what the model reads; `meta` is
// what the UI renders, so a tool row can say "Created src/App.tsx · 142 lines"
// without the client having to parse prose or, worse, re-render the arguments
// (which for write_file contain the entire file).
function withMeta(result, meta) {
  return meta ? { ...result, meta } : result;
}

// The ± counts for an edit row. Lines, not characters: "−4 +12" is something a
// reader can size up at a glance, and it matches how the diff body renders.
function editMeta(find, replace, replacements, next, preview = null) {
  return {
    replacements,
    removed: countLines(find),
    added: countLines(replace),
    lines: countLines(next),
    // The exact lines that changed, for the row's expandable diff body. Kept in
    // meta (never sent to a provider), so the visible transcript and the model's
    // context stay bounded no matter how large the edit was.
    ...(preview && preview.diff ? { diff: preview.diff, diffTruncated: preview.truncated } : {})
  };
}

function listFiles({ path: rel = '', chatId } = {}) {
  try {
    const base = resolveBaseDir(chatId);
    const root = safePath(rel, chatId);
    const lines = [];
    let count = 0;
    const MAX = 300;
    (function walk(dir, depth) {
      if (depth > 4 || count >= MAX) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (count >= MAX) return;
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        const relPath = path.relative(base, full).split(path.sep).join('/');
        const pad = '  '.repeat(depth);
        if (e.isDirectory()) {
          lines.push(`${pad}📁 ${e.name}/`);
          count++;
          walk(full, depth + 1);
        } else {
          let size = 0;
          try { size = fs.statSync(full).size; } catch { /* ignore */ }
          lines.push(`${pad}📄 ${relPath === e.name ? e.name : e.name}  (${fmtBytes(size)})  — ${relPath}`);
          count++;
        }
      }
    })(root, 0);
    if (!lines.length) return { ok: true, output: `Workspace${rel ? ` (${rel})` : ''} is empty.`, meta: { count: 0 } };
    return {
      ok: true,
      output: `Workspace contents${rel ? ` of ${rel}` : ''} (${count} entries):\n\n${lines.join('\n')}${count >= MAX ? '\n…[truncated]' : ''}`,
      meta: { count }
    };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

function grepFiles({ pattern, path: rel = '', max_results, chatId } = {}) {
  try {
    if (!pattern || !String(pattern).trim()) return { ok: false, output: 'Error: pattern is required' };
    const patternText = String(pattern);
    if (patternText.length > 500) return { ok: false, output: 'Error: the pattern is too long.' };
    // A quantifier applied to a group that itself contains one — `(a+)+$` — is
    // the classic catastrophic-backtracking shape, and this runs on the server's
    // only thread against large files. Rejected rather than risk a hung process.
    if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(patternText)) {
      return { ok: false, output: 'Error: that pattern can backtrack catastrophically. Simplify it (avoid a quantifier around a group that already has one).' };
    }
    let re;
    try { re = new RegExp(patternText, 'i'); } catch (e) { return { ok: false, output: `Error: invalid regular expression: ${e.message}` }; }

    const base = resolveBaseDir(chatId);
    const root = safePath(rel, chatId);
    if (!fs.existsSync(root)) return { ok: false, output: `Error: not found: ${rel || 'workspace'}` };

    const MAX = Math.max(1, Math.min(Number(max_results) || 60, 200));
    const TEXT_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|css|scss|less|html|htm|json|md|txt|yml|yaml|xml|csv|py|rb|go|rs|java|c|cpp|h|hpp|php|sh|bash|sql|toml|ini|cfg|conf|log|svg|vue|svelte|kt|swift)$/i;
    const MAX_FILE_BYTES = 400000;
    const hits = [];
    const filesWithHits = new Set();
    let filesScanned = 0;

    const seenDirs = new Set();
    const walk = (target, depth) => {
      if (hits.length >= MAX || depth > 12) return;
      let st;
      try { st = fs.statSync(target); } catch { return; }
      if (st.isDirectory()) {
        // statSync follows links, so a junction pointing at an ancestor used to
        // recurse until the stack overflowed. Visiting each real directory only
        // once breaks every such cycle, and the depth cap bounds the rest.
        let key = target;
        try { key = (fs.realpathSync.native || fs.realpathSync)(target); } catch { /* keep the literal path */ }
        if (seenDirs.has(key)) return;
        seenDirs.add(key);
        let entries;
        try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (hits.length >= MAX) return;
          if (e.name.startsWith('.') || e.name === 'node_modules') continue;
          walk(path.join(target, e.name), depth + 1);
        }
        return;
      }
      if (!TEXT_EXT.test(target) || st.size > MAX_FILE_BYTES) return;
      let content;
      try { content = fs.readFileSync(target, 'utf8'); } catch { return; }
      filesScanned++;
      const relPath = path.relative(base, target).split(path.sep).join('/');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= MAX) return;
        if (re.test(lines[i])) {
          hits.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          filesWithHits.add(relPath);
        }
      }
    };
    walk(root, 0);

    if (!hits.length) {
      return {
        ok: true,
        output: `No matches for /${pattern}/ in ${rel || 'the workspace'} (${filesScanned} file(s) scanned).`,
        meta: { matches: 0, files: 0 }
      };
    }
    return {
      ok: true,
      output: `${hits.length} match(es) for /${pattern}/ in ${filesWithHits.size} file(s):\n\n${hits.join('\n')}${hits.length >= MAX ? '\n…[truncated]' : ''}`,
      meta: { matches: hits.length, files: filesWithHits.size }
    };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

/**
 * Reads a workspace file, in full or one numbered window of it.
 *
 * The window is what makes a large file usable with a bounded context: a
 * 4000-line log used to arrive as the first 20000 characters and nothing else,
 * so every question about its end meant asking the user. With `offset`/`limit`
 * the model pages through it instead, and the numbering it gets back is what it
 * needs to ask for the next window.
 *
 * @param {object} request - the read.
 * @param {string} request.path - workspace-relative file.
 * @param {string|null} [request.chatId] - owning conversation.
 * @param {number} [request.offset] - 1-based first line of a window.
 * @param {number} [request.limit] - how many lines the window holds.
 * @returns {{ok: boolean, output: string, meta?: object}}
 */
function readFile({ path: rel, chatId, offset, limit } = {}) {
  try {
    if (!rel) return { ok: false, output: 'Error: path is required' };
    const full = safePath(rel, chatId);
    if (!fs.existsSync(full)) return { ok: false, output: `Error: file not found: ${rel}` };
    if (fs.statSync(full).isDirectory()) return { ok: false, output: `Error: ${rel} is a directory. Use list_files instead.` };
    const content = fs.readFileSync(full, 'utf8');

    const wantsWindow = offset !== undefined || limit !== undefined;
    if (wantsWindow) {
      const lines = content.split(/\r?\n/);
      const total = lines.length;
      const start = Math.max(1, Math.min(Number(offset) || 1, total));
      const count = Math.max(1, Math.min(Number(limit) || 200, 1000));
      const end = Math.min(total, start + count - 1);
      const width = String(end).length;
      const body = lines
        .slice(start - 1, end)
        .map((line, index) => String(start + index).padStart(width, ' ') + '\t' + line)
        .join('\n');
      const more = end < total
        ? `\n\n…[${total - end} more line(s). Read the next window with offset: ${end + 1}.]`
        : '';
      return withMeta(
        {
          ok: true,
          output: `Lines ${start}-${end} of ${total} in ${rel}:\n\n${body}${more}`
        },
        { lines: end - start + 1, totalLines: total, offset: start, windowed: true, bytes: Buffer.byteLength(content) }
      );
    }

    const cap = 20000;
    const meta = { lines: countLines(content), bytes: Buffer.byteLength(content) };
    const truncated = content.length > cap;
    if (truncated) {
      // The hint is the difference between a model that asks for the rest and
      // one that guesses: it names the exact next call.
      meta.truncated = true;
      meta.totalLines = countLines(content);
      return {
        ok: true,
        output: content.slice(0, cap)
          + `\n\n…[truncated — the file is ${content.length} characters over ${meta.totalLines} lines]`
          + `\nRead it in windows with read_file({ "path": "${rel}", "offset": 1, "limit": 200 }), or search it with grep.`,
        meta
      };
    }
    return { ok: true, output: content || '(empty file)', meta };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

/**
 * Writes a file, or appends to one.
 *
 * `append` exists because of a hard ceiling that is easy to miss: a file is
 * built inside ONE model response, so a file longer than that response allows
 * cannot be written at all. A 3000-line implementation is simply not
 * expressible in a single tool call, no matter how good the model is. With
 * append, the model writes the first part and then extends it in as many
 * further calls as it needs — which is what makes a genuinely large file
 * possible instead of a stub.
 *
 * Appending rather than overwriting also means a long file can be revised
 * section by section without ever needing to reproduce the whole thing.
 *
 * @param {object} request - the write.
 * @param {string} request.path - workspace-relative file.
 * @param {string} [request.content] - the body.
 * @param {boolean} [request.append] - add to the end instead of replacing.
 * @param {string|null} [request.chatId] - owning conversation.
 * @returns {{ok: boolean, output: string, meta?: object}}
 */
function writeFile({ path: rel, content = '', append = false, chatId } = {}) {
  try {
    if (!rel) return { ok: false, output: 'Error: path is required' };
    const full = safePath(rel, chatId);
    // Captured before the write: "Created" vs "Updated" is the one thing the row
    // cannot recover from the result text, which reads "Wrote 4.7 KB to …" either way.
    const existed = fs.existsSync(full);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const body = String(content);
    const wantsAppend = append === true || String(append).toLowerCase() === 'true';

    if (wantsAppend) {
      if (!existed) {
        return {
          ok: false,
          output: `Error: cannot append to ${rel} — the file does not exist yet. Write it first with write_file (no append), then extend it.`
        };
      }
      const before = fs.readFileSync(full, 'utf8');
      // Join without inventing a blank line: the caller's content ends where it
      // ends. A missing newline is added only when the existing file lacks one,
      // so a section never gets glued onto the previous line.
      const needsNewline = before.length > 0 && !before.endsWith('\n');
      const addition = (needsNewline ? '\n' : '') + body;
      const next = before + addition;
      fs.appendFileSync(full, addition);
      const bytes = Buffer.byteLength(addition);
      return withMeta(
        {
          ok: true,
          output: `Appended ${fmtBytes(bytes)} to ${rel} — it is now ${fmtBytes(Buffer.byteLength(next))} over ${countLines(next)} lines.`
        },
        { appended: true, created: false, bytes, totalBytes: Buffer.byteLength(next), lines: countLines(next) }
      );
    }

    fs.writeFileSync(full, body);
    const bytes = Buffer.byteLength(body);
    return withMeta(
      { ok: true, output: `Wrote ${fmtBytes(bytes)} to ${rel}` },
      { created: !existed, bytes, lines: countLines(body) }
    );
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

/**
 * The keys a model uses to name a file inside an entry.
 *
 * All four have been observed in real tool calls; a payload that names its file
 * `file_path` is not malformed, it is a different dialect of the same request.
 */
const PATH_KEYS = ['path', 'file_path', 'filepath', 'filename', 'file', 'name'];
/** The keys that carry an entry's body, best first. */
const CONTENT_KEYS = ['content', 'contents', 'text', 'body', 'data', 'code', 'source'];

/** Reads a value that is, or should be, a string. */
function asText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // An object or array in a body position is JSON — that is what the model
  // meant, and `String(value)` would write `[object Object]` instead.
  try { return JSON.stringify(value, null, 2); } catch { return null; }
}

/** The usable path of an entry, or null when it does not name one. */
function entryPath(entry) {
  for (const key of PATH_KEYS) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

/**
 * The body of an entry: the first content key that carries usable text.
 *
 * Text only. An object under a content key is either a nested wrapper around
 * the real body or a JSON body, and {@link resolveContent} is what tells those
 * apart — this function must not guess, because serialising the wrapper is
 * exactly the bug that made `{ content: { content: "…" } }` write the wrapper.
 */
function entryContent(entry) {
  for (const key of CONTENT_KEYS) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    return String(value);
  }
  return '';
}

/**
 * The content of a map value that is itself an entry object.
 *
 * A map's value is addressed by its KEY, so the object is a body carrier and
 * nothing else: `{ "a.py": { content: "print(1)" } }` means the file holds
 * `print(1)`, never the wrapper serialised. That is also why the value's own
 * keys are never treated as a path — `content` happens to be one of the path
 * keys this module accepts, and letting it be read as one here is what made the
 * wrapper win over the text.
 *
 * @param {unknown} value - the map value.
 * @returns {string} the body to write.
 */
function innerContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object' || Array.isArray(value)) return asText(value) ?? '';
  const text = entryContent(value);
  if (text !== '') return text;
  for (const key of CONTENT_KEYS) {
    const nested = value[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const inner = entryContent(nested);
      if (inner !== '') return inner;
    }
  }
  // No text anywhere inside: the object IS the file (a JSON document).
  return asText(value) ?? '';
}

/**
 * The body for one entry, in the order a model's intent can be inferred.
 *
 * 1. A content key holding text is the body.
 * 2. A content key holding an object whose own content key holds text is a
 *    nested wrapper — `{ content: { content: "…" } }` — and the inner text wins.
 * 3. A content key holding an object with no text inside it, on an entry that
 *    names a file, is a JSON body: `{ path: "package.json", content: {…} }`.
 * 4. No content key holds anything, so the body is the entry itself. That only
 *    happens in the map form, where the KEY is the path and the VALUE is a whole
 *    object: `{ "package.json": { "name": "x" } }`.
 *
 * @param {object} entry - one entry, already known to be an object.
 * @param {boolean} contentOnly - true for a map value, whose keys never name a file.
 * @returns {{path: string|null, content: string}} the entry's file and body.
 */
function resolveContent(entry, contentOnly = false) {
  const path = contentOnly ? null : entryPath(entry);

  for (const key of CONTENT_KEYS) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object') return { path, content: String(value) };
  }
  for (const key of CONTENT_KEYS) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) || typeof value !== 'object') continue;
    const inner = entryContent(value);
    if (inner !== '') return { path, content: inner };
  }
  for (const key of CONTENT_KEYS) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object') continue;
    // No text inside the object. On a named entry it is the body; on an
    // anonymous one the key cannot be what the model meant, so fall through.
    if (path !== null) return { path, content: asText(value) ?? '' };
  }
  return { path, content: path === null ? (asText(entry) ?? '') : '' };
}

/** One entry as `{ path, content }`, with `path` null when it names no file. */
function normalizeEntry(entry) {
  return resolveContent(entry);
}

/**
 * Accepts every shape a model actually sends for a multi-file write.
 *
 * The text-protocol engines have no schema validation, so `files` arrives in
 * whatever shape the model felt like, and every shape below has appeared in a
 * real tool call:
 *
 *   [{ path, content }, …]          the documented form
 *   '{"files":[…]}-as-a-string'     the whole argument JSON-encoded
 *   { path, content }               one file at the top level
 *   { "index.html": "…", "a.css": "…" }   a path→content MAP
 *   { "index.html": { content, … } }      a map whose values are objects
 *   [{ filename, code }, …]         different key names for the same two things
 *
 * The map form is the one that mattered most: a model building a small site
 * naturally sends an object keyed by filename, and reading that as a single
 * entry with no `path` rejected the whole call with "no entry had a path" —
 * which is exactly what happened, repeatedly, on a request that was perfectly
 * clear. Rejecting a clear request is worse than accepting a sloppy one here:
 * the workspace is the user's, and every path still goes through safePath.
 *
 * @param {unknown} files - whatever arrived in the `files` argument.
 * @returns {{list: Array<{path: string|null, content: string}>, rejected: number}|null}
 *   `rejected` counts entries that carried something but named no file, so a
 *   partially-usable batch can still be written and honestly reported.
 */
/**
 * Makes a JSON document whose string bodies contain raw line breaks parseable.
 *
 * A model writing `{"index.html": "<!doctype html>\n<body>…"}` frequently emits
 * literal newlines inside the string instead of `\n`, which is not JSON — the
 * spec forbids unescaped control characters in a string. `JSON.parse` rejects
 * the whole document, so a call carrying five complete files fails on a
 * formatting slip that has nothing to do with what the user asked for.
 *
 * The repair escapes control characters only INSIDE string literals, tracking
 * quote state and backslash escapes so a structural newline between entries is
 * left alone. It is a repair, not a validator: anything it cannot make sense of
 * still fails JSON.parse and falls through to the tolerant parser.
 *
 * @param {string} text - the document as the model emitted it.
 * @returns {string} the document with in-string control characters escaped.
 */
function repairJsonControlChars(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      const code = text.charCodeAt(i);
      if (code === 0x09) { out += '\\t'; continue; }
      if (code === 0x0a) { out += '\\n'; continue; }
      if (code === 0x0d) { out += '\\r'; continue; }
      if (code < 0x20) { out += '\\u' + code.toString(16).padStart(4, '0'); continue; }
    }
    out += ch;
  }
  return out;
}

/**
 * Last-resort parser for the one shape a model actually emits by hand: a flat
 * JSON object mapping a filename to a body.
 *
 * When the bodies are large and pasted verbatim, a single unescaped quote or a
 * line break can defeat both `JSON.parse` and {@link repairJsonControlChars},
 * and the tolerant parser is what still recovers five files instead of failing
 * the call. It deliberately understands ONLY `{"key": "value", …}` with string
 * values — it is not a JSON parser and must not be used as one — and it stops
 * at the first construct outside that grammar, returning null so the caller can
 * report the shape it expected rather than write a half-parsed project.
 *
 * @param {string} text - the document.
 * @returns {Object<string, string>|null} the recovered map, or null.
 */
function parseFlatStringMap(text) {
  const source = String(text).trim();
  if (source[0] !== '{' || source[source.length - 1] !== '}') return null;
  const body = source.slice(1, -1);
  const map = {};
  let i = 0;
  let entries = 0;

  const skipSpace = () => { while (i < body.length && /\s/.test(body[i])) i++; };
  /** Reads a quoted string, honouring backslash escapes and closing on the first real quote. */
  const readQuoted = () => {
    if (body[i] !== '"') return null;
    i++;
    let out = '';
    while (i < body.length) {
      const ch = body[i];
      if (ch === '\\') {
        const next = body[i + 1];
        if (next === undefined) break;
        const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[next];
        if (simple !== undefined) { out += simple; i += 2; continue; }
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(body.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += next; // an escape JSON would reject: keep the character it meant
        i += 2;
        continue;
      }
      if (ch === '"') { i++; return out; }
      out += ch;
      i++;
    }
    return null; // unterminated
  };

  while (i < body.length) {
    skipSpace();
    if (i >= body.length) break;
    if (body[i] === ',') { i++; continue; }
    const key = readQuoted();
    if (key === null) return null;
    skipSpace();
    if (body[i] !== ':') return null;
    i++;
    skipSpace();
    const value = readQuoted();
    if (value === null) return null;
    map[key] = value;
    entries++;
  }
  return entries ? map : null;
}

/**
 * Records a short, content-free description of a rejected `files` argument.
 *
 * When `write_files` refuses a payload the model thought was fine, the turn
 * often does not survive to the transcript, so there is nothing left to inspect
 * afterwards. This writes the SHAPE of what arrived — never file contents — to
 * `data/tool-rejects.log` so the failure can be diagnosed from the machine
 * instead of reproduced blindly.
 *
 * Keys are listed (they are file paths, which are not secrets); values are
 * reduced to a length and a short preview, and a preview is omitted entirely
 * for a value long enough to be a file body.
 *
 * @param {unknown} files - the value that was rejected.
 * @param {object} context - how it arrived.
 * @param {string} [context.tool] - tool name.
 * @param {string} [context.reason] - why it was rejected.
 * @param {string} [context.chatId] - owning conversation.
 * @returns {string} the one-line summary, also written to the log.
 */
function noteRejectedFiles(files, { tool = 'write_files', reason = 'unnamed', chatId = null } = {}) {
  const describeValue = (value) => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array[' + value.length + ']';
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      return 'object{' + keys.slice(0, 12).join(', ') + (keys.length > 12 ? ',…' : '') + '}';
    }
    if (typeof value === 'string') {
      // A long string is a file body, not a filename — do not log any of it.
      return value.length > 120
        ? 'string(' + value.length + ' chars, body omitted)'
        : 'string(' + JSON.stringify(value.slice(0, 120)) + ')';
    }
    return typeof value + '(' + String(value) + ')';
  };

  let detail = describeValue(files);
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    const keys = Object.keys(files);
    if (keys.length) {
      const sample = keys.slice(0, 3).map((k) => {
        const v = files[k];
        const vs = typeof v === 'string' ? 'string(' + v.length + ')' : describeValue(v);
        return JSON.stringify(k.slice(0, 60)) + '→' + vs;
      }).join(', ');
      detail += ' sample: ' + sample;
    }
  } else if (Array.isArray(files) && files.length) {
    detail += ' first: ' + describeValue(files[0]);
  }

  // A long STRING is the interesting case: the model meant JSON and something
  // in it defeated every parser. Head and tail are enough to identify which —
  // a stray fence, a truncation, or an unescaped quote — without logging a
  // whole file body into a diagnostic file.
  let excerpt = '';
  if (typeof files === 'string' && files.length > 120) {
    const head = files.slice(0, 400);
    const tail = files.slice(-400);
    excerpt = '\n  head: ' + JSON.stringify(head)
      + '\n  tail: ' + JSON.stringify(tail)
      + '\n  attempts: ' + describeParseAttempts(files);
    // The whole value is kept once, next to the log, so the next occurrence can
    // be replayed through the parser instead of waiting for another failed run.
    // It is a diagnostic artifact, not state: nothing reads it except a human.
    try {
      const dir = store.DATA_DIR || path.dirname(store.WORKSPACE_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'last-rejected-files.json'), files);
    } catch { /* best effort */ }
  }

  const line = new Date().toISOString() + '  ' + tool + '  [' + reason + ']'
    + (chatId ? '  chat=' + chatId : '') + '  files=' + detail + excerpt;
  try {
    // Beside the other state files, which is where someone will look for it.
    const dir = store.DATA_DIR || path.dirname(store.WORKSPACE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'tool-rejects.log'), line + '\n');
  } catch { /* diagnostics must never break a tool call */ }
  return line;
}

/**
 * Reports which recovery attempts a rejected string survives, so the next
 * failure says what is wrong with the value rather than only that it failed.
 *
 * @param {string} text - the rejected value.
 * @returns {string} a compact summary of each attempt.
 */
function describeParseAttempts(text) {
  const attempt = (label, fn) => {
    try {
      const value = fn();
      if (value === null || value === undefined) return label + '=null';
      if (typeof value === 'object') {
        const keys = Array.isArray(value) ? value.length + ' items' : Object.keys(value).length + ' keys';
        return label + '=ok(' + keys + ')';
      }
      return label + '=' + typeof value;
    } catch (e) {
      return label + '=throw(' + String(e.message).slice(0, 60) + ')';
    }
  };
  return [
    attempt('raw', () => JSON.parse(text)),
    attempt('fence', () => JSON.parse(unwrapCodeFence(text))),
    attempt('span', () => JSON.parse(extractJsonSpan(text))),
    attempt('ctlFix', () => JSON.parse(repairJsonControlChars(text))),
    attempt('tolerant', () => parseFlatStringMap(text))
  ].join(' ');
}

/**
 * Turns one `files` value into usable entries, unwrapping however many layers of
 * JSON string it arrived in.
 *
 * @param {string} text - a string value from the `files` argument.
 * @returns {unknown} the parsed value, or null when it cannot be recovered.
 */
/**
 * The first complete JSON object or array buried in a longer string.
 *
 * A text-protocol engine narrates before it sends: `<|DSML|parameter
 * name="files">Here are the files:\n{"a.txt": "…"}</|DSML|parameter>`. The JSON
 * is correct; the sentence in front of it made the whole value unparseable, so
 * the tool refused a call the model had written properly. This walks from the
 * first `{` or `[` to its matching close, honouring string literals and escapes,
 * and returns just that span.
 *
 * A truncated value has no matching close, so nothing is returned — that case is
 * a genuinely incomplete payload and must not be guessed at.
 *
 * @param {string} text - the raw value.
 * @returns {string|null} the balanced JSON span, or null when there is none.
 */
function extractJsonSpan(text) {
  const source = String(text);
  const start = source.search(/[[{]/);
  if (start === -1) return null;
  const open = source[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/** Removes one Markdown code fence around a value, if there is one. */
function unwrapCodeFence(raw) {
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(String(raw).trim());
  return fenced ? fenced[1].trim() : String(raw);
}

function parseFilesString(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  // A model that wrote the argument as JSON but wrapped it in a Markdown code
  // fence (```json … ```) produces a value that is not JSON at all. The DSML
  // parser unwraps that before it gets here, but a native engine can send the
  // same thing as a tool argument, so the fence is removed here too.
  const candidate = unwrapCodeFence(trimmed);
  if (!candidate) return null;

  // In order of how likely each is to be the model's real intent: the value as
  // written, the value with control characters escaped, the value with any
  // narration around it removed, then the tolerant flat-map reader.
  const attempts = [
    candidate,
    repairJsonControlChars(candidate),
    extractJsonSpan(candidate),
    extractJsonSpan(repairJsonControlChars(candidate))
  ];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      const parsed = JSON.parse(attempt);
      if (parsed === text) continue; // a JSON string that is only itself
      return parsed;
    } catch { /* next attempt */ }
  }
  return parseFlatStringMap(candidate);
}

function normalizeFiles(files) {
  let value = files;
  // A JSON string can contain another JSON string. The text-protocol engines
  // produce exactly that: the model emits the `files` argument as a quoted JSON
  // *string* whose content is the map or array it meant, so one unwrap still
  // leaves a string. A string that cannot be recovered at all ends the loop as a
  // rejection rather than a guess.
  for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) {
    const parsed = parseFilesString(value);
    if (parsed === null) return null;
    value = parsed;
  }
  if (value === null || value === undefined) return null;

  // A bare object may be ONE file or a MAP of path → content. The presence of a
  // path key is what distinguishes them; without one, every string key is a file.
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (entryPath(value) !== null) return { list: [normalizeEntry(value)], rejected: 0 };
    const mapped = [];
    for (const [key, body] of Object.entries(value)) {
      if (!key.trim()) continue;
      // The KEY is the path, so the value is content only — its own keys must
      // never be read as a path (`{ "a.py": { content: "…" } }`).
      mapped.push({ path: key.trim(), content: innerContent(body) });
    }
    return mapped.length ? { list: mapped, rejected: 0 } : null;
  }

  if (!Array.isArray(value)) return null;

  const list = [];
  let rejected = 0;
  for (const item of value) {
    // A positional pair — ["a.txt", "content"] — is a shape the model sends when
    // it is thinking of a list of tuples rather than a list of objects.
    if (Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string') {
      list.push({ path: item[0].trim(), content: asText(item[1]) ?? '' });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const entry = normalizeEntry(item);
    if (entry.path === null) { rejected++; continue; }
    list.push(entry);
  }
  if (!list.length) {
    if (rejected) {
      return {
        list: [],
        rejected,
        // Content arrived, but nothing in it named a file. Saying "nothing to
        // write" here hides the actual mistake; naming it is what lets the
        // model correct itself on the next call instead of retrying blindly.
        reason: 'no entry had a "path". Every entry needs a workspace-relative path: '
          + '{"files": [{"path": "a.txt", "content": "…"}]} — or key the files by path: {"files": {"a.txt": "…"}}.'
      };
    }
    return null;
  }
  return { list, rejected };
}

function writeFiles({ files = [], path: singlePath, content: singleContent, chatId } = {}) {
  try {
    let normalized = normalizeFiles(files);
    // One file sent at the top level is an unambiguous request, not an error.
    if ((!normalized || !normalized.list.length) && singlePath !== undefined) {
      normalized = { list: [{ path: String(singlePath), content: asText(singleContent) ?? '' }], rejected: 0 };
    }
    if (!normalized || !normalized.list.length) {
      // The payload was refused. Its shape is recorded so the next occurrence can
      // be diagnosed from the machine rather than reproduced by hand — the turn
      // often does not survive to the transcript, which is why the last one left
      // nothing to inspect. The result only points at the log; the detail lives
      // there so it never inflates what the model has to read.
      noteRejectedFiles(files, {
        reason: normalized && normalized.reason ? 'no-path' : 'unreadable',
        chatId
      });
      return {
        ok: false,
        output: 'Error: ' + (normalized && normalized.reason
          ? normalized.reason
          : 'nothing to write. Send {"files": [{"path": "index.html", "content": "<!doctype html>…"}, …]} — '
            + 'or a map, {"files": {"index.html": "<!doctype html>…", "style.css": "…"}} — or use write_file for a single file.')
          + ' (the shape of what arrived was recorded in data/tool-rejects.log)'
      };
    }

    const results = [];
    const written = [];
    let missingPath = normalized.rejected || 0;
    for (const f of normalized.list) {
      // An entry with no path used to be skipped silently, so a malformed call
      // reported "Successfully created 0 files" and the user was told it worked.
      if (!f.path) { missingPath++; continue; }
      const full = safePath(f.path, chatId);
      const existed = fs.existsSync(full);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // `|| ''` would turn a deliberate `0` or `false` body into an empty file;
      // an explicit empty string is already covered by the normalizer.
      const body = f.content === undefined || f.content === null ? '' : String(f.content);
      fs.writeFileSync(full, body);
      const bytes = Buffer.byteLength(body);
      results.push(`✓ ${f.path} (${fmtBytes(bytes)})`);
      written.push({ path: f.path, created: !existed, bytes, lines: countLines(body) });
    }

    if (!written.length) {
      return {
        ok: false,
        output: 'Error: no entry had a "path". Every entry needs a workspace-relative path: {"files": [{"path": "a.txt", "content": "…"}]} — '
          + 'or key the files by path: {"files": {"a.txt": "…"}}.'
      };
    }

    const note = missingPath ? `\n(Skipped ${missingPath} entr${missingPath === 1 ? 'y' : 'ies'} with no "path".)` : '';
    const noun = results.length === 1 ? 'file' : 'files';
    return withMeta(
      { ok: true, output: `Successfully created ${results.length} ${noun}:\n` + results.join('\n') + note },
      { files: written, count: written.length, ...missingPath ? { skipped: missingPath } : {} }
    );
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

function editFile({ path: rel, find, replace = '', replace_all = false, chatId } = {}) {
  try {
    if (!rel) return { ok: false, output: 'Error: path is required' };
    if (typeof find !== 'string' || find === '') return { ok: false, output: 'Error: "find" must be a non-empty string' };
    const full = safePath(rel, chatId);
    if (!fs.existsSync(full)) return { ok: false, output: `Error: file not found: ${rel}` };
    const original = fs.readFileSync(full, 'utf8');

    // 1. Direct exact match
    if (original.includes(find)) {
      const occurrences = original.split(find).length - 1;
      // A function replacement: String.replace with a *string* expands `$&`,
      // `` $` ``, `$'` and `$$`, so a replacement that legitimately contains one
      // of those (a regex `'$&'`, a shell `${x:-$'y'}`) was silently rewritten to
      // the matched text. The replace_all branch uses split/join and never did.
      const next = replace_all ? original.split(find).join(replace) : original.replace(find, () => replace);
      fs.writeFileSync(full, next);
      return withMeta(
        {
          ok: true,
          output: `Edited ${rel}: replaced ${replace_all ? occurrences : 1} of ${occurrences} occurrence(s). (${fmtBytes(Buffer.byteLength(original))} → ${fmtBytes(Buffer.byteLength(next))})`
        },
        editMeta(find, replace, replace_all ? occurrences : 1, next, diffKit.editPreview(original, next, rel))
      );
    }

    // 2. Line-ending normalized match (CRLF <-> LF tolerance for Windows)
    const normOrig = original.replace(/\r\n/g, '\n');
    const normFind = find.replace(/\r\n/g, '\n');
    const normRepl = replace.replace(/\r\n/g, '\n');

    if (normOrig.includes(normFind)) {
      const occurrences = normOrig.split(normFind).length - 1;
      const replaced = replace_all
        ? normOrig.split(normFind).join(normRepl)
        : normOrig.replace(normFind, () => normRepl);
      // `replaced` is derived from the LF-normalised copy, so writing it straight
      // out turned every CRLF in the file into LF while the row still reported a
      // single changed line — the whole file changed and the summary hid it.
      // The file's own convention wins.
      const eol = original.includes('\r\n') ? '\r\n' : '\n';
      const next = eol === '\n' ? replaced : replaced.replace(/\n/g, eol);
      fs.writeFileSync(full, next);
      return withMeta(
        {
          ok: true,
          output: `Edited ${rel} (normalized line endings): replaced ${replace_all ? occurrences : 1} of ${occurrences} occurrence(s). (${fmtBytes(Buffer.byteLength(original))} → ${fmtBytes(Buffer.byteLength(next))})`
        },
        editMeta(normFind, normRepl, replace_all ? occurrences : 1, next, diffKit.editPreview(original, next, rel))
      );
    }

    return {
      ok: false,
      output: `Error: the exact "find" text was not found in ${rel}. Please use read_file to inspect the current file content, copy the exact lines to replace, and call edit_file again.`
    };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

function deleteFile({ path: rel, confirm = false, chatId } = {}) {
  try {
    if (!rel) return { ok: false, output: 'Error: path is required' };
    const isConfirmed = confirm === true || String(confirm).trim().toLowerCase() === 'true';
    if (!isConfirmed) return { ok: false, output: 'Error: destructive action blocked — call again with confirm: true to proceed.' };
    const full = safePath(rel, chatId);
    // Refuse to delete the workspace root itself. `path: "."` (or "") resolves
    // to the base directory, and the recursive branch below would then wipe the
    // entire chat workspace — the one destructive action with no undo here.
    if (full === resolveBaseDir(chatId)) {
      return { ok: false, output: 'Error: refusing to delete the workspace root. Pass a path to a file or subfolder.' };
    }
    if (!fs.existsSync(full)) return { ok: false, output: `Error: not found: ${rel}` };
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
      return { ok: true, output: `Deleted directory ${rel}` };
    }
    fs.unlinkSync(full);
    return { ok: true, output: `Deleted file ${rel}` };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

function createDirectory({ path: rel, chatId } = {}) {
  try {
    if (!rel) return { ok: false, output: 'Error: path is required' };
    const full = safePath(rel, chatId);
    fs.mkdirSync(full, { recursive: true });
    return { ok: true, output: `Created directory ${rel}` };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

async function llamacoderGenerate({ prompt, model, save_path, chatId: appChatId } = {}) {
  try {
    if (!prompt || typeof prompt !== 'string') return { ok: false, output: 'Error: prompt is required' };
    const selectedModel = model || llamacoder.DEFAULT_MODEL;
    const { chatId, lastMessageId } = await llamacoder.createChat({
      prompt,
      model: selectedModel
    });

    const rawText = await llamacoder.streamCompletion({
      messageId: lastMessageId,
      model: selectedModel
    });

    const code = llamacoder.extractCode(rawText);
    const title = (await llamacoder.generateTitle(chatId)) || 'Generated App';

    let fileMsg = '';
    if (save_path) {
      const full = safePath(save_path, appChatId);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, code, 'utf8');
      fileMsg = `\nSaved directly to workspace file: "${save_path}" (${fmtBytes(Buffer.byteLength(code))}).`;
    }

    const preview = code.slice(0, 400) + (code.length > 400 ? '...' : '');
    return {
      ok: true,
      output: `Successfully generated "${title}" via LlamaCoder (${code.length} chars).${fileMsg}\nLive chat & preview: ${llamacoder.LLAMACODER_BASE}/chat/${chatId}\n\nCode Preview:\n\`\`\`\n${preview}\n\`\`\``
    };
  } catch (e) {
    return { ok: false, output: `LlamaCoder error: ${e.message}` };
  }
}

async function runScript({ path: rel, args = [], language, timeoutMs = 25000, chatId } = {}) {
  try {
    if (!rel) return { ok: false, output: 'Error: path is required' };
    const full = safePath(rel, chatId);
    if (!fs.existsSync(full)) return { ok: false, output: `Error: file not found: ${rel}` };
    if (fs.statSync(full).isDirectory()) return { ok: false, output: `Error: ${rel} is a directory.` };

    const ext = path.extname(full).toLowerCase();
    let cmd = 'node';
    let cmdArgs = [path.basename(full), ...(Array.isArray(args) ? args : [])];

    if (language === 'python' || ext === '.py') {
      cmd = process.platform === 'win32' ? 'python' : 'python3';
      cmdArgs = ['-u', path.basename(full), ...(Array.isArray(args) ? args : [])];
    } else if (language === 'node' || ext === '.js' || ext === '.mjs') {
      cmd = 'node';
      cmdArgs = [path.basename(full), ...(Array.isArray(args) ? args : [])];
    } else {
      return { ok: false, output: `Unsupported script type "${ext}". Supported: Python (.py) and JavaScript (.js)` };
    }

    const baseDir = path.dirname(full);
    const startTime = Date.now();

    return await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      const OUTPUT_CAP = 1_000_000; // stop a runaway script from exhausting memory

      // A StringDecoder per stream: toString('utf8') on each chunk splits any
      // multi-byte character that straddles a chunk boundary, turning emoji and
      // CJK output into replacement characters.
      const { StringDecoder } = require('string_decoder');
      const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };

      const append = (which, chunk) => {
        const text = decoders[which].write(chunk);
        if (which === 'out') {
          if (stdout.length < OUTPUT_CAP) stdout += text.slice(0, OUTPUT_CAP - stdout.length);
        } else if (stderr.length < OUTPUT_CAP) {
          stderr += text.slice(0, OUTPUT_CAP - stderr.length);
        }
      };

      const flushDecoders = () => {
        for (const which of ['out', 'err']) {
          const tail = decoders[which].end();
          if (!tail) continue;
          if (which === 'out') { if (stdout.length < OUTPUT_CAP) stdout += tail; }
          else if (stderr.length < OUTPUT_CAP) stderr += tail;
        }
      };

      // shell:false is load-bearing, not cosmetic. `args` comes straight from
      // the model, and with shell:true the array is re-joined into a command
      // line, so an argument like `x & del /f /q C:\` would be executed by the
      // shell instead of passed to the script. Without a shell each argument is
      // delivered as a literal argv entry.
      const isWin = process.platform === 'win32';
      const proc = spawn(cmd, cmdArgs, {
        cwd: baseDir,
        shell: false,
        windowsHide: true,
        // A non-detached child leaves grandchildren (a python that forked, a
        // node that spawned a server) alive after the timeout fires.
        detached: !isWin,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
      });

      const killTree = () => {
        try {
          if (isWin) {
            if (proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).unref();
          } else {
            process.kill(-proc.pid, 'SIGKILL');
          }
        } catch {
          try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        }
      };

      const timer = setTimeout(() => {
        killed = true;
        killTree();
        const ms = Date.now() - startTime;
        // A timed-out run is exactly when the output matters most — the tail is
        // where the hang was — so it is bounded the same way, not dumped.
        const bounded = spill.boundResult({
          chatId,
          label: 'run_script',
          suggestedName: path.basename(full),
          text: stdout
        });
        resolve({
          ok: false,
          exitCode: -1,
          durationMs: ms,
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + `Execution timed out after ${Math.round(timeoutMs / 1000)}s.`,
          output: `Execution timed out after ${Math.round(timeoutMs / 1000)}s.\n\nStdout:\n${bounded.text}`,
          meta: {
            exitCode: -1,
            ms,
            timedOut: true,
            ...bounded.spilled ? { spilled: bounded.spilled.locator, spilledBytes: bounded.spilled.bytes } : {}
          }
        });
      }, timeoutMs);

      proc.stdout.on('data', (d) => append('out', d));
      proc.stderr.on('data', (d) => append('err', d));

      proc.on('close', (code) => {
        if (killed) return;
        clearTimeout(timer);
        flushDecoders();
        const durationMs = Date.now() - startTime;
        const ok = code === 0;
        let outText = '';
        if (stdout) outText += stdout;
        if (stderr) outText += (outText ? '\n--- Errors (stderr) ---\n' : '') + stderr;
        if (!outText.trim()) outText = `(Script completed with exit code ${code} and produced no output)`;

        // A build log or a test run can print far more than belongs in a model's
        // context. The head and tail stay inline; the whole thing goes to the
        // workspace so the model can read the part it actually needs instead of
        // guessing at what was dropped.
        const bounded = spill.boundResult({
          chatId,
          label: 'run_script',
          suggestedName: path.basename(full),
          text: outText
        });

        resolve({
          ok,
          exitCode: code,
          durationMs,
          stdout,
          stderr,
          output: `[Exit Code ${code} · ${durationMs}ms]\n\n${bounded.text}`,
          meta: {
            exitCode: code,
            ms: durationMs,
            ...bounded.spilled ? { spilled: bounded.spilled.locator, spilledBytes: bounded.spilled.bytes } : {}
          }
        });
      });

      proc.on('error', (err) => {
        if (killed) return;
        clearTimeout(timer);
        flushDecoders();
        // EINVAL here means Windows found the interpreter as a .cmd/.bat shim,
        // which cannot be spawned without a shell (and enabling one would reopen
        // the command-injection hole). Say so plainly instead of leaking errno.
        const hint = err.code === 'EINVAL'
          ? ` "${cmd}" resolves to a script shim (.cmd/.bat), not a real executable. Install a native ${cmd}.exe or add it to PATH.`
          : '';
        resolve({
          ok: false,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          stdout,
          stderr: err.message + hint,
          output: `Execution failed to start: ${err.message}.${hint}`,
          meta: { exitCode: -1, ms: Date.now() - startTime, failedToStart: true }
        });
      });
    });
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Task list (the loop's "am I finished?" signal)
// ---------------------------------------------------------------------------
function updateTodos({ todos = [], todoKey } = {}) {
  if (!todoKey) {
    return { ok: false, output: 'Error: no active task list for this run.' };
  }
  if (!Array.isArray(todos)) {
    return { ok: false, output: 'Error: "todos" must be an array of { text, status }.' };
  }
  todo.set(todoKey, todos);
  const all = todo.snapshot(todoKey);
  const open = todo.openItems(todoKey);
  const done = all.length - open.length;

  const lines = all.map(t => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '·'} ${t.text}`);
  const summary = open.length
    ? `${open.length} task(s) still open — keep working until every one is completed.`
    : `All ${all.length} task(s) completed.`;

  return {
    ok: true,
    output: `Task list updated (${done}/${all.length} completed).\n${lines.join('\n')}\n\n${summary}`
  };
}

// ---------------------------------------------------------------------------
// Shell execution and background jobs
// ---------------------------------------------------------------------------

/**
 * Runs one command in this conversation's persistent shell.
 *
 * The shell is the deliberate difference from `run_script`: it outlives the
 * call, so `Set-Location`/`cd`, `$env:FOO`/`export FOO` and an `npm install`
 * all carry into the next command. That is what turns a one-shot tool into
 * something a model can actually build with.
 *
 * @param {object} request - the command.
 * @param {string} request.command - shell text.
 * @param {string|null} [request.chatId] - owning conversation.
 * @param {number} [request.timeoutMs] - per-command wall clock.
 * @param {boolean} [request.reset] - kill the session first, for a clean slate.
 * @returns {Promise<{ok: boolean, output: string, meta?: object}>}
 */
async function runShellTool({ command, chatId, timeoutMs, reset = false } = {}) {
  try {
    const body = shellKit.assertSendable(command, 'the command').trim();
    if (!body) return { ok: false, output: 'Error: command must be a non-empty string' };

    if (reset === true) shellKit.resetShell(chatId);

    const info = shellKit.shellInfo();
    if (!info.available) {
      return {
        ok: false,
        output: 'Error: no usable shell was found on this system. Install PowerShell 7 (pwsh), or bash on a POSIX system.'
      };
    }

    const result = await shellKit.runShell({
      command: body,
      chatId,
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined
    });

    const meta = {
      exitCode: result.exitCode,
      ms: result.durationMs,
      shell: result.shell,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.aborted ? { interrupted: true } : {}),
      ...(result.killed && !result.timedOut && !result.aborted ? { killed: true } : {}),
      ...(result.truncated ? { truncated: true, droppedBytes: result.droppedBytes } : {})
    };

    // A timeout or a dead shell is reported as a failed row, not a successful
    // one with a sad message: the row's colour is the fastest signal the user
    // has that the command did not do what they asked.
    return { ok: result.ok && !result.timedOut && !result.aborted, output: result.output, meta };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

/**
 * Starts a command as a background job and returns its handle immediately.
 *
 * @param {object} request - the job.
 * @param {string} request.command - shell text.
 * @param {string} [request.description] - what it does, for the UI row.
 * @param {number} [request.timeoutMs] - wall-clock cap for the whole job.
 * @param {string|null} [request.chatId] - owning conversation.
 * @returns {{ok: boolean, output: string, meta?: object}}
 */
function startJobTool({ command, description, timeoutMs, chatId } = {}) {
  try {
    const started = jobs.startJob({ command, description, timeoutMs, chatId });
    if (!started.ok) return started;
    return { ok: true, output: started.output, meta: started.meta };
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

/**
 * Reads a background job's output since the last read.
 *
 * @param {object} request - the read.
 * @param {string} request.id - job id.
 * @param {boolean} [request.reset] - read from the beginning.
 * @param {number} [request.max_bytes] - lower the per-call cap.
 * @returns {{ok: boolean, output: string, meta?: object}}
 */
function jobOutputTool({ id, reset, max_bytes } = {}) {
  try {
    return jobs.readJob({ id, reset, max_bytes });
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

/**
 * Stops a background job.
 *
 * A stopped job is not a failed tool: the request succeeded.
 *
 * @param {object} request - the stop.
 * @param {string} request.id - job id.
 * @param {string} [request.reason] - why, recorded for the row.
 * @returns {{ok: boolean, output: string, meta?: object}}
 */
function jobKillTool({ id, reason } = {}) {
  try {
    return jobs.stopJob(String(id || '').trim(), reason || 'stopped by request');
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

/**
 * Lists the background jobs this server knows about.
 *
 * @param {object} request - the listing.
 * @param {string|null} [request.chatId] - restrict to one conversation.
 * @returns {{ok: boolean, output: string, meta?: object}}
 */
function jobListTool({ chatId } = {}) {
  try {
    return jobs.listJobs({ chatId: chatId || null });
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
const TOOLS = {
  web_search: {
    category: 'web',
    description: 'Search the live web and return titles, URLs and snippets. Use for current events, news, docs, prices or anything uncertain.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'integer', description: 'Max results (1-10, default 6)' }
      },
      required: ['query']
    },
    run: webSearch
  },
  fetch_url: {
    category: 'web',
    description: 'Open a web page and return its readable text content. Use after web_search to read a result in depth.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http(s) URL to fetch' } },
      required: ['url']
    },
    run: fetchUrl
  },
  list_files: {
    category: 'files',
    description: 'List files and folders in the workspace (tree view). Call with no path to list the root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional subdirectory, relative to workspace root' } }
    },
    run: listFiles
  },
  grep: {
    category: 'files',
    description: 'Search the CONTENTS of workspace files with a regular expression. Returns matching lines as file:line: text. Use it to find where something is defined or used BEFORE editing, instead of guessing.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (case-insensitive)' },
        path: { type: 'string', description: 'Optional subdirectory or file to search, relative to workspace root' },
        max_results: { type: 'integer', description: 'Maximum matching lines to return (default 60, max 200)' }
      },
      required: ['pattern']
    },
    run: grepFiles
  },
  read_file: {
    category: 'files',
    description: 'Read a file in the workspace. For a large file, pass offset and limit to read one window of numbered lines instead of the whole thing.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        offset: { type: 'integer', description: 'Optional 1-based first line of a window. Use it to page through a file that was truncated.' },
        limit: { type: 'integer', description: 'Optional number of lines in the window (default 200, max 1000).' }
      },
      required: ['path']
    },
    run: readFile
  },
  write_file: {
    category: 'files',
    description: 'Create (or overwrite) a file in the workspace with the given content. Use for creating code, documents, sites, configs, etc. For a file longer than one response can hold, write the first part here and pass append: true on later calls to extend it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root (folders are created automatically)' },
        content: { type: 'string', description: 'Complete file content' },
        append: { type: 'boolean', description: 'Add this content to the END of the existing file instead of replacing it. Use it to build a file too large for one call: write the first part, then append the rest. The file must already exist.' }
      },
      required: ['path', 'content']
    },
    run: writeFile
  },
  write_files: {
    category: 'files',
    description: 'Create multiple files in the workspace in a single operation. Perfect for multi-file projects (e.g. index.html, styles.css, app.js).',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Array of file objects to create',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to workspace root' },
              content: { type: 'string', description: 'Complete file content' }
            },
            required: ['path', 'content']
          }
        }
      },
      required: ['files']
    },
    run: writeFiles
  },
  edit_file: {
    category: 'files',
    description: 'Edit an existing file by replacing an exact string. Always read the file first so "find" matches exactly.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        find: { type: 'string', description: 'Exact string to replace' },
        replace: { type: 'string', description: 'Replacement string' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
      },
      required: ['path', 'find', 'replace']
    },
    run: editFile
  },
  delete_file: {
    category: 'files',
    description: 'Delete a file or directory (destructive — requires confirm: true).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to workspace root' },
        confirm: { type: 'boolean', description: 'Must be true to execute' }
      },
      required: ['path', 'confirm']
    },
    run: deleteFile
  },
  create_directory: {
    category: 'files',
    description: 'Create a directory (including parents) in the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path relative to workspace root' } },
      required: ['path']
    },
    run: createDirectory
  },
  llamacoder_generate: {
    category: 'code',
    description: 'Generate full web apps, dashboards, tools, landing pages or UI components using LlamaCoder\'s 20,000-token DeepSeek-V4-Flash pipeline (no API key required). Set save_path to automatically save the code into a workspace file.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed prompt describing the app, tool, website, or component to generate' },
        save_path: { type: 'string', description: 'Optional path relative to workspace root to save the generated code (e.g. "apps/budget-tracker/index.html")' },
        model: { type: 'string', description: 'Model to use (default: deepseek-ai/DeepSeek-V4-Flash-0731, or zai-org/GLM-5.2, meta-llama/Llama-3.3-70B-Instruct-Turbo)' }
      },
      required: ['prompt']
    },
    run: llamacoderGenerate
  },
  run_script: {
    category: 'code',
    description: 'Execute a Python (.py) or Node.js (.js) script in the workspace and capture stdout/stderr output. Perfect for scraping web pages, running data analysis, or executing test scripts.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to script file relative to workspace root (e.g. "scraper.py" or "script.js")' },
        args: { type: 'array', description: 'Optional command line arguments to pass to the script', items: { type: 'string' } }
      },
      required: ['path']
    },
    run: runScript
  },
  update_todos: {
    category: 'plan',
    description: 'Keep your task checklist for a multi-step job. Call it with the FULL list every time (it replaces the previous list). Mark each item pending, in_progress or completed as you go. While any item is still pending or in_progress the system will keep the turn running and ask you to continue, so a long project gets finished in one go instead of stopping half way. Do not use it for one-step requests.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete task list, in order',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'What needs to be done' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current state of this task' }
            },
            required: ['text', 'status']
          }
        }
      },
      required: ['todos']
    },
    run: updateTodos
  },
  run_shell: {
    category: 'code',
    description: 'Run a shell command (PowerShell on Windows, bash on Linux/macOS) and return its stdout/stderr and exit code. The shell PERSISTS across calls for this conversation, so `cd`, environment variables and installed packages carry over to the next run_shell call — use one call to `cd` into a folder and the next to build in it. Use it for git, npm/pnpm, python, compilers, tests, file conversion and anything else that needs a real command. Each call has a timeout; for work that should outlive the turn, use start_job instead.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run. Relative paths are resolved from the workspace root.' },
        timeoutMs: { type: 'integer', description: 'Optional per-command timeout in milliseconds (default 120000, max 900000). On expiry the shell is reset.' },
        reset: { type: 'boolean', description: 'Start a brand-new shell session first (clears working directory, variables and any stuck state).' }
      },
      required: ['command']
    },
    run: runShellTool
  },
  start_job: {
    category: 'code',
    description: 'Start a long-running command in the BACKGROUND and return its job id immediately, so you can keep working while it runs. Use it for a dev server, a watch build, a full test suite, an install that takes minutes, or anything you would otherwise block on. Collect the output with job_output, stop it with job_kill, and see everything with job_list. Do NOT use run_shell for those — it waits for the command to finish.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run in the background.' },
        description: { type: 'string', description: 'Short description of what this job does, in active voice (shown in the UI), e.g. "Start the dev server".' },
        timeoutMs: { type: 'integer', description: 'Optional wall-clock cap for the whole job in milliseconds (default 900000, max 3600000).' }
      },
      required: ['command']
    },
    run: startJobTool
  },
  job_output: {
    category: 'code',
    description: 'Read what a background job has printed SINCE YOUR LAST READ, plus its status and exit code. Call it again to follow a running job — you get only the new output each time, so polling a long build does not repeat the whole log. Pass reset: true to read from the beginning.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The job id returned by start_job.' },
        reset: { type: 'boolean', description: 'Read from the start of the job instead of from your last read.' },
        max_bytes: { type: 'integer', description: 'Optional lower cap on how much output this call returns.' }
      },
      required: ['id']
    },
    run: jobOutputTool
  },
  job_kill: {
    category: 'code',
    description: 'Stop a background job and everything it started. Use it when a job has served its purpose (a dev server you no longer need) or is stuck. The job keeps its output, so read it with job_output afterwards if you need the last lines.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The job id to stop.' },
        reason: { type: 'string', description: 'Optional short reason, recorded for the user.' }
      },
      required: ['id']
    },
    run: jobKillTool
  },
  job_list: {
    category: 'code',
    description: 'List every background job with its status, exit code and how much unread output it has. Use it to find a job id you have forgotten, or to check what is still running before you finish.',
    parameters: { type: 'object', properties: {} },
    run: jobListTool
  }
};

function defsFor({ web = true, files = true, code = true } = {}) {
  // The task-list tool only makes sense alongside real tools: it exists so the
  // loop can tell "finished" from "gave up" during multi-step work. Offering it
  // on its own — which is what happened when every group was switched off — left
  // the conversation with a non-empty tool list, so the provider was still sent
  // `tools: [...]` and the agent still behaved like an agent when the user had
  // asked for a plain chat.
  const anyGroup = Boolean(web || files || code);
  return Object.entries(TOOLS)
    .filter(([, t]) => {
      if (t.category === 'plan') return anyGroup;
      if (t.category === 'web') return web;
      if (t.category === 'files') return files;
      if (t.category === 'code') return code;
      return false;
    })
    .map(([name, t]) => ({ name, description: t.description, parameters: t.parameters, category: t.category }));
}

async function execute(name, args, { chatId, todoKey, allowed = null } = {}) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, output: `Error: unknown tool "${name}"` };
  // Enforce the conversation's enabled set. A model that was never offered a tool
  // can still name it — hallucinated, or suggested by a page it just read — and
  // running it would exceed what the user actually switched on.
  if (Array.isArray(allowed) && !allowed.includes(name)) {
    return {
      ok: false,
      output: `Error: the "${name}" tool is not enabled for this conversation.` +
        (allowed.length ? ` Available: ${allowed.join(', ')}.` : ' No tools are enabled.')
    };
  }
  try {
    const payload = { ...(args || {}) };
    if (chatId) payload.chatId = chatId;
    if (todoKey) payload.todoKey = todoKey;
    return await tool.run(payload);
  } catch (e) {
    return { ok: false, output: `Error: ${e.message}` };
  }
}

// ---- helpers for the HTTP layer (file explorer) ----
function listDir(rel = '', chatId = null) {
  if (!chatId) {
    // When in a new chat or no chat selected, workspace is clean & empty
    return { ok: true, entries: [] };
  }
  const base = resolveBaseDir(chatId);
  const root = safePath(rel, chatId);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: true, entries: [] };
  }
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const full = path.join(root, e.name);
      let size = 0, mtime = null;
      try { const s = fs.statSync(full); size = s.size; mtime = s.mtimeMs; } catch { /* ignore */ }
      return {
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.relative(base, full).split(path.sep).join('/'),
        size,
        mtime
      };
    })
    .sort((a, b) => (b.type === 'dir') - (a.type === 'dir') || a.name.localeCompare(b.name));
  return { ok: true, entries };
}

// Recursive tree for the Workspace panel. Returns nested nodes plus aggregate
// totals so the UI can show "12 files · 84 KB" without N+1 requests.
function listTree(rel = '', chatId = null, { depth = 8, maxEntries = 1000 } = {}) {
  if (!chatId) return { ok: true, tree: [], totalFiles: 0, totalBytes: 0, truncated: false };
  const base = resolveBaseDir(chatId);
  const root = safePath(rel, chatId);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: true, tree: [], totalFiles: 0, totalBytes: 0, truncated: false };
  }
  let totalFiles = 0;
  let totalBytes = 0;
  let count = 0;

  const walk = (dir, d) => {
    const nodes = [];
    if (d > depth || count >= maxEntries) return nodes;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return nodes; }
    entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (count >= maxEntries) break;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const relPath = path.relative(base, full).split(path.sep).join('/');
      let size = 0, mtime = null;
      try { const s = fs.statSync(full); size = s.size; mtime = s.mtimeMs; } catch { /* ignore */ }
      if (e.isDirectory()) {
        count++;
        const node = { name: e.name, type: 'dir', path: relPath, size: 0, mtime, children: [] };
        node.children = walk(full, d + 1);
        node.size = node.children.reduce((a, c) => a + (c.size || 0), 0);
        nodes.push(node);
      } else {
        count++;
        totalFiles++;
        totalBytes += size;
        nodes.push({ name: e.name, type: 'file', path: relPath, size, mtime });
      }
    }
    return nodes;
  };

  const tree = walk(root, 0);
  return { ok: true, tree, totalFiles, totalBytes, truncated: count >= maxEntries };
}

function readForViewer(rel, chatId = null) {
  // Mirrors listTree: without a chat id there is no per-chat workspace to show,
  // and falling back to the shared root let a request read another chat's files
  // by naming them (chatId=…/../chats/<other>/…).
  if (!chatId) return { ok: false, error: 'A chatId is required to read workspace files.' };
  const full = safePath(rel, chatId);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return { ok: false, error: 'File not found' };
  const content = fs.readFileSync(full, 'utf8');
  const cap = 100000;
  return {
    ok: true,
    path: rel,
    content: content.slice(0, cap),
    truncated: content.length > cap,
    size: Buffer.byteLength(content)
  };
}

// ---------------------------------------------------------------------------
// Auto-persister: parses code blocks from assistant markdown and saves them
// directly to the chat's workspace if tools weren't explicitly called.
// ---------------------------------------------------------------------------

/**
 * Normalises a workspace-relative path for set membership tests.
 *
 * Both sides of the skip test must agree. Before this collapsed `.`/`..` and
 * duplicate separators, `write_file({path: "./src/App.tsx"})` put a different
 * string in the skip set than the fenced block's `src/App.tsx`, so the prose
 * copy overwrote the file a real tool had just written — the exact thing the
 * skip set exists to prevent.
 */
function normWorkspacePath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s) return '';
  const norm = path.posix.normalize(s);
  return norm === '.' ? '' : norm.replace(/^\.\//, '');
}

/**
 * Collects the workspace paths a turn already wrote through explicit file
 * tools. Feeding this to extractAndSaveCodeBlocks as `skip` is what stops the
 * markdown auto-saver from overwriting real tool output: a model that calls
 * write_file and *also* shows the file in a fenced block would otherwise have
 * its own (possibly later-edited) file clobbered by the prose copy.
 */
function artifactPathsFromToolRuns(runs = []) {
  const paths = new Set();
  const add = (p) => { const n = normWorkspacePath(p); if (n) paths.add(n); };

  for (const run of runs || []) {
    const args = run?.args || {};
    if (run?.name === 'write_file') add(args.path);
    else if (run?.name === 'edit_file') add(args.path);
    else if (run?.name === 'write_files') {
      for (const f of Array.isArray(args.files) ? args.files : []) add(f?.path);
    } else if (run?.name === 'llamacoder_generate') {
      add(args.save_path || args.filename);
    }
  }
  return paths;
}

function extractAndSaveCodeBlocks(text, { chatId = null, overwrite = true, skip = null } = {}) {
  if (!text || typeof text !== 'string') return [];
  const savedFiles = [];
  const seenPaths = new Set();

  // Regex to match markdown code blocks (also tolerates unclosed trailing blocks at EOF)
  const blockRegex = /```([^\r\n]*)\r?\n([\s\S]*?)(?:```|$)/g;
  let match;

  while ((match = blockRegex.exec(text)) !== null) {
    const info = (match[1] || '').trim();
    let code = match[2] || '';
    const matchIndex = match.index;

    let targetPath = null;
    let inlineFirstLineCode = '';

    // Pattern 1: info string has path/file parameter
    // e.g. ```html {path="index.html"} or ```tsx path=src/App.tsx or ```js filename="app.js"
    const infoPathMatch = info.match(/(?:path|file|filename)=["']?([^"'\s}]+)["']?/i);
    if (infoPathMatch) {
      targetPath = infoPathMatch[1];
      const endOfSpec = info.indexOf('}', infoPathMatch.index);
      if (endOfSpec !== -1) {
        inlineFirstLineCode = info.slice(endOfSpec + 1).trim();
      } else {
        inlineFirstLineCode = info.slice(infoPathMatch.index + infoPathMatch[0].length).trim();
      }
    } else {
      // e.g. ```html:index.html or ```python:main.py
      const colonMatch = info.match(/^[\w+-]+:([^\s]+)(?:\s+(.*))?$/);
      if (colonMatch) {
        targetPath = colonMatch[1];
        if (colonMatch[2]) inlineFirstLineCode = colonMatch[2].trim();
      }
    }

    if (inlineFirstLineCode) {
      code = code ? inlineFirstLineCode + '\n' + code : inlineFirstLineCode;
    }

    // Pattern 2: first line of code has a file comment
    if (!targetPath && code) {
      const firstLine = code.split('\n')[0].trim();
      const commentMatch = firstLine.match(/^(?:\/\/|#|\/\*|<!--)\s*(?:filepath:|file:|path:)?\s*([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+)(?:\s*\*\/|\s*-->)?$/i);
      if (commentMatch) {
        const candidate = commentMatch[1].trim();
        // Avoid matching generic comments like "// version: 1.0" or "// author: john"
        if (/\.[a-zA-Z0-9]+$/.test(candidate) && !/^https?:\/\//i.test(candidate)) {
          targetPath = candidate;
        }
      }
    }

    // Pattern 3: preceding text (look back up to 200 chars) mentions a file
    if (!targetPath && matchIndex > 0) {
      const lookback = text.slice(Math.max(0, matchIndex - 200), matchIndex);
      const fileHeaderMatch = lookback.match(/(?:###|\*\*|File:?|Filename:?|Create)\s*[`"]?([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]{1,6})[`"]?[:\s]*$/im);
      if (fileHeaderMatch) {
        targetPath = fileHeaderMatch[1].trim();
      }
    }

    // Pattern 4: full HTML document fallback
    if (!targetPath && code) {
      if (/<!DOCTYPE html[\s>]|<html[\s>]/i.test(code) && /<\/html>/i.test(code)) {
        targetPath = 'index.html';
      }
    }

    // Never save 0-byte / empty files
    if (targetPath && code.trim()) {
      // Same normalisation as artifactPathsFromToolRuns, so the two sides of the
      // skip test are always comparable.
      const cleanPath = normWorkspacePath(targetPath);
      if (!cleanPath) continue;
      if (seenPaths.has(cleanPath)) continue;
      // A file this turn already produced with a real tool wins over the
      // markdown copy of it.
      if (skip && skip.has(cleanPath)) continue;

      try {
        const full = safePath(cleanPath, chatId);
        if (!overwrite && fs.existsSync(full)) {
          continue;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, code, 'utf8');
        const bytes = Buffer.byteLength(code, 'utf8');
        savedFiles.push({ path: cleanPath, size: bytes });
        seenPaths.add(cleanPath);
      } catch (err) {
        // Reported rather than swallowed: the transcript shows a code block that
        // claims to be a file, and silence left the user believing it exists.
        savedFiles.push({ path: cleanPath, error: (err && err.message) || String(err) });
        seenPaths.add(cleanPath);
      }
    }
  }

  return savedFiles;
}

module.exports = {
  TOOLS,
  defsFor,
  execute,
  listDir,
  listTree,
  grepFiles,
  readForViewer,
  safePath,
  resolveBaseDir,
  WORKSPACE_DIR,
  extractAndSaveCodeBlocks,
  artifactPathsFromToolRuns,
  normWorkspacePath,
  runScript,
  // Shell execution and background jobs: the executors are exported so the
  // smoke tests can drive them without a model in the loop, and so a future
  // route (a "run this command" button) has one entry point rather than two.
  runShell: runShellTool,
  startJob: startJobTool,
  jobOutput: jobOutputTool,
  jobKill: jobKillTool,
  jobList: jobListTool,
  // Exported for the hardening suite: these are the guards the model-facing
  // tools depend on, and they are worth pinning directly rather than only
  // through a tool call.
  editFile,
  readFile,
  ipIsPrivate,
  isPrivateHost,
  assertPublicUrl
};

