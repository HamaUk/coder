// HAMA — AI Support Agent console
// Zero-dependency Node server: static UI + JSON API + SSE chat streaming.
const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./src/store');
const toolsKit = require('./src/tools');
const providerKit = require('./src/providers');
const zip = require('./src/zip');
const { buildReactApp } = require('./src/react_bundler');
const { handleChat } = require('./src/routes/chat');
const { chatMeta } = require('./src/middleware/finalize');
const { seedProviderFromEnv } = require('./src/env-provider');

const PORT = process.env.PORT || 3000;
// Loopback by default. The API has no authentication, so binding to 0.0.0.0
// handed every endpoint — including file reads and the script runner — to
// anyone on the same network. Set HOST=0.0.0.0 to opt back in deliberately.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Access token for a deployment that listens beyond loopback. Empty means "local
// use only": the console can run shell commands and returns stored API keys, so
// the server will not bind a public interface without one.
const AUTH_TOKEN = String(process.env.HAMA_TOKEN || process.env.HAMA_PASSWORD || '');
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
const auth = require('./src/auth').createAuth({ token: AUTH_TOKEN });
if (!LOOPBACK_HOSTS.has(HOST) && !auth.enabled) {
  console.error(
    '\n  ✦ HAMA refuses to listen on ' + HOST + ' without an access token.\n'
    + '    This console can run commands on this machine and shows stored API keys.\n'
    + '    Set one and start again:\n\n'
    + '      HAMA_TOKEN="a-long-random-secret" HOST=0.0.0.0 npm start\n'
  );
  process.exit(1);
}

// The ZIP route builds the archive in memory, so what one download may pull is
// bounded. Files past the cap are left out and counted, not silently dropped.
const MAX_ZIP_BYTES = 250 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Last-resort crash reporting.
//
// A turn can stream for minutes, and until finalize commits it the ONLY copy of
// the reply lives in this process's memory. Node's default reaction to an
// escaped rejection is to exit — which throws away work the user has already
// watched happen and leaves no trace of why. That is exactly how one
// conversation ended up holding a user message, five written files and no
// answer at all, with the browser reporting only "Error in input stream".
//
// Both handlers log to data/server-error.log and KEEP RUNNING. For a local
// console that is the right trade: a process that survives can still commit the
// turn in flight, and the next failure is diagnosable instead of invisible.
// ---------------------------------------------------------------------------
function logCrash(kind, err) {
  const detail = (err && err.stack) || (err && err.message) || String(err);
  try {
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(store.DATA_DIR, 'server-error.log'),
      `[${new Date().toISOString()}] ${kind}\n${detail}\n\n`
    );
  } catch { /* the console report below still happens */ }
  console.error(`\n  ✦ ${kind} — details appended to data/server-error.log\n`, detail);
}

process.on('unhandledRejection', (reason) => logCrash('Unhandled promise rejection', reason));
process.on('uncaughtException', (err) => logCrash('Uncaught exception', err));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
};

// Seed the workspace with a friendly README if empty
(function seedWorkspace() {
  try {
    const readme = path.join(store.WORKSPACE_DIR, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        '# Agent Workspace 📂',
        '',
        'Files the AI creates or edits live here. Ask it to build you a website,',
        'write a script, or draft a document, then open the Workspace panel to see the results.',
        ''
      ].join('\n'));
    }
  } catch { /* non-fatal */ }
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Rejects a provider base URL that no request could ever be built from.
 *
 * A scheme-less value like `api.openai.com/v1` was accepted and stored, and the
 * mistake only surfaced later as `Failed to parse URL from …` inside a chat
 * turn — a confusing error, in the wrong place, long after the user believed the
 * provider was configured. Validating at the boundary is what keeps the fix
 * where the mistake was made.
 *
 * @param {unknown} baseUrl - the submitted URL (undefined on a partial update).
 * @param {unknown} type - the provider type; the offline engines take no URL.
 * @returns {string|null} the message to report, or null when the value is usable.
 */
function validateBaseUrl(baseUrl, type) {
  if (type === 'demo' || type === 'llamacoder') return null;
  if (baseUrl === undefined) return null; // partial update: the stored value stands
  const value = String(baseUrl).trim();
  if (!value) return null; // a missing URL is the form's business, not ours
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'That base URL has no scheme. Use the full form, e.g. https://' + value.replace(/^\/+/, '');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'A base URL must start with http:// or https:// (got ' + parsed.protocol + ')';
  }
  return null;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Streams a file to the response. The 'error' listener is not optional: a file
// deleted (or locked) between the existsSync check and the open emits an
// unhandled 'error' on the stream, which kills the whole Node process.
function pipeFile(res, full) {
  const stream = fs.createReadStream(full);
  stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
  return stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // no-store everywhere: the console ships updates often and stale
      // cached assets have caused hard-to-diagnose UI bugs
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

// Providers go to the browser without their API key. The frontend only ever
// needs to know *whether* a key is stored (to show the "saved" placeholder and
// to gate the Test/Fetch-models buttons), never the key itself — anything sent
// here is readable by any script on the page and lands in devtools.
const safeProviderView = (p) => {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: Boolean(apiKey) };
};

/**
 * Rejects state-changing requests that did not come from this origin.
 *
 * The API is unauthenticated, so without this a page on any other site could
 * POST a plain HTML form at these routes (a simple form POST needs no CORS
 * preflight) and, for example, wipe every chat and workspace via
 * /api/chats-clear. Requests with no Origin header at all — curl, scripts — are
 * allowed through, since a browser always sends one on a cross-origin POST.
 */
function isCrossOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = req.headers.host;
  if (!host) return true;
  try { return new URL(origin).host !== host; } catch { return true; }
}

const sanitizeModelsCache = (v) => Array.isArray(v)
  ? v.filter(x => typeof x === 'string' && x.trim()).slice(0, 400).map(s => s.slice(0, 140))
  : [];

// chatMeta lives with the finalize phase, which owns the message_end payload.

// Active chat streams (for stop / abort): chatId -> Set<AbortController>, so
// overlapping turns on one chat are all reachable by Stop.
const activeStreams = new Map();

// ---------------------------------------------------------------------------
// Stale-code detection
//
// The UI is served from disk on every request, so a page refresh always picks up
// a new public/*.js. Server code is read ONCE, at require time — so after an edit
// the browser can be running new front-end code against a process running the old
// back end, and the only symptom is a fix that plainly did not take. Remembering
// the newest source mtime at boot makes that state detectable instead of
// mysterious.
// ---------------------------------------------------------------------------
function newestCodeMtime() {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      try { const m = fs.statSync(full).mtimeMs; if (m > newest) newest = m; } catch { /* ignore */ }
    }
  };
  walk(path.join(__dirname, 'src'));
  try { newest = Math.max(newest, fs.statSync(__filename).mtimeMs); } catch { /* ignore */ }
  return newest;
}

const BOOT_CODE_MTIME = newestCodeMtime();
const BOOT_AT = Date.now();
/**
 * A short, human-checkable stamp for the code this process loaded.
 *
 * Printed at boot and served on /api/health so "which build am I running?" has
 * an answer that does not require reasoning about file timestamps.
 */
const VERSION = new Date(BOOT_CODE_MTIME).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
let staleWarned = false;

/** True when a source file has been written since this process loaded the code. */
function codeIsStale() {
  return newestCodeMtime() > BOOT_CODE_MTIME;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const method = req.method;

  try {
    // Cheap hardening on every response. No framing header: the Live App
    // preview legitimately frames this server's own workspace route.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // Any mutating verb must originate from this page. See isCrossOrigin().
    if (method !== 'GET' && method !== 'HEAD' && isCrossOrigin(req)) {
      return sendJSON(res, 403, { error: 'Cross-origin request rejected' });
    }

    // ---- authentication ----
    //
    // Checked before every other route. An unauthenticated API call gets JSON it
    // can act on; a page load is redirected to the form rather than served a
    // console shell that would only fail on its first request.
    if (auth.enabled) {
      if (p === '/login' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(auth.loginPage({
          error: u.searchParams.get('error') || '',
          agentName: store.getSettings().agentName
        }));
      }
      if (p === '/login' && method === 'POST') {
        const body = await readBody(req);
        const result = auth.login(body.token, req, res);
        if (result.ok) {
          res.writeHead(302, { Location: '/' });
          return res.end();
        }
        res.writeHead(result.retryAfterSec ? 429 : 401, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return res.end(auth.loginPage({ error: result.error, agentName: store.getSettings().agentName }));
      }
      if (p === '/logout') {
        auth.logout(req, res);
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      if (!auth.isAuthed(req) && !auth.publicPath(p)) {
        if (p.startsWith('/api/')) return sendJSON(res, 401, { error: 'Authentication required. Sign in at /login.' });
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        return res.end();
      }
    }

    // ---- health / staleness ----
    //
    // One bit, asked for repeatedly by an open tab. `startedAt` and the code
    // mtime are included so the answer is checkable by hand: if startedAt is
    // older than the newest src/*.js, this process is running old code.
    if (p === '/api/health' && method === 'GET') {
      const stale = codeIsStale();
      if (stale && !staleWarned) {
        staleWarned = true;
        console.warn(
          '\n  ⚠ Backend source changed after this process started — it is still running the OLD code.\n' +
          '    Restart it to apply the change (Ctrl+C, then `npm start`),\n' +
          '    or run `npm run dev` to reload automatically on every edit.\n'
        );
      }
      return sendJSON(res, 200, {
        ok: true,
        staleCode: stale,
        startedAt: BOOT_AT,
        codeMtime: BOOT_CODE_MTIME,
        version: VERSION
      });
    }

    // ---- bootstrap ----
    if (p === '/api/bootstrap' && method === 'GET') {
      const stale = codeIsStale();
      if (stale && !staleWarned) {
        staleWarned = true;
        console.warn(
          '\n  ⚠ Backend source changed after this process started — it is still running the OLD code.\n' +
          '    Restart it to apply the change (Ctrl+C, then `npm start`),\n' +
          '    or run `npm run dev` to reload automatically on every edit.\n'
        );
      }
      const chats = store.getChats().map(chatMeta).sort((a, b) => b.updatedAt - a.updatedAt);
      return sendJSON(res, 200, {
        providers: store.getProviders().map(safeProviderView),
        chats,
        settings: store.getSettings(),
        presets: providerKit.PRESETS,
        // The client turns this into a visible warning rather than leaving the
        // user to wonder why an edit had no effect.
        staleCode: stale,
        startedAt: BOOT_AT,
        codeMtime: BOOT_CODE_MTIME,
        version: VERSION,
        toolCatalog: toolsKit.defsFor({ web: true, files: true, code: true }).map(t => ({ name: t.name, description: t.description, category: t.category }))
      });
    }

    // ---- providers CRUD ----
    if (p === '/api/providers' && method === 'GET') {
      return sendJSON(res, 200, { providers: store.getProviders().map(safeProviderView) });
    }
    if (p === '/api/providers' && method === 'POST') {
      const body = await readBody(req);
      const urlError = validateBaseUrl(body.baseUrl, body.type);
      if (urlError) return sendJSON(res, 400, { error: urlError });
      const prov = {
        id: 'prov_' + store.uid().slice(0, 8),
        name: String(body.name || 'New provider').slice(0, 80),
        type: ['openai', 'anthropic', 'google', 'demo', 'llamacoder'].includes(body.type) ? body.type : 'openai',
        presetId: String(body.presetId || 'custom'),
        apiKey: String(body.apiKey || ''),
        baseUrl: String(body.baseUrl || ''),
        model: String(body.model || ''),
        temperature: body.temperature === '' || body.temperature == null ? null : Number(body.temperature),
        maxTokens: body.maxTokens ? Number(body.maxTokens) : null,
        customInstructions: String(body.customInstructions || ''),
        toolsEnabled: body.toolsEnabled !== false,
        enabled: body.enabled !== false,
        modelsCache: sanitizeModelsCache(body.modelsCache),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await store.mutateProviders((providers) => { providers.push(prov); });
      return sendJSON(res, 201, { provider: safeProviderView(prov) });
    }
    const provMatch = p.match(/^\/api\/providers\/([\w-]+)(\/test)?$/);
    if (provMatch) {
      const id = provMatch[1];
      const providers = store.getProviders();
      const idx = providers.findIndex(x => x.id === id);
      if (idx === -1) return sendJSON(res, 404, { error: 'Provider not found' });
      if (provMatch[2] === '/test' && method === 'POST') {
        return sendJSON(res, 200, await providerKit.testProvider(providers[idx]));
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const urlError = validateBaseUrl(body.baseUrl, body.type);
        if (urlError) return sendJSON(res, 400, { error: urlError });
        const next = await store.mutateProviders((list) => {
          const i = list.findIndex(x => x.id === id);
          if (i === -1) return null;
          const cur = list[i];
          const updated = {
            ...cur,
            name: body.name !== undefined ? String(body.name).slice(0, 80) : cur.name,
            type: body.type !== undefined && ['openai', 'anthropic', 'google', 'demo', 'llamacoder'].includes(body.type) ? body.type : cur.type,
            presetId: body.presetId !== undefined ? String(body.presetId) : cur.presetId,
            // The form no longer receives the stored key, so an empty or absent
            // field means "unchanged" — not "erase it". Only a non-empty value
            // replaces the key.
            apiKey: body.apiKey ? String(body.apiKey) : cur.apiKey,
            baseUrl: body.baseUrl !== undefined ? String(body.baseUrl) : cur.baseUrl,
            model: body.model !== undefined ? String(body.model) : cur.model,
            temperature: body.temperature !== undefined ? (body.temperature === '' || body.temperature == null ? null : Number(body.temperature)) : cur.temperature,
            maxTokens: body.maxTokens !== undefined ? (body.maxTokens ? Number(body.maxTokens) : null) : cur.maxTokens,
            customInstructions: body.customInstructions !== undefined ? String(body.customInstructions) : cur.customInstructions,
            toolsEnabled: body.toolsEnabled !== undefined ? body.toolsEnabled !== false : cur.toolsEnabled,
            enabled: body.enabled !== undefined ? body.enabled !== false : cur.enabled,
            modelsCache: body.modelsCache !== undefined ? sanitizeModelsCache(body.modelsCache) : (cur.modelsCache || []),
            updatedAt: Date.now()
          };
          list[i] = updated;
          return updated;
        });
        if (!next) return sendJSON(res, 404, { error: 'Provider not found' });
        return sendJSON(res, 200, { provider: safeProviderView(next) });
      }
      if (method === 'DELETE') {
        await store.mutateProviders((list) => {
          const i = list.findIndex(x => x.id === id);
          if (i !== -1) list.splice(i, 1);
        });
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- model listing (used by the provider form) ----
    if (p === '/api/models' && method === 'POST') {
      const body = await readBody(req);
      try {
        // The form never receives the stored key, so when it leaves the field
        // blank for an existing provider, fall back to the saved key rather than
        // making the operator retype it just to test the connection.
        let apiKey = body.apiKey || '';
        if (!apiKey && body.providerId) {
          const saved = store.getProviders().find(x => x.id === body.providerId);
          if (saved) apiKey = saved.apiKey || '';
        }
        const models = await providerKit.listModels({
          type: body.type || 'openai',
          baseUrl: body.baseUrl || '',
          apiKey
        });
        return sendJSON(res, 200, { ok: true, models });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    }

    // ---- live model health check (used by the provider form) ----
    // Probes each model with a tiny completion plus a tool-call test, so a
    // model that answers but cannot drive the agent loop is visible up front.
    if (p === '/api/models/check' && method === 'POST') {
      const body = await readBody(req);
      try {
        let apiKey = body.apiKey || '';
        if (!apiKey && body.providerId) {
          const saved = store.getProviders().find(x => x.id === body.providerId);
          if (saved) apiKey = saved.apiKey || '';
        }
        const target = {
          type: body.type || 'openai',
          baseUrl: body.baseUrl || '',
          apiKey,
          presetId: body.presetId || 'custom'
        };
        const wanted = Array.isArray(body.models) && body.models.length
          ? body.models
          : (body.model ? [body.model] : []);
        const models = wanted
          .filter(m => typeof m === 'string' && m.trim())
          .slice(0, 8);
        if (!models.length) {
          return sendJSON(res, 200, { ok: false, error: 'No models to check — fetch or type a model id first.' });
        }
        const results = [];
        for (const model of models) {
          const r = await providerKit.probeModel(target, model, { timeoutMs: 30000, withTools: true });
          results.push({ model, ...r });
        }
        return sendJSON(res, 200, { ok: true, results });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: e.message });
      }
    }

    // ---- chats ----
    if (p === '/api/chats' && method === 'GET') {
      return sendJSON(res, 200, { chats: store.getChats().map(chatMeta).sort((a, b) => b.updatedAt - a.updatedAt) });
    }
    if (p === '/api/chats' && method === 'POST') {
      const body = await readBody(req);
      const chat = await store.mutateChats((chats) => {
        const c = {
          id: 'chat_' + store.uid().slice(0, 8),
          title: String(body.title || 'New conversation'),
          providerId: body.providerId || store.getSettings().defaultProviderId || null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: []
        };
        chats.push(c);
        return c;
      });
      return sendJSON(res, 201, { chat });
    }
    const chatMatch = p.match(/^\/api\/chats\/([\w-]+)$/);
    if (chatMatch) {
      const chatId = chatMatch[1];
      if (!store.getChat(chatId)) return sendJSON(res, 404, { error: 'Chat not found' });
      if (method === 'GET') return sendJSON(res, 200, { chat: store.getChat(chatId) });
      if (method === 'PATCH') {
        const body = await readBody(req);
        // Apply the edit inside the lock: a rename or model switch landing while
        // a reply is streaming must not be reverted by a stale snapshot, and the
        // assistant message appended meanwhile must not be dropped.
        const updated = await store.mutateChats((chats) => {
          const chat = chats.find(c => c.id === chatId);
          if (!chat) return null;
          if (body.title !== undefined) chat.title = String(body.title).slice(0, 120);
          if (body.providerId !== undefined) chat.providerId = body.providerId;
          if (body.model !== undefined) chat.model = body.model ? String(body.model) : null;
          chat.updatedAt = Date.now();
          return chatMeta(chat);
        });
        if (!updated) return sendJSON(res, 404, { error: 'Chat not found' });
        return sendJSON(res, 200, { chat: updated });
      }
      if (method === 'DELETE') {
        const removed = await store.mutateChats((chats) => {
          const i = chats.findIndex(c => c.id === chatId);
          if (i === -1) return false;
          chats.splice(i, 1);
          return true;
        });
        if (removed) store.deleteChatWorkspace(chatId);
        return sendJSON(res, 200, { ok: true });
      }
    }

    // ---- settings ----
    if (p === '/api/settings' && method === 'GET') return sendJSON(res, 200, { settings: store.getSettings() });
    if (p === '/api/settings' && method === 'PUT') {
      const body = await readBody(req);
      const allowed = {};
      for (const k of ['agentName', 'theme', 'defaultProviderId', 'globalInstructions', 'agent']) {
        if (body[k] !== undefined) allowed[k] = body[k];
      }
      await store.mutateSettings((settings) => { Object.assign(settings, allowed); });
      return sendJSON(res, 200, { settings: store.getSettings() });
    }
    if (p === '/api/chats-clear' && method === 'POST') {
      const ids = store.getChats().map(c => c.id);
      await store.mutateChats((chats) => { chats.length = 0; });
      for (const id of ids) {
        store.deleteChatWorkspace(id);
      }
      return sendJSON(res, 200, { ok: true });
    }

    // ---- workspace file explorer ----
    if (p === '/api/files' && method === 'GET') {
      const rel = u.searchParams.get('path') || '';
      const chatId = u.searchParams.get('chatId') || null;
      try {
        const out = toolsKit.listDir(rel, chatId);
        if (!out.ok) return sendJSON(res, 404, { error: out.error });
        return sendJSON(res, 200, out);
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/files/tree' && method === 'GET') {
      const rel = u.searchParams.get('path') || '';
      const chatId = u.searchParams.get('chatId') || null;
      try {
        const out = toolsKit.listTree(rel, chatId);
        if (!out.ok) return sendJSON(res, 404, { error: out.error });
        return sendJSON(res, 200, out);
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/files/read' && method === 'GET') {
      const rel = u.searchParams.get('path') || '';
      const chatId = u.searchParams.get('chatId') || null;
      try {
        const out = toolsKit.readForViewer(rel, chatId);
        if (!out.ok) return sendJSON(res, 404, { error: out.error });
        return sendJSON(res, 200, out);
      } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/files/raw' && method === 'GET') {
      const rel = u.searchParams.get('path') || '';
      const chatId = u.searchParams.get('chatId') || null;
      const asDownload = u.searchParams.get('download') != null;
      // Same requirement as the viewer: a chat-scoped file needs a chat. With no
      // id this resolved to the shared root, where `chats/<other>/…` is a
      // readable path — one request away from another conversation's files.
      if (!store.isValidChatId(chatId)) {
        return sendJSON(res, 400, { error: 'A chatId is required to read workspace files.' });
      }
      try {
        const full = toolsKit.safePath(rel, chatId);
        if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('File not found');
        }
        const ext = path.extname(full).toLowerCase();
        const headers = {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store'
        };
        if (asDownload) {
          const name = path.basename(full).replace(/["\r\n\\]/g, '_');
          headers['Content-Disposition'] = `attachment; filename="${name}"`;
        }
        res.writeHead(200, headers);
        return pipeFile(res, full);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end(e.message);
      }
    }

    // ---- download one chat's folder as a ZIP ----
    //
    // A chatId is REQUIRED. Without it this route served the shared workspace
    // root, so a single URL downloaded every conversation's files — and the
    // whole tree was read into memory before being written, with no bound.
    if (p === '/api/files/zip' && method === 'GET') {
      const rel = u.searchParams.get('path') || '';
      const chatId = u.searchParams.get('chatId') || null;
      if (!store.isValidChatId(chatId)) {
        return sendJSON(res, 400, { error: 'A chatId is required to download workspace files.' });
      }
      try {
        const base = toolsKit.safePath(rel, chatId);
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
          return sendJSON(res, 404, { error: 'Folder not found' });
        }
        const files = [];
        let totalBytes = 0;
        let skipped = 0;
        const collect = (dir, prefix) => {
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            const relPath = prefix ? prefix + '/' + e.name : e.name;
            if (e.isDirectory()) { collect(full, relPath); continue; }
            let size = 0;
            let mtime = Date.now();
            try {
              const st = fs.statSync(full);
              size = st.size;
              mtime = st.mtimeMs;
            } catch { continue; }
            // The archive is built in memory, so the total is bounded rather
            // than letting one download exhaust the process.
            if (totalBytes + size > MAX_ZIP_BYTES) { skipped++; continue; }
            totalBytes += size;
            files.push({ path: relPath, data: fs.readFileSync(full), mtime });
          }
        };
        collect(base, '');
        if (!files.length) return sendJSON(res, 404, { error: 'Folder is empty' });
        const buf = zip.zipStore(files);
        const folderName = (path.basename(base) || 'workspace').replace(/["\r\n\\/]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${folderName}.zip"`,
          'Content-Length': buf.length,
          'Cache-Control': 'no-store',
          ...(skipped ? { 'X-Hama-Skipped-Files': String(skipped) } : {})
        });
        return res.end(buf);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    // ---- static workspace server for multi-file web apps & React sandbox ----
    const wsMatch = p.match(/^\/api\/workspace\/([^/]+)\/(.+)$/);
    if (wsMatch && method === 'GET') {
      const chatId = decodeURIComponent(wsMatch[1]);
      const rel = decodeURIComponent(wsMatch[2]);
      try {
        if (rel === '__react_preview__') {
          const html = await buildReactApp(chatId);
          if (html) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store'
            });
            return res.end(html);
          }
          // No React/TSX entry file — surface a readable reason instead of a
          // bare 404 so the preview iframe is never a silent "File not found".
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          return res.end('<!DOCTYPE html><html><body style="font-family:monospace;padding:24px;background:#0f172a;color:#cbd5e1;line-height:1.7;"><h3 style="color:#f59e0b;margin-top:0;">No React entry found</h3><p>HAMA could not find a React/TSX entry file in this chat\'s workspace.</p><p style="color:#64748b;">Ask the agent to create <code style="color:#38bdf8">src/App.tsx</code> (or <code style="color:#38bdf8">App.tsx</code>), then reload the preview.</p></body></html>');
        }

        const full = toolsKit.safePath(rel, chatId);
        if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
          // If index.html was requested but doesn't exist, check if a React TSX app exists!
          if (rel === 'index.html') {
            const html = await buildReactApp(chatId);
            if (html) {
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
              });
              return res.end(html);
            }
          }
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('File not found');
        }
        const ext = path.extname(full).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        return pipeFile(res, full);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end(e.message);
      }
    }

    // ---- script runner (Python & Node.js) for live terminal console ----
    if (p === '/api/run' && method === 'POST') {
      const body = await readBody(req);
      const chatId = body.chatId || null;
      const filePath = body.path || '';
      const code = body.code || '';
      const language = body.language || '';

      // Running a file that already exists is a chat-scoped action: without a
      // chat it resolved against the shared root, where any other
      // conversation's script is a runnable path. Ad-hoc `code` still runs in
      // the scratch root, which is the console's no-chat case.
      if (filePath && !store.isValidChatId(chatId)) {
        return sendJSON(res, 400, { ok: false, error: 'A chatId is required to run a file from a workspace.' });
      }

      let targetFile = filePath;
      let scratchFile = null;
      if (!targetFile && code) {
        const ext = language === 'python' ? '.py' : '.js';
        targetFile = `_scratch_run_${Date.now()}${ext}`;
        scratchFile = targetFile;
        try {
          const full = toolsKit.safePath(targetFile, chatId);
          fs.writeFileSync(full, code, 'utf8');
        } catch (e) {
          return sendJSON(res, 400, { ok: false, error: e.message });
        }
      }

      if (!targetFile) {
        return sendJSON(res, 400, { ok: false, error: 'path or code is required' });
      }

      try {
        const resRun = await toolsKit.runScript({
          path: targetFile,
          args: body.args || [],
          language,
          chatId,
          timeoutMs: 25000
        });
        return sendJSON(res, 200, resRun);
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      } finally {
        // A scratch file was only ever a way to hand code to the runner. Leaving
        // it behind cluttered the workspace, the ZIP download and the preview's
        // entry-point scan.
        if (scratchFile) {
          try { fs.unlinkSync(toolsKit.safePath(scratchFile, chatId)); } catch { /* best effort */ }
        }
      }
    }

    // ---- stop an active stream ----
    const stopMatch = p.match(/^\/api\/chat\/([\w-]+)\/stop$/);
    if (stopMatch && method === 'POST') {
      // Every turn streaming into this chat is aborted — a Set can hold more
      // than one when two tabs (or a reload) have a turn running at once.
      const acs = activeStreams.get(stopMatch[1]);
      let stopped = 0;
      if (acs) for (const ac of acs) { ac.abort(); stopped++; }
      return sendJSON(res, 200, { ok: true, wasActive: stopped > 0, stopped });
    }

    // ---- chat (SSE) ----
    if (p === '/api/chat' && method === 'POST') {
      const body = await readBody(req);
      // AWAITED, and caught here on purpose.
      //
      // `return handleChat(...)` inside the outer try/catch looked guarded and
      // was not: a try/catch cannot intercept a rejected promise it merely
      // returns. Any rejection escaping the turn therefore became an unhandled
      // rejection, Node exited, and every in-flight turn was discarded with no
      // assistant message written — the recorded failure. The turn is the
      // longest-lived work this server does, so it is the one that must be held.
      try {
        await handleChat(req, res, body, { sendJSON, activeStreams });
      } catch (e) {
        console.error('[chat] the turn failed before it could be committed:', e);
        if (!res.headersSent) {
          sendJSON(res, 500, { error: (e && e.message) || 'The turn failed.' });
        } else {
          // The stream is already open: end it with a real terminal event so the
          // client stops waiting instead of spinning on a dead socket.
          try {
            res.write(`data: ${JSON.stringify({
              type: 'error',
              message: 'The server hit an internal error during this turn: ' + ((e && e.message) || String(e))
            })}\n\n`);
          } catch { /* closed */ }
          try { res.end(); } catch { /* closed */ }
        }
      }
      return;
    }

    // ---- static ----
    if (method === 'GET') return serveStatic(req, res, p);

    sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('Server error:', e);
    if (!res.headersSent) sendJSON(res, 500, { error: e.message || 'Internal server error' });
    else try { res.end(); } catch { /* ignore */ }
  }
});

// A host without a mounted volume — Render's free plan, Hugging Face Spaces —
// starts with an empty data/ every time. See src/env-provider.js: this is the
// only configuration that survives that, and it stays out of the way of a
// console somebody has already configured. Failure here must never stop the
// server from booting.
let envSeededProvider = null;
try {
  const seeded = seedProviderFromEnv();
  envSeededProvider = seeded.provider;
  if (seeded.provider) {
    console.log(`  ✦ Provider "${seeded.provider.name}" added from the environment (${seeded.provider.model}). The key was not logged.`);
  } else if (process.env.HAMA_PROVIDER_KEY) {
    console.log(`  ✦ HAMA_PROVIDER_KEY is set but no provider was added: ${seeded.reason}.`);
  }
} catch (e) {
  console.error('  ✦ Could not add a provider from the environment:', (e && e.message) || e);
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  const booted = new Date(BOOT_AT).toLocaleTimeString();
  // The REAL bound port: PORT=0 asks the OS for a free one, and printing the
  // request would announce the wrong address. This is also what the test
  // harness greps to find the server.
  const actual = server.address() && server.address().port;
  console.log(`\n  ✦ HAMA AI Support Agent running at http://${shown}:${actual}`);
  console.log(`    code version ${VERSION} · process started ${booted}`);
  console.log('    Backend code is read ONCE at startup — a src/ edit needs a restart.');
  console.log('    Use `npm run dev` while editing backend code, and check /api/health');
  console.log('    (or the on-screen badge) if a change seems not to have applied.\n');
});
