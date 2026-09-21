// Authentication for a console that can run shell commands.
//
// WHY THIS EXISTS
// Every endpoint in this app is powerful: it reads and writes files, runs
// scripts, spawns shells, and returns stored API keys to the settings form. The
// server therefore bound to 127.0.0.1 by default and its comments said so — but
// a deployment has to listen on a public interface, and a public address with no
// authentication hands all of that to anyone who finds the URL.
//
// The model is deliberately small: one operator token, exchanged for a session
// cookie. There is no user database, no password reset, no roles — this is a
// single-tenant console, and inventing an account system would add attack
// surface without adding safety.
//
// WHAT IT PROTECTS
//  - every `/api/*` route except the health check and the workspace asset route
//  - every static file, which is why an unauthenticated page load is redirected
//    to the login form rather than served the console shell
//
// The workspace asset route is public on purpose. It serves only files from the
// workspace of the chat named in its (unguessable, randomly generated) id, it is
// read-only, and the preview iframe runs in an opaque origin that cannot attach
// cookies on every host — gating it broke Live App previews, and a broken
// preview is a worse outcome than a capability URL for generated code.
'use strict';

const crypto = require('crypto');

/** Name of the session cookie. */
const COOKIE_NAME = 'hama_session';
/** How long a session lasts. Long, because this is a personal console. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Failed login attempts allowed per address inside the window. */
const MAX_ATTEMPTS = 10;
/** Window those attempts are counted over. */
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Compares two strings without leaking their difference through timing.
 *
 * A plain `===` on a secret returns as soon as a byte differs, which lets an
 * attacker recover the token one character at a time. Lengths are compared
 * first because `timingSafeEqual` throws on a length mismatch.
 *
 * @param {string} a - the candidate.
 * @param {string} b - the secret.
 * @returns {boolean} whether they are identical.
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** The cookie header's value for one name, or null. */
function readCookie(req, name) {
  const header = req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * The address a throttle decision is keyed on.
 *
 * Behind a host's proxy this is the forwarded address; locally it is the socket.
 * It is only used to slow down guessing, so a spoofed value costs the attacker
 * nothing they did not already have.
 *
 * @param {import('http').IncomingMessage} req - the request.
 * @returns {string} the client address.
 */
function clientIp(req) {
  const fwd = req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Builds the auth helper for one process.
 *
 * @param {object} options - configuration.
 * @param {string} [options.token] - the operator token; empty disables auth entirely.
 * @returns {object} the auth surface used by the server.
 */
function createAuth({ token = '' } = {}) {
  const expected = String(token || '');
  const enabled = expected.length > 0;
  /** session id -> expiry timestamp */
  const sessions = new Map();
  /** address -> { count, resetAt } */
  const attempts = new Map();

  /** Drops expired sessions and stale throttle entries. */
  function sweep(now = Date.now()) {
    for (const [id, expires] of sessions) if (expires <= now) sessions.delete(id);
    for (const [ip, entry] of attempts) if (entry.resetAt <= now) attempts.delete(ip);
  }

  /**
   * Whether a path may be reached without a session.
   *
   * @param {string} pathname - the request path.
   * @returns {boolean} true when the path is public.
   */
  function publicPath(pathname) {
    if (pathname === '/login' || pathname === '/logout') return true;
    if (pathname === '/api/health') return true;
    if (pathname === '/favicon.ico') return true;
    // Read-only workspace assets: the preview iframe cannot reliably carry the
    // cookie from an opaque origin.
    if (pathname.startsWith('/api/workspace/')) return true;
    return false;
  }

  /**
   * Whether the request carries a valid token or session.
   *
   * @param {import('http').IncomingMessage} req - the request.
   * @returns {boolean} true when authorised (always true with auth disabled).
   */
  function isAuthed(req) {
    if (!enabled) return true;
    const auth = req.headers && req.headers.authorization;
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
      if (safeEqual(auth.replace(/^Bearer\s+/i, '').trim(), expected)) return true;
    }
    const id = readCookie(req, COOKIE_NAME);
    if (!id) return false;
    const expires = sessions.get(id);
    if (!expires) return false;
    if (expires <= Date.now()) {
      sessions.delete(id);
      return false;
    }
    return true;
  }

  /**
   * Records a login attempt and reports whether the caller is now throttled.
   *
   * @param {string} ip - the client address.
   * @param {boolean} ok - whether the attempt succeeded.
   * @returns {{blocked: boolean, retryAfterSec: number}} the throttle decision.
   */
  function noteAttempt(ip, ok) {
    if (!enabled || ok) return { blocked: false, retryAfterSec: 0 };
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
      return { blocked: false, retryAfterSec: 0 };
    }
    entry.count++;
    if (entry.count > MAX_ATTEMPTS) {
      return { blocked: true, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    }
    return { blocked: false, retryAfterSec: 0 };
  }

  /**
   * Exchanges a token for a session cookie.
   *
   * @param {unknown} candidate - the submitted token.
   * @param {import('http').IncomingMessage} req - the request, for the address.
   * @param {import('http').ServerResponse} res - the response to set the cookie on.
   * @returns {{ok: boolean, error?: string, retryAfterSec?: number}} the outcome.
   */
  function login(candidate, req, res) {
    if (!enabled) return { ok: true };
    const ip = clientIp(req);
    const gate = noteAttempt(ip, false);
    if (gate.blocked) {
      return { ok: false, error: 'Too many attempts. Try again shortly.', retryAfterSec: gate.retryAfterSec };
    }
    if (!safeEqual(candidate, expected)) return { ok: false, error: 'That token is not correct.' };

    sweep();
    const id = crypto.randomBytes(24).toString('hex');
    sessions.set(id, Date.now() + SESSION_TTL_MS);
    setCookie(req, res, id);
    return { ok: true };
  }

  /** Clears the caller's session. */
  function logout(req, res) {
    const id = readCookie(req, COOKIE_NAME);
    if (id) sessions.delete(id);
    setCookie(req, res, '', 0);
  }

  /**
   * Sets the session cookie.
   *
   * `Secure` and `SameSite=None` are used when the request arrived over TLS,
   * which is how a sandboxed preview frame can still fetch its own assets; over
   * plain HTTP (local use) the pair would be rejected by the browser, so a plain
   * `Lax` cookie is used instead.
   *
   * @param {import('http').IncomingMessage} req - the request.
   * @param {import('http').ServerResponse} res - the response.
   * @param {string} value - the cookie value (empty to clear).
   * @param {number} [maxAgeMs] - lifetime; 0 clears.
   */
  function setCookie(req, res, value, maxAgeMs = SESSION_TTL_MS) {
    const secure = isSecure(req);
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      secure ? 'SameSite=None' : 'SameSite=Lax'
    ];
    if (secure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  /** Whether this request arrived over TLS (directly or through a proxy). */
  function isSecure(req) {
    const proto = req.headers && req.headers['x-forwarded-proto'];
    if (typeof proto === 'string') return proto.split(',')[0].trim() === 'https';
    return Boolean(req.socket && req.socket.encrypted);
  }

  /**
   * The login form.
   *
   * Self-contained and inline: a deployment must not depend on the static
   * handler, which is itself behind the gate.
   *
   * @param {object} [options] - presentation.
   * @param {string} [options.error] - message to show.
   * @param {string} [options.agentName] - the console's display name.
   * @returns {string} the HTML page.
   */
  function loginPage({ error = '', agentName = 'HAMA' } = {}) {
    const name = String(agentName).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const message = error
      ? `<p class="err">${String(error).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))}</p>`
      : '';
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0b0f14; color:#e6edf3;
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  form { width:min(360px,92vw); background:#121821; border:1px solid #223041;
         border-radius:14px; padding:26px 24px; }
  h1 { margin:0 0 6px; font-size:17px; letter-spacing:-.2px; }
  p.sub { margin:0 0 18px; color:#8fa3b8; font-size:13px; }
  label { display:block; font-size:12px; font-weight:600; color:#8fa3b8;
          text-transform:uppercase; letter-spacing:.4px; margin-bottom:6px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:9px;
          border:1px solid #2a3a4d; background:#0e131a; color:#e6edf3; font:inherit; }
  input:focus { outline:2px solid #3b82f6; outline-offset:1px; border-color:#3b82f6; }
  button { width:100%; margin-top:16px; padding:11px 14px; border:0; border-radius:9px;
           background:#3b82f6; color:#fff; font:inherit; font-weight:650; cursor:pointer; }
  button:hover { background:#2f6fd8; }
  .err { margin:14px 0 0; padding:9px 11px; border-radius:9px; font-size:13px;
         color:#f8a5a0; background:rgba(248,81,73,.10); border:1px solid rgba(248,81,73,.30); }
  .hint { margin:16px 0 0; color:#61748a; font-size:12px; }
</style></head>
<body>
  <form method="POST" action="/login" autocomplete="off">
    <h1>${name}</h1>
    <p class="sub">This console can run commands on the host, so it is password protected.</p>
    <label for="token">Access token</label>
    <input id="token" name="token" type="password" placeholder="HAMA_TOKEN" autofocus required>
    <button type="submit">Sign in</button>
    ${message}
    <p class="hint">The token is the <code>HAMA_TOKEN</code> value set on the server.</p>
  </form>
</body></html>`;
  }

  return {
    enabled,
    publicPath,
    isAuthed,
    login,
    logout,
    loginPage,
    noteAttempt,
    sweep,
    COOKIE_NAME,
    SESSION_TTL_MS,
    MAX_ATTEMPTS
  };
}

module.exports = { createAuth, safeEqual, readCookie, clientIp, COOKIE_NAME, SESSION_TTL_MS, MAX_ATTEMPTS };
