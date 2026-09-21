// LlamaCoder internal pipeline integration (no API key required)
// Overridable so the engine can be pointed at a local stub in tests.
const LLAMACODER_BASE = process.env.HAMA_LLAMACODER_BASE || 'https://llamacoder.together.ai';
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4-Flash-0731';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MODELS = [
  'deepseek-ai/DeepSeek-V4-Flash-0731',
  'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'Qwen/Qwen2.5-Coder-32B-Instruct',
  'zai-org/GLM-5.3-Flash',
  'zai-org/GLM-5.2'
];

/**
 * Creates a chat session and returns { chatId, lastMessageId }
 */
async function createChat({ prompt, model = DEFAULT_MODEL, screenshotToken = null, signal }) {
  const payload = { prompt, model };
  if (screenshotToken) payload.screenshotToken = screenshotToken;

  const res = await fetch(`${LLAMACODER_BASE}/api/create-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Hama AI engine create-chat failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  return await res.json();
}

/**
 * Streams completion tokens from LlamaCoder and accumulates the full text
 */
async function streamCompletion({ messageId, model = DEFAULT_MODEL, signal, onToken }) {
  const res = await fetch(`${LLAMACODER_BASE}/api/get-next-completion-stream-promise`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA
    },
    body: JSON.stringify({ messageId, model }),
    signal
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Hama AI engine stream failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let unparsed = 0;

  // Tolerates both bare-JSON-lines and `data: {…}` SSE framing, and counts what
  // it could not parse. The old version silently swallowed everything it did not
  // understand, so a framing change produced a "successfully generated (0
  // chars)" result instead of an error.
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const body = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!body || body === '[DONE]') return;
    try {
      const chunk = JSON.parse(body);
      const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.text;
      if (delta) {
        fullText += delta;
        if (onToken) onToken(delta);
      }
    } catch {
      unparsed++;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) handleLine(line);
  }

  // Flush both the decoder and the final line. Without this the last JSON object
  // of every stream was discarded, truncating the generated file.
  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);

  if (!fullText && unparsed) {
    throw new Error(`The Hama AI engine stream could not be parsed (${unparsed} unrecognised chunk(s)) — its response format may have changed.`);
  }

  return fullText;
}

/**
 * Fetch generated title for the chat
 */
async function generateTitle(chatId) {
  try {
    const res = await fetch(`${LLAMACODER_BASE}/api/generate-chat-title`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ chatId })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.title || null;
  } catch {
    return null;
  }
}

/**
 * Extracts clean code from LlamaCoder markdown output (handles ```html{path=...}, ```tsx, etc.)
 */
function extractCode(raw) {
  if (!raw || typeof raw !== 'string') return '';
  // Multi-line code block with optional info/path
  const match = raw.match(/```[^\r\n]*?(?:\{path=[^}]+\})?[^\r\n]*\r?\n([\s\S]*?)(?:```|$)/);
  if (match && match[1].trim()) {
    let code = match[1].trim();
    // Check if the opening line had inline code after {path=...}
    const firstLineMatch = raw.match(/```[^\r\n]*?\{path=[^}]+\}\s*([^\r\n]+)/);
    if (firstLineMatch && firstLineMatch[1].trim()) {
      code = firstLineMatch[1].trim() + '\n' + code;
    }
    return code;
  }
  // Single-line or inline code block (e.g. ```html {path="..."} <!DOCTYPE html>...)
  const inlineMatch = raw.match(/```[^\r\n]*?(?:\{path=[^}]+\})?\s*([<{\w][\s\S]*?)(?:```|$)/);
  if (inlineMatch && inlineMatch[1].trim()) {
    let candidate = inlineMatch[1].trim();
    return candidate.replace(/```\s*$/, '').trim();
  }
  return raw.trim();
}

/**
 * Parse DSML tool calls emitted by DeepSeek / LlamaCoder models
 */
function parseDSML(text) {
  const toolCalls = [];
  const tcBlockMatch = text.match(/<[|｜]DSML[|｜]tool_calls>([\s\S]*?)(?:<\/[|｜]DSML[|｜]tool_calls>|$)/i);
  if (!tcBlockMatch) return { text, toolCalls };

  const cleanText = text.replace(/<[|｜]DSML[|｜]tool_calls>[\s\S]*?(?:<\/[|｜]DSML[|｜]tool_calls>|$)/gi, '').trim();
  const blockContent = tcBlockMatch[1];

  const invokeRe = /<[|｜]DSML[|｜]invoke\s+name=["']([^"']+)["']>([\s\S]*?)(?:<\/[|｜]DSML[|｜]invoke>|$)/gi;
  let inv;
  let idx = 1;
  while ((inv = invokeRe.exec(blockContent)) !== null) {
    const name = inv[1];
    const paramsBlock = inv[2];
    const args = {};
    // `name = "x"` with spaces around the `=` is emitted often enough to matter,
    // and the original pattern required them to be absent — so the parameter did
    // not match, the argument object came back EMPTY, and the tool then refused
    // a payload the model believed it had sent ("nothing to write").
    //
    // The value ends at the close tag OR at the next DSML tag, whichever comes
    // first. Without that second boundary an unterminated parameter — the normal
    // shape when a response runs out of room mid-JSON — swallowed the markup
    // after it, so a later parameter's tag ended up inside the earlier value.
    const paramRe = /<[|｜]DSML[|｜]parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/[|｜]DSML[|｜]parameter>|<[|｜]DSML[|｜]|$)/gi;
    let p;
    while ((p = paramRe.exec(paramsBlock)) !== null) {
      const rawVal = p[2].trim();
      args[p[1]] = parseParamValue(rawVal);
    }
    toolCalls.push({
      id: 'call_dsml_' + Date.now() + '_' + (idx++),
      name,
      args
    });
  }
  return { text: cleanText, toolCalls };
}

/**
 * The value of one DSML parameter, as the model meant it.
 *
 * A model writing a JSON argument frequently wraps it in a Markdown code fence —
 * ```json … ``` — even when told not to, because that is how it writes JSON
 * everywhere else. `JSON.parse` refuses the fence, the value fell through as a
 * raw string, and the tool received `"```json\n{…}\n```"` as its `files`
 * argument: an object the model had written correctly, refused as unreadable.
 *
 * A truncated value is the other common shape — the response ran out of room
 * mid-JSON — and is left for the tool's own recovery to attempt rather than
 * being "fixed" here into something the model did not write.
 *
 * @param {string} raw - the trimmed parameter body.
 * @returns {unknown} the parsed value, or the raw string when it is not JSON.
 */
function parseParamValue(raw) {
  const text = unwrapCodeFence(raw);
  try {
    return JSON.parse(text);
  } catch {
    return raw;
  }
}

/**
 * Strips one Markdown code fence around a value, if there is one.
 *
 * @param {string} raw - the parameter body.
 * @returns {string} the body without its fence.
 */
function unwrapCodeFence(raw) {
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(raw.trim());
  return fenced ? fenced[1].trim() : raw;
}

// ---------------------------------------------------------------------------
// DSML markup removal
// ---------------------------------------------------------------------------
// The free engine has no structured tool API: it is *told* to emit
// `<|DSML|tool_calls>…` and this module turns that back into real tool calls.
// The markup must never reach the transcript, which is what makes the stripping
// here load-bearing rather than cosmetic. (Both ASCII `|` and full-width `｜`
// pipes are accepted — the engine emits either.)
const DSML_MARKERS = ['<|DSML|', '<｜DSML｜'];

/**
 * Removes every trace of DSML markup from a piece of text, WITHOUT tidying
 * whitespace — so repeated calls over a growing buffer stay monotonic, which is
 * what the streaming filter below relies on.
 *
 * Handles a block left unclosed because the turn was cut off, a bare invoke /
 * parameter block with no `tool_calls` wrapper, and stray tags.
 */
function removeDSML(text) {
  let out = String(text == null ? '' : text);
  // A whole tool-calls block — closed, or unterminated at the end of the turn.
  out = out.replace(/<[|｜]DSML[|｜]tool_calls>[\s\S]*?(?:<\/[|｜]DSML[|｜]tool_calls>|$)/gi, ' ');
  // A bare invoke/parameter block with no wrapper around it.
  out = out.replace(
    /<[|｜]DSML[|｜](?:invoke|parameter)\b[\s\S]*?(?:<\/[|｜]DSML[|｜](?:invoke|parameter)>|$)/gi,
    ' '
  );
  // Any tag left over — including a closing tag, which is `</|DSML|…>` and so
  // does NOT start with `<|`.
  out = out.replace(/<\/?[|｜]DSML[|｜][^>]*>/gi, ' ');
  return out;
}

/** `removeDSML` plus the whitespace tidy-up wanted for a finished string. */
function stripDSML(text) {
  return removeDSML(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Incremental DSML filter for the streaming path.
 *
 * The previous implementation tracked "am I inside a block?" with a boolean
 * flipped by `delta.includes('<|DSML|')` and flipped back by
 * `delta.includes('|/DSML|')`. Both halves were wrong in practice:
 *
 *  - a marker split across two deltas (`"<|DSM"` + `"L|tool_calls>"`) was never
 *    recognised, so the ENTIRE tool call streamed to the user verbatim — this is
 *    the `<|DSML|tool_calls>` the transcript was showing;
 *  - `|/DSML|` also matches `</|DSML|parameter>`, which sits *inside* the block,
 *    so the state cleared early and everything after the first parameter leaked.
 *
 * This version re-derives the clean text from everything received so far and
 * emits only the part that is settled — holding back a trailing partial marker,
 * which is the one thing that could still turn into markup.
 */
function makeDSMLFilter() {
  let raw = '';
  let emitted = 0;

  const holdBack = (s) => {
    let cut = s.length;
    // An opener still present in the cleaned text means markup that has not been
    // resolved yet — we know it is a tag but not yet which one, or whether its
    // closing tag is coming. Hold everything from there on.
    for (const marker of DSML_MARKERS) {
      const i = s.lastIndexOf(marker);
      if (i !== -1 && i < cut) cut = i;
    }
    // And hold a trailing partial marker, which is not recognisable as one yet.
    let hold = 0;
    for (const marker of DSML_MARKERS) {
      const max = Math.min(marker.length - 1, s.length);
      for (let n = max; n > hold; n--) {
        if (s.endsWith(marker.slice(0, n))) { hold = n; break; }
      }
    }
    if (hold) cut = Math.min(cut, s.length - hold);
    return s.slice(0, cut);
  };

  const take = () => {
    const safe = holdBack(removeDSML(raw));
    if (safe.length <= emitted) return '';
    const out = safe.slice(emitted);
    emitted = safe.length;
    return out;
  };

  return {
    /** Feed one raw delta; returns the text that is safe to show. */
    push(delta) {
      raw += String(delta == null ? '' : delta);
      return take();
    },
    /** End of stream: release anything still held back. */
    flush() {
      return take();
    }
  };
}

module.exports = {
  createChat,
  streamCompletion,
  generateTitle,
  extractCode,
  parseDSML,
  removeDSML,
  stripDSML,
  makeDSMLFilter,
  LLAMACODER_BASE,
  DEFAULT_MODEL,
  MODELS
};
