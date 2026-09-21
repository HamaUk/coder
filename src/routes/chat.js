// PHASE 2 — Chat route.
//
// Mirrors Open WebUI's `chat_completion()` entry point: it owns the HTTP-facing
// concerns (resolve the chat, pick the provider, record the user turn, open the
// SSE stream, keep it alive, honour abort) and then delegates the actual work —
// payload prep → dispatch → loop — to the phases downstream. Finalization is
// handed to ./middleware/finalize.
//
// The SSE event names and payloads emitted here are a frozen contract with
// public/app.js.
const store = require('../store');
const agent = require('../agent');
const { finalizeChat, buildAssistantMessage } = require('../middleware/finalize');

const KEEPALIVE_MS = 15000;

// Stop a turn rather than let a stalled browser reader grow this process
// without bound. Only counts bytes written while the socket buffer stayed full.
const MAX_UNFLUSHED_BYTES = 32 * 1024 * 1024;

// Context-window guard. Every turn re-sends the whole transcript and every tool
// result verbatim, and nothing else bounds it: a long conversation (or one big
// read_file) eventually exceeds the provider's limit, after which EVERY new turn
// fails with HTTP 400 until the user abandons the chat. Oldest turns are dropped
// at message boundaries and any single oversized message is clipped.
const MAX_HISTORY_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 120000;

function clipMessageContent(text) {
  const s = String(text == null ? '' : text);
  if (s.length <= MAX_MESSAGE_CHARS) return s;
  const omitted = s.length - MAX_MESSAGE_CHARS;
  return s.slice(0, MAX_MESSAGE_CHARS) +
    `\n\n…[${omitted} characters omitted to stay inside the model's context window]`;
}

/**
 * Bounds a chat transcript to what a model call can actually carry.
 * Dropping messages never splits a tool-call from its result here, because the
 * persisted transcript only ever contains plain user/assistant turns.
 *
 * @returns {{ messages: Array, trimmed: boolean }}
 */
function boundHistory(messages) {
  const all = Array.isArray(messages) ? messages : [];
  const clipped = all.map(m => ({ role: m.role, content: clipMessageContent(m.content) }));
  const trimmed = clipped.some((m, i) => m.content !== all[i].content);
  if (clipped.length <= MAX_HISTORY_MESSAGES) return { messages: clipped, trimmed };

  let start = clipped.length - MAX_HISTORY_MESSAGES;
  // A conversation must not open with an assistant turn.
  while (start < clipped.length && clipped[start].role !== 'user') start++;
  return { messages: clipped.slice(start), trimmed: true };
}

/**
 * Handles POST /api/chat.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse}  res
 * @param {object} body   parsed request body
 * @param {object} deps   { sendJSON, activeStreams }
 */
async function handleChat(req, res, body, deps) {
  const { sendJSON, activeStreams } = deps;

  const message = String(body.message || '').trim();

  // Attachments: images become vision blocks (kept in-memory for this turn so
  // chats.json is never bloated with base64), text/code files are folded into
  // the message so every model — vision-capable or not — can read them.
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  // An attachment with no message text is a complete request — the file IS the
  // turn. Rejecting it here meant an image-only send produced a 400 the client
  // never surfaced, after the composer had already cleared itself.
  if (!message && !attachments.length) return sendJSON(res, 400, { error: 'message is required' });

  const images = [];
  const textBlocks = [];
  const attachMeta = [];
  for (const a of attachments) {
    const name = String(a.name || 'file');
    const mime = String(a.mime || '');
    const type = a.type === 'image' ? 'image' : 'file';
    attachMeta.push({ name, mime, type });
    if (type === 'image' && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:image/')) {
      images.push({ dataUrl: a.dataUrl, mime: mime || 'image/png' });
    } else if (typeof a.text === 'string' && a.text.trim()) {
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      textBlocks.push(`[Attached file: ${name}]\n\`\`\`${ext}\n${a.text}\n\`\`\``);
    }
  }
  // A turn carried only by an attachment still needs words in the transcript:
  // an empty user row renders as a blank bubble and titles the chat "". The
  // model gets a plain instruction, and the attachment rides alongside it.
  const ask = message || (images.length ? 'Please look at the attached image.' : 'Please look at the attached file.');
  const fullMessage = textBlocks.length ? textBlocks.join('\n\n') + '\n\n' + ask : ask;

  // ---- resolve chat + record the user turn (one locked transaction) --------
  // Re-reading inside the lock means a chat created or renamed concurrently is
  // seen, instead of being overwritten by a snapshot taken a moment earlier.
  const chat = await store.mutateChats((chats) => {
    let c = chats.find(x => x.id === body.chatId);
    if (!c) {
      c = {
        id: 'chat_' + store.uid().slice(0, 8),
        title: message.replace(/\s+/g, ' ').slice(0, 48),
        providerId: body.providerId || null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: []
      };
      chats.push(c);
    } else if (c.messages.length === 0 && c.title === 'New conversation') {
      c.title = message.replace(/\s+/g, ' ').slice(0, 48);
    }
    c.messages.push({ id: store.uid(), role: 'user', content: fullMessage, attachments: attachMeta, ts: Date.now() });
    c.updatedAt = Date.now();
    return c;
  });

  // ---- resolve provider (requested → chat → default → first enabled) ------
  const settings = store.getSettings();
  const providers = store.getProviders();
  const wantId = body.providerId || chat.providerId || settings.defaultProviderId;
  let provider = providers.find(x => x.id === wantId && x.enabled);
  if (!provider) provider = providers.find(x => x.enabled) || providers[0];
  if (!provider) return sendJSON(res, 400, { error: 'No provider configured' });

  const activeModel = body.model || chat.model || provider.model;
  if (activeModel) provider = { ...provider, model: activeModel };

  await store.mutateChats((chats) => {
    const c = chats.find(x => x.id === chat.id);
    if (!c) return;
    c.providerId = provider.id;
    c.model = provider.model;
  });

  // ---- open the SSE stream ----------------------------------------------
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();

  // Registry for POST /api/chat/:id/stop.
  //
  // A Set of controllers, not a single one: two overlapping turns on the same
  // chat — a second tab, or a reload while the first turn is still streaming —
  // must both be reachable by Stop. With a single slot the newer turn silently
  // overwrote the older one's handle, so Stop aborted only one of them and the
  // other kept calling the model (and billing tokens) with no way to stop it.
  const ac = new AbortController();
  const acs = activeStreams.get(chat.id) || new Set();
  acs.add(ac);
  activeStreams.set(chat.id, acs);
  const releaseStream = () => {
    const set = activeStreams.get(chat.id);
    if (!set) return;
    set.delete(ac);
    if (!set.size) activeStreams.delete(chat.id);
  };

  // Set once the response is being closed, so a late emit from the loop cannot
  // write to a finished stream.
  let finished = false;
  // Bytes handed to `res.write` while the socket buffer stayed full. The return
  // value of write() is otherwise ignored, which lets a stalled reader grow the
  // server's memory without bound (each tool result is sent in full).
  let unflushed = 0;
  const send = (type, data = {}) => {
    if (finished) return;
    let frame;
    try { frame = `data: ${JSON.stringify({ type, ...data })}\n\n`; } catch { return; }
    let ok = true;
    try { ok = res.write(frame); } catch { return; }
    if (ok) { unflushed = 0; return; }
    unflushed += frame.length;
    if (unflushed > MAX_UNFLUSHED_BYTES && !ac.signal.aborted) {
      try {
        res.write(`data: ${JSON.stringify({
          type: 'error',
          message: 'The browser stopped reading this reply, so the turn was stopped rather than buffering without limit.'
        })}\n\n`);
      } catch { /* closed */ }
      ac.abort();
    }
  };
  send('started', { chatId: chat.id, providerId: provider.id, title: chat.title });

  // A client that goes away — a tab closed, a crashed handler, a network drop —
  // must stop the turn, or the server keeps calling the provider (and billing
  // tokens) into a socket nobody reads.
  //
  // The signal is the RESPONSE's close, not the request's. `req.on('close')`
  // fires when the request MESSAGE completes — the body was fully read before
  // this handler could even attach — so the original listener never ran for a
  // disconnect at all, and a hung-up turn kept streaming to the end while the
  // transcript recorded it as completed. `res.on('close')` fires when the
  // connection actually drops; `writableEnded` is true only when this route
  // finished the response itself, so the abort targets exactly the disconnect.
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const keepAlive = setInterval(() => {
    if (finished) return;
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, KEEPALIVE_MS);
  const startedAt = Date.now();

  // ---- run --------------------------------------------------------------
  const bounded = boundHistory(chat.messages);
  const history = bounded.messages;
  if (bounded.trimmed) {
    send('status', { text: 'This conversation is long — older parts were summarised away to fit the model\'s context window.' });
  }
  // Attach this turn's images to the just-recorded user message (memory only).
  if (images.length && history.length) history[history.length - 1].images = images;
  const tools = body.tools || { web: true, files: true, code: true };
  const budget = agent.resolveLimits(body.budget, settings);

  let result = { text: '', toolRuns: [], mode: 'direct' };
  let aborted = false;

  // The floor the transcript can never fall below: everything this route has
  // itself witnessed and forwarded to the client.
  //
  // `result` normally arrives from the agent, but there are paths where it does
  // not — a throw after the loop succeeded (repair, crew, auto-save) discarded
  // the main run's output entirely, and the turn that had visibly streamed seven
  // tool steps then persisted NOTHING: the transcript lost work the user watched
  // happen. Whatever reached the client is the minimum that must reach the
  // transcript, so the route records it as the events go out.
  const streamed = { text: '', toolRuns: [], reasoning: '' };
  const toolStartArgs = new Map();
  const emit = (type, data = {}) => {
    try {
      if (type === 'token' && typeof data.text === 'string') streamed.text += data.text;
      // The loop retracts text it streamed live and then decided not to keep —
      // a suppressed repeat, a dropped tool echo, an authoritative re-render.
      // The floor has to follow the same edit, or a turn rescued by the floor
      // would put the retracted copies straight back into the transcript (which
      // is exactly how one paragraph was persisted seven times).
      else if (type === 'retract') {
        const gone = typeof data.text === 'string' ? data.text : '';
        if (gone && streamed.text.endsWith(gone)) streamed.text = streamed.text.slice(0, -gone.length);
        if (typeof data.replace === 'string') streamed.text += data.replace;
      }
      else if (type === 'thinking' && typeof data.text === 'string') streamed.reasoning += data.text;
      else if (type === 'tool_start') toolStartArgs.set(data.id, data.args);
      else if (type === 'tool_end') {
        streamed.toolRuns.push({
          id: data.id,
          name: data.name,
          args: toolStartArgs.get(data.id) || {},
          ok: data.ok,
          result: data.result,
          meta: data.meta,
          step: data.step,
          startedAt: data.startedAt,
          ms: data.ms,
          ts: Date.now()
        });
      }
    } catch { /* recording must never break the stream */ }
    send(type, data);
  };

  try {
    try {
      result = await agent.runAgent({
        provider,
        providers: store.getProviders(),
        history,
        tools,
        settings,
        signal: ac.signal,
        emit,
        chatId: chat.id,
        budget
      });
      result.mode = 'direct';
      // The loop reports a timeout by returning `aborted` rather than throwing,
      // so the flag has to be merged or the transcript would record a cancelled
      // turn as a completed one.
      if (result.aborted) aborted = true;
    } catch (e) {
      // A provider may reject with a non-Error. Every property access below is
      // guarded: throwing from inside this catch would skip the terminal event
      // entirely and the client would spin forever.
      const partial = e && typeof e === 'object' ? e.partial : null;
      // Keep whatever the user already read. The loop attaches its partial output
      // to the error it throws, so a Stop no longer discards the half of the
      // answer that made it to the screen.
      if (partial) {
        result = {
          ...result,
          text: partial.text || result.text,
          toolRuns: partial.toolRuns || result.toolRuns,
          reasoning: partial.reasoning || result.reasoning
        };
      }
      if (e && e.name === 'AbortError') {
        aborted = true;
        send('aborted', {});
      } else {
        send('error', { message: (e && e.message) || String(e || 'Unknown error') });
      }
    }

    // The streamed floor fills whatever the agent result lost. It never
    // overrides anything the agent returned — it only rescues emptiness.
    if (!result.text && streamed.text) result.text = streamed.text;
    if (!(result.toolRuns && result.toolRuns.length) && streamed.toolRuns.length) {
      result.toolRuns = streamed.toolRuns;
    }
    if (!result.reasoning && streamed.reasoning) result.reasoning = streamed.reasoning;

    // ---- finalize ---------------------------------------------------------
    // Committing the turn is the one step that must not be allowed to lose it.
    // A write can fail transiently — a file locked by a sync client or a virus
    // scanner, a full disk, a rename that lost a race — and this app lives on a
    // synced Desktop folder where exactly that happens. It used to be a single
    // attempt whose failure sent an error and returned WITHOUT a terminal event:
    // the reply the user had already read was never saved, and the live bubble
    // was left in a state no reload could reproduce. Now: one retry, and if the
    // store is genuinely unwritable the message is still delivered in memory so
    // the transcript on screen stays complete and the user is told plainly.
    let messageEnd;
    try {
      ({ messageEnd } = await finalizeChat({
        chatId: chat.id,
        result,
        provider,
        aborted,
        ms: Date.now() - startedAt
      }));
    } catch (first) {
      let saved = null;
      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        ({ messageEnd, assistantMsg: saved } = await finalizeChat({
          chatId: chat.id,
          result,
          provider,
          aborted,
          ms: Date.now() - startedAt
        }));
      } catch (second) {
        const why = (second && second.message) || String(second || 'unknown error');
        send('error', {
          message: 'This reply could not be saved to disk, so it will not be here after a reload: ' + why
        });
        // The message is real — it was streamed and its tool runs really ran —
        // so the client gets it as a normal terminal message. It simply is not
        // in chats.json.
        const volatile = buildAssistantMessage(result, provider, { aborted, ms: Date.now() - startedAt });
        send('message_end', {
          message: volatile,
          aborted,
          chat: null,
          saved: false,
          provider: { id: provider.id, name: provider.name, model: provider.model, presetId: provider.presetId }
        });
        console.error(`[chat] could not persist turn for ${chat.id}: ${why}`, first && first.message ? `(first attempt: ${first.message})` : '');
        return;
      }
    }
    send('message_end', messageEnd);
  } finally {
    // Every exit path — including a throw from finalize — must stop the
    // keep-alive timer and close the response.
    finished = true;
    clearInterval(keepAlive);
    releaseStream();
    try { res.end(); } catch { /* already closed */ }
  }
}

module.exports = { handleChat, boundHistory, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS };
