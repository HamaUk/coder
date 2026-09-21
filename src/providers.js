// Provider presets, protocol adapters (OpenAI-compatible / Anthropic / Google),
// unified streaming with tool calls, connection tests, and model listing.

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
const PRESETS = [
  { id: 'llamacoder',  label: 'Hama AI', type: 'llamacoder', baseUrl: 'https://llamacoder.together.ai', model: 'deepseek-ai/DeepSeek-V4-Flash-0731', keyRequired: false, toolsEnabled: true, blurb: 'Free full-stack app & code generation using DeepSeek V4 Flash / GLM. No API key required.' },
  { id: 'openai',      label: 'OpenAI',                 type: 'openai',   baseUrl: 'https://api.openai.com/v1',               model: 'gpt-4o-mini',                    keyRequired: true,  toolsEnabled: true,  vision: true,  blurb: 'GPT-4o, GPT-4.1 and friends.' },
  { id: 'anthropic',   label: 'Anthropic',              type: 'anthropic',baseUrl: 'https://api.anthropic.com',               model: 'claude-3-5-sonnet-latest',       keyRequired: true,  toolsEnabled: true,  vision: true,  blurb: 'Claude Sonnet, Opus & Haiku.' },
  { id: 'google',      label: 'Google Gemini',          type: 'google',   baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash',      keyRequired: true,  toolsEnabled: true,  vision: true,  blurb: 'Gemini Flash & Pro — free tier, and reads images.' },
  { id: 'groq',        label: 'Groq',                   type: 'openai',   baseUrl: 'https://api.groq.com/openai/v1',          model: 'llama-3.3-70b-versatile',        keyRequired: true,  toolsEnabled: true,  blurb: 'Ultra-fast Llama, Mixtral & more.' },
  { id: 'cerebras',    label: 'Cerebras',               type: 'openai',   baseUrl: 'https://api.cerebras.ai/v1',              model: 'llama3.1-8b',                    keyRequired: true,  toolsEnabled: true,  blurb: 'World\'s fastest inference — 1M free tokens/day.' },
  { id: 'mistral',     label: 'Mistral AI',             type: 'openai',   baseUrl: 'https://api.mistral.ai/v1',               model: 'mistral-large-latest',           keyRequired: true,  toolsEnabled: true,  blurb: 'Mistral Large, Codestral & more.' },
  { id: 'deepseek',    label: 'DeepSeek',               type: 'openai',   baseUrl: 'https://api.deepseek.com/v1',             model: 'deepseek-chat',                  keyRequired: true,  toolsEnabled: true,  blurb: 'DeepSeek Chat & Reasoner.' },
  { id: 'xai',         label: 'xAI (Grok)',             type: 'openai',   baseUrl: 'https://api.x.ai/v1',                     model: 'grok-2-latest',                  keyRequired: true,  toolsEnabled: true,  blurb: 'Grok models from xAI.' },
  { id: 'openrouter',  label: 'OpenRouter',             type: 'openai',   baseUrl: 'https://openrouter.ai/api/v1',            model: 'openai/gpt-4o-mini',             keyRequired: true,  toolsEnabled: true,  vision: true,  blurb: 'One key for hundreds of models.' },
  { id: 'together',    label: 'Together AI',            type: 'openai',   baseUrl: 'https://api.together.xyz/v1',             model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyRequired: true, toolsEnabled: true, blurb: 'Open models at scale.' },
  { id: 'cohere',      label: 'Cohere',                 type: 'openai',   baseUrl: 'https://api.cohere.ai/compatibility/v1',  model: 'command-r-plus',                 keyRequired: true,  toolsEnabled: true,  blurb: 'Command R / R+ via OpenAI-compatible API.' },
  { id: 'perplexity',  label: 'Perplexity',             type: 'openai',   baseUrl: 'https://api.perplexity.ai',               model: 'llama-3.1-sonar-large-128k-online', keyRequired: true, toolsEnabled: false, blurb: 'Sonar models with built-in web grounding (agent tools off).' },
  { id: 'ollama',      label: 'Ollama (local)',         type: 'openai',   baseUrl: 'http://localhost:11434/v1',               model: 'llama3.1',                       keyRequired: false, toolsEnabled: true,  blurb: 'Run models locally with Ollama.' },
  { id: 'custom',      label: 'Custom (OpenAI-compatible)', type: 'openai', baseUrl: '',                                      model: '',                               keyRequired: false, toolsEnabled: true,  blurb: 'Any OpenAI-compatible endpoint.' }
];

// ---------------------------------------------------------------------------
// SSE reader — parses "data: {...}" events from a fetch response body.
// Tolerates both LF and CRLF framing (Google uses \r\n\r\n separators).
// ---------------------------------------------------------------------------
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const EVENT_SEP = /\r?\n\r?\n/;

  const processEvent = (rawEvent) => {
    const dataLines = rawEvent.split(/\r?\n/)
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim());
    for (const line of dataLines) {
      if (!line) continue;
      if (line === '[DONE]') { onData({ done: true }); continue; }
      let json = null;
      try { json = JSON.parse(line); } catch { /* partial / keep-alive */ }
      if (json) onData(json);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let m;
    while ((m = EVENT_SEP.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      processEvent(rawEvent);
    }
  }
  const tail = buffer.trim();
  if (tail) processEvent(tail); // flush a trailing unterminated event
}

class ProviderHttpError extends Error {
  constructor(status, message, retryAfterMs) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

async function errorFromResponse(res) {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j.error?.message || j.message || j.error || body;
  } catch { /* plain text */ }
  const retryHeader = res.headers?.get?.('retry-after');
  const retryAfterMs = retryHeader && !isNaN(Number(retryHeader)) ? Number(retryHeader) * 1000 : undefined;
  return new ProviderHttpError(res.status, `Provider returned HTTP ${res.status}: ${String(msg).slice(0, 500)}`, retryAfterMs);
}

// Streaming tool-call accumulation is shared across adapters — see
// ./middleware/tool-calls.js. Each adapter below still owns its own protocol
// parsing; only the cross-chunk bookkeeping is common.
const { ToolCallAccumulator, assembleCalls } = require('./middleware/tool-calls');

// ---------------------------------------------------------------------------
// History converters (provider-neutral -> provider format)
// Neutral roles: user | assistant (content, toolCalls[]) | tool (toolCallId, name, content)
// ---------------------------------------------------------------------------
function toOpenAIMessages(history, system) {
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of history) {
    if (m.role === 'user') {
      if (Array.isArray(m.images) && m.images.length) {
        const parts = [{ type: 'text', text: m.content || '' }];
        for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
        msgs.push({ role: 'user', content: parts });
      } else {
        msgs.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        msg.content = m.content || null;
        msg.tool_calls = m.toolCalls.map(c => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
        }));
      }
      msgs.push(msg);
    } else if (m.role === 'tool') {
      msgs.push({ role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: String(m.content ?? '') });
    }
  }
  return msgs;
}

function toAnthropicMessages(history) {
  const msgs = [];
  for (const m of history) {
    if (m.role === 'user') {
      if (Array.isArray(m.images) && m.images.length) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        for (const img of m.images) {
          const mediaType = img.mime || 'image/png';
          const data = String(img.dataUrl || '').replace(/^data:[^;]+;base64,/, '');
          parts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
        }
        msgs.push({ role: 'user', content: parts });
      } else {
        msgs.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
      }
      msgs.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      // Anthropic bundles tool results into a following *user* turn
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') };
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        msgs.push({ role: 'user', content: [block] });
      }
    }
  }
  // Anthropic requires the first message to be from the user
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  return msgs;
}

function toGeminiContents(history) {
  const contents = [];
  for (const m of history) {
    let entry = null;
    if (m.role === 'user') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const img of (m.images || [])) {
        const mimeType = img.mime || 'image/png';
        const data = String(img.dataUrl || '').replace(/^data:[^;]+;base64,/, '');
        parts.push({ inline_data: { mime_type: mimeType, data } });
      }
      entry = { role: 'user', parts: parts.length ? parts : [{ text: '' }] };
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls || []) {
        const part = { functionCall: { name: c.name, args: c.args || {} } };
        // Gemini 3.x thinking models sign tool-call parts and require the
        // signature echoed back, or the next request 400s.
        if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
        parts.push(part);
      }
      entry = { role: 'model', parts: parts.length ? parts : [{ text: '' }] };
    } else if (m.role === 'tool') {
      entry = {
        role: 'user',
        parts: [{ functionResponse: { name: m.name, response: { result: String(m.content ?? '') } } }]
      };
    }
    if (!entry) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === entry.role) {
      last.parts.push(...entry.parts);   // Gemini wants strictly alternating roles
    } else {
      contents.push(entry);
    }
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

// ---------------------------------------------------------------------------
// Streaming implementations
// ---------------------------------------------------------------------------
async function openaiStream(provider, { history, tools, system, signal, onToken, onReasoning }) {
  const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model: provider.model, messages: toOpenAIMessages(history, system), stream: true };
  if (provider.temperature !== null && provider.temperature !== undefined && provider.temperature !== '') body.temperature = Number(provider.temperature);
  if (provider.maxTokens) body.max_tokens = Number(provider.maxTokens);
  if (tools?.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw await errorFromResponse(res);

  let text = '';
  const toolAcc = new ToolCallAccumulator();
  await readSSE(res, (chunk) => {
    if (chunk.done) return;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      onToken(delta.content);
    }
    // Reasoning models (DeepSeek-R1, OpenRouter reasoners, …) stream their
    // chain-of-thought on a separate field; surface it, never the final answer.
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      onReasoning?.(delta.reasoning_content);
    } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
      onReasoning?.(delta.reasoning);
    }
    for (const tc of delta.tool_calls || []) {
      // OpenAI spreads one call across chunks keyed by `index`: id, name and
      // the JSON arguments can each arrive in fragments.
      toolAcc.appendFragment(tc.index ?? 0, {
        id: tc.id,
        name: tc.function?.name,
        args: tc.function?.arguments
      });
    }
  });

  return { text, toolCalls: toolAcc.toCalls() };
}

async function anthropicStream(provider, { history, tools, system, signal, onToken, onReasoning }) {
  const base = (provider.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const url = base + '/v1/messages';
  const body = {
    model: provider.model,
    max_tokens: Number(provider.maxTokens) || 4096,
    messages: toAnthropicMessages(history),
    stream: true
  };
  if (system) body.system = system;
  if (provider.temperature !== null && provider.temperature !== undefined && provider.temperature !== '') body.temperature = Number(provider.temperature);
  if (tools?.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey || '',
      'anthropic-version': '2023-06-01',
      'Accept': 'text/event-stream'
    },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw await errorFromResponse(res);

  let text = '';
  const toolAcc = new ToolCallAccumulator();
  await readSSE(res, (ev) => {
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      // Anthropic sends id/name once here, then streams only the JSON input.
      toolAcc.openBlock(ev.index, { id: ev.content_block.id, name: ev.content_block.name });
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) {
        text += d.text;
        onToken(d.text);
      } else if (d.type === 'thinking_delta' && d.thinking) {
        onReasoning?.(d.thinking);
      } else if (d.type === 'input_json_delta') {
        toolAcc.appendArgs(ev.index, d.partial_json);
      }
    } else if (ev.type === 'error') {
      throw new Error(ev.error?.message || 'Anthropic stream error');
    }
  });

  return { text, toolCalls: toolAcc.toCallsUnfiltered() };
}

async function geminiStream(provider, { history, tools, system, signal, onToken, onReasoning }) {
  const base = (provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(provider.model)}:streamGenerateContent?alt=sse`;
  const body = { contents: toGeminiContents(history) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const generationConfig = {};
  if (provider.temperature !== null && provider.temperature !== undefined && provider.temperature !== '') generationConfig.temperature = Number(provider.temperature);
  if (provider.maxTokens) generationConfig.maxOutputTokens = Number(provider.maxTokens);
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (tools?.length) {
    body.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: t.parameters?.properties || {}, required: t.parameters?.required || [] }
      }))
    }];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': provider.apiKey || '', 'Accept': 'text/event-stream' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) throw await errorFromResponse(res);

  let text = '';
  const rawCalls = [];
  let seq = 0;
  let turnSignature = null;
  await readSSE(res, (chunk) => {
    if (chunk.promptFeedback?.blockReason) {
      throw new Error(`Gemini blocked the request: ${chunk.promptFeedback.blockReason}`);
    }
    for (const cand of chunk.candidates || []) {
      for (const part of cand.content?.parts || []) {
        if (typeof part.text === 'string' && part.text) {
          if (part.thought === true) {
            // hidden reasoning of thinking models — surfaced as a collapsed
            // "Thought" row, never mixed into the final answer.
            onReasoning?.(part.text);
          } else {
            text += part.text;
            onToken(part.text);
          }
        } else if (part.functionCall) {
          // Gemini delivers each call whole — no cross-chunk accumulation.
          const call = { id: `call_${++seq}`, name: part.functionCall.name, args: part.functionCall.args || {} };
          if (part.thoughtSignature) call.thoughtSignature = part.thoughtSignature;
          rawCalls.push(call);
        }
        if (part.thoughtSignature && !turnSignature) turnSignature = part.thoughtSignature;
      }
    }
  });
  const toolCalls = assembleCalls(rawCalls);
  // Docs: with parallel calls only the FIRST functionCall needs the signature
  if (turnSignature && toolCalls.length && !toolCalls[0].thoughtSignature) {
    toolCalls[0].thoughtSignature = turnSignature;
  }
  return { text, toolCalls };
}

// ---------------------------------------------------------------------------
// Built-in demo provider — streams a scripted experience, uses the REAL tool
// pipeline so users can see tool cards + file creation before adding any key.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DEMO_FILE = `# Welcome to HAMA 👋

This file was created **by the AI itself** using the built-in \`write_file\` tool —
the exact same pipeline every connected provider (OpenAI, Anthropic, Gemini, Groq…)
will use once you add an API key.

## Your agent can

- 🔎 **Search the web live** — current news, docs, prices, anything
- 📄 **Create files** — code, documents, configs, whole websites
- ✏️ **Edit files** — surgical string replacements in existing files
- 💻 **Write code** — apps, scripts and components saved straight to your workspace

## Next step

Open **Providers → Add provider**, paste an API key, pick a model,
optionally write your own **custom rules** for the agent to follow — and go live. 🚀
`;

const DEMO_INTRO = `👋 **Hi! I'm HAMA, running in Demo Mode** — no API key configured yet, so you're talking to the built-in demo brain. The console around me is fully live.

**Get a real model in 60 seconds:**

1. Click **Providers** (bottom-left) → **Add provider**
2. Pick a preset — OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter, Together, Cohere, Ollama…
3. Paste your **API key** and choose a model
4. Optionally add **custom rules** — your own system prompt the agent must follow for that provider
5. Save, then pick it from the **provider pill** in the top bar

## What I can do once connected

| Capability | How |
|---|---|
| 🔎 Live web research | \`web_search\` + \`fetch_url\` tools |
| 📄 Create files & code | \`write_file\`, \`create_directory\` |
| ✏️ Edit your files | \`read_file\` + \`edit_file\` |
| 💬 Support conversations | Per-provider custom rules & personas |

> **Try the tool pipeline right now:** type *"create a file"* — I'll write a real file to your workspace (check the **Workspace panel** on the right).

\`\`\`js
// Everything here is real except my brain — one API key and I'm fully yours.
const answer = await hama.ask('anything at all');
\`\`\`
`;

const DEMO_AFTER_TOOL = `✅ **Done!** I just created \`demo/welcome.md\` in your workspace using the real \`write_file\` tool — open the **Workspace panel** (folder icon, top-right) to see it.

That's exactly how web search, file creation, editing and coding will work with any connected provider. The interface, the tool cards, the streaming — all of this is the real thing.

**Next step:** add your API key in **Providers → Add provider** and I'll be fully live. 🎯`;

async function demoStream(provider, { history, tools, onToken }) {
  const last = history[history.length - 1];
  const streamOut = async (full) => {
    let emitted = '';
    for (const word of full.split(/(?<=\s)/)) {
      emitted += word;
      onToken(word);
      await sleep(14 + Math.random() * 26);
    }
    return { text: emitted, toolCalls: [] };
  };

  if (last?.role === 'tool') {
    return streamOut(DEMO_AFTER_TOOL);
  }
  const userText = String(last?.content || '').toLowerCase();
  const wantsFile = /file|code|build|create|page|site|app|script|write|demo/.test(userText);
  if (wantsFile && tools?.some(t => t.name === 'write_file')) {
    await sleep(500);
    return {
      text: "Sure — I'll create a welcome file in your workspace right now. ",
      toolCalls: [{ id: 'demo_call_1', name: 'write_file', args: { path: 'demo/welcome.md', content: DEMO_FILE } }]
    };
  }
  return streamOut(DEMO_INTRO);
}

// ---------------------------------------------------------------------------
// Unified entry point — with automatic retry on rate limits (429) and
// transient provider/network errors. Never retries after tokens have already
// been emitted (avoids duplicated content), and never on abort.
// ---------------------------------------------------------------------------
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 3;

async function llamacoderStream(provider, { history, system, signal, onToken }) {
  const llamacoder = require('./llamacoder');

  let conversationText = '';
  for (const m of history) {
    if (m.role === 'user') {
      conversationText += `\n\nUser: ${m.content}`;
    } else if (m.role === 'assistant') {
      if (m.content) conversationText += `\n\nAssistant: ${m.content}`;
    } else if (m.role === 'tool') {
      conversationText += `\n\n[Tool Result (${m.name})]:\n${m.content}`;
    }
  }

  let composed = conversationText.trim();
  if (system) {
    composed = `[System Instructions / Available Tools]\n${system}\n\n${composed}`;
  }

  const { lastMessageId } = await llamacoder.createChat({
    prompt: composed,
    model: provider.model || llamacoder.DEFAULT_MODEL,
    signal
  });

  // The DSML markup arrives split across stream chunks in arbitrary places, so
  // suppression is done by re-deriving the clean text from everything received
  // and emitting only what is settled — see makeDSMLFilter().
  const filter = llamacoder.makeDSMLFilter();

  const fullText = await llamacoder.streamCompletion({
    messageId: lastMessageId,
    model: provider.model || llamacoder.DEFAULT_MODEL,
    signal,
    onToken: (delta) => {
      const visible = filter.push(delta);
      if (visible) onToken(visible);
    }
  });
  const tail = filter.flush();
  if (tail) onToken(tail);

  const parsed = llamacoder.parseDSML(fullText);
  return {
    // Always the cleaned text, whether or not calls were parsed: the per-delta
    // suppression is best-effort for the live view, while this is the finished,
    // authoritative version of what the model said. The loop uses it for the
    // saved transcript, so no markup can survive a reload.
    text: llamacoder.stripDSML(fullText),
    toolCalls: parsed.toolCalls?.length ? assembleCalls(parsed.toolCalls) : [],
    textIsAuthoritative: true
  };
}

function selectImpl(provider) {
  switch (provider.type) {
    case 'anthropic':  return anthropicStream;
    case 'google':     return geminiStream;
    case 'demo':       return demoStream;
    case 'llamacoder': return llamacoderStream;
    case 'openai':
    default:           return openaiStream;
  }
}

function retryDelayMs(e, attempt) {
  if (e.retryAfterMs && isFinite(e.retryAfterMs) && e.retryAfterMs > 0) {
    return Math.min(e.retryAfterMs, 30000);
  }
  // many providers (e.g. Groq) embed the wait in the message: "try again in 4.5s"
  const inSecs = String(e.message || '').match(/try again in ([\d.]+)\s*s/i);
  if (inSecs) return Math.min(Math.ceil(Number(inSecs[1]) * 1000) + 250, 30000);
  return Math.min(1500 * 2 ** (attempt - 1), 10000) + Math.floor(Math.random() * 400);
}

async function streamChat(provider, ctx) {
  const impl = selectImpl(provider);
  let attempt = 0;
  let emitted = false;
  const guardedCtx = { ...ctx, onToken: (t) => { emitted = true; ctx.onToken(t); } };
  if (ctx.onReasoning) guardedCtx.onReasoning = (r) => { emitted = true; ctx.onReasoning(r); };

  for (;;) {
    try {
      return await impl(provider, guardedCtx);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const isNetErr = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|terminated|other side closed/i.test(String(e?.message || e));
      const retryable = (e instanceof ProviderHttpError && RETRYABLE_STATUSES.has(e.status)) || isNetErr;
      if (!retryable || emitted || attempt >= MAX_RETRIES) throw e;
      attempt++;
      const waitMs = retryDelayMs(e, attempt);
      const secs = Math.max(1, Math.round(waitMs / 1000));
      const reason = e.status === 429
        ? 'Rate limited by the provider'
        : (e.status ? `Provider busy (HTTP ${e.status})` : 'Connection issue');
      ctx.onStatus?.(`${reason} — retrying in ${secs}s (attempt ${attempt + 1}/${MAX_RETRIES + 1})…`);
      await sleep(waitMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Model listing + connection tests
// ---------------------------------------------------------------------------
const REQUEST_TIMEOUT = 15000;

function timedSignal() {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), REQUEST_TIMEOUT);
  return ac.signal;
}

async function listModels(provider) {
  const base = (provider.baseUrl || '').replace(/\/+$/, '');
  if (provider.type === 'demo') return ['demo-1'];
  if (provider.type === 'llamacoder') {
    const llamacoder = require('./llamacoder');
    return llamacoder.MODELS;
  }
  if (provider.type === 'google') {
    const res = await fetch(`${base}/models`, { headers: { 'x-goog-api-key': provider.apiKey || '' }, signal: timedSignal() });
    if (!res.ok) throw await errorFromResponse(res);
    const j = await res.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
  }
  if (provider.type === 'anthropic') {
    const res = await fetch(`${base}/v1/models`, {
      headers: { 'x-api-key': provider.apiKey || '', 'anthropic-version': '2023-06-01' },
      signal: timedSignal()
    });
    if (!res.ok) throw await errorFromResponse(res);
    const j = await res.json();
    return (j.data || []).map(m => m.id);
  }
  // OpenAI-compatible
  const headers = {};
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const res = await fetch(`${base}/models`, { headers, signal: timedSignal() });
  if (!res.ok) throw await errorFromResponse(res);
  const j = await res.json();
  return (j.data || []).map(m => m.id).sort();
}

async function testProvider(provider) {
  const start = Date.now();
  if (provider.type === 'demo') return { ok: true, latency: 0, message: 'Built-in demo provider — always available.' };
  if (provider.type === 'llamacoder') {
    try {
      const llamacoder = require('./llamacoder');
      const ping = await llamacoder.createChat({ prompt: 'ping' });
      return { ok: true, latency: Date.now() - start, message: `Connected to LlamaCoder engine (session: ${ping.chatId}).` };
    } catch (e) {
      return { ok: false, latency: Date.now() - start, message: e.message };
    }
  }
  try {
    const models = await listModels(provider);
    return { ok: true, latency: Date.now() - start, message: `Connected — ${models.length} models available.` };
  } catch (e) {
    return { ok: false, latency: Date.now() - start, message: e.message };
  }
}

// ---------------------------------------------------------------------------
// Model probing — "does this model actually work, and can it call a tool?"
//
// Shared by the CLI checker (scripts/check-models.js) and the console's
// "Check models" button, so both report exactly the same thing.
// ---------------------------------------------------------------------------
const PROBE_TOOL = [{
  name: 'get_time',
  description: 'Return the current server time. Call this whenever the user asks for the time.',
  parameters: { type: 'object', properties: {}, required: [] }
}];

// Text-prompt engines have no native tool API: they only see the prompt, so the
// call markup has to be spelled out or they answer in prose and report "no tool".
const PROBE_DSML = [
  'To call a tool you MUST emit this markup, and nothing else may share that message:',
  '<|DSML|tool_calls>',
  '<|DSML|invoke name="TOOL_NAME">',
  '<|DSML|parameter name="PARAM_NAME">VALUE</|DSML|parameter>',
  '</|DSML|invoke>',
  '</|DSML|tool_calls>'
].join('\n');
const NATIVE_TOOL_TYPES = new Set(['openai', 'anthropic', 'google']);

async function runProbe(provider, { history, system, tools, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  let streamed = '';
  let firstTokenAt = null;
  try {
    const res = await streamChat(provider, {
      history,
      system,
      tools,
      signal: ac.signal,
      onToken: (t) => { if (firstTokenAt === null) firstTokenAt = Date.now(); streamed += t; },
      onStatus: () => {}
    });
    const text = String(streamed || (res && res.text) || '').trim();
    return {
      ok: true,
      ms: Date.now() - started,
      ttftMs: firstTokenAt ? firstTokenAt - started : null,
      chars: text.length,
      sample: text.replace(/\s+/g, ' ').slice(0, 70),
      toolCalls: ((res && res.toolCalls) || []).map((c) => c.name)
    };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return {
      ok: false,
      ms: Date.now() - started,
      error: aborted ? `timed out after ${timeoutMs}ms` : ((e && e.message) || String(e))
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one live completion (and, by default, a tool-call probe) for a model.
 *
 * The tool probe describes the tool in the system prompt as well as passing the
 * structured definition, because the text-prompt adapters (llamacoder) only see
 * the prompt — omitting it produced a false "this model cannot call tools".
 *
 * @returns {Promise<{ok, ms, ttftMs?, sample?, chars?, toolCalls?, error?, canCallTools?}>}
 */
async function probeModel(provider, model, { timeoutMs = 45000, withTools = true } = {}) {
  const p = { ...provider, model };
  const text = await runProbe(p, {
    history: [{ role: 'user', content: 'Reply with exactly this word: OK' }],
    system: 'You are a connectivity probe. Reply with exactly the word: OK',
    timeoutMs
  });
  if (!text.ok || !withTools) return text;

  const toolSystem = [
    'You are an agent with tools. You MUST call the tool below — do not answer from memory.',
    '',
    '## Tools available in this conversation',
    ...PROBE_TOOL.map((t) => `- ${t.name}: ${t.description}`),
    '',
    NATIVE_TOOL_TYPES.has(p.type) ? 'Call get_time now to answer the user.' : PROBE_DSML
  ].join('\n');

  const tools = await runProbe(p, {
    history: [{ role: 'user', content: 'What time is it right now? Use the get_time tool.' }],
    system: toolSystem,
    tools: PROBE_TOOL,
    timeoutMs
  });
  return {
    ...text,
    canCallTools: !!(tools.ok && tools.toolCalls && tools.toolCalls.length),
    toolCalls: (tools && tools.toolCalls) || [],
    toolError: tools.ok ? null : tools.error
  };
}

module.exports = { PRESETS, streamChat, listModels, testProvider, probeModel, PROBE_TOOL };
