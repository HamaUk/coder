# ✦ HAMA — AI Support Agent Console

A professional, self-hosted AI support agent with a clean, modern UI. Connect **any major AI provider with just an API key**, give each provider its own **custom rules**, and let the agent **search the web, create & edit files, and write code** — all from one beautiful console.

Zero dependencies. Pure Node.js (18+) + vanilla frontend. No build step.

---

## Quick start

```bash
npm start
# → http://localhost:3000
```

The app boots with a built-in **Demo Agent** (no key required) so you can explore the UI and even try the real tool pipeline — type *"create a file"* and watch it write to your workspace.

## Deploy it 24/7 for free

### Read this first: what this app needs from a host

HAMA is **not a static site**, and that rules out most free hosting before you start:

| It needs | Why | What it rules out |
|---|---|---|
| A **writable disk** | `data/` holds providers, chats and API keys; `workspace/` holds every generated file | Vercel, Netlify, Cloudflare Pages/Workers, GitHub Pages |
| **Child processes** | `run_shell`, `run_script`, background jobs, the esbuild bundler | serverless functions (no process spawning) |
| **Long-lived connections** | one SSE turn stays open for as long as the model works — minutes on a build | serverless request timeouts |
| **In-process state** | streaming turns, job registry, shell sessions | multi-instance autoscaling without sticky sessions |

A container (or a plain VM) is the only shape that works. Good news: the free
options are real, they just trade different things away.

### Where to put it, honestly compared

| Host | Truly 24/7? | Keeps your data? | Card needed? | Verdict |
|---|---|---|---|---|
| **Oracle Cloud Always Free** (ARM VM, 4 vCPU / 24 GB) | **Yes** | **Yes** (real disk) | Yes, for verification | **Best free option.** A full always-free VM runs this exactly like your PC does — Docker or Node + systemd. The signup is the annoying part. |
| **Fly.io** | Yes with `min_machines_running = 1` | **Yes** (volumes) | Yes | The best *managed* choice. `deploy/fly.toml` is ready; volumes survive restarts. Small free allowance, then metered. |
| **Render** | No — sleeps when idle | No (free plan has no disk) | No | **Easiest way to try it.** `render.yaml` sits at the repo root, so *New → Blueprint* finds it with no preparation. Expect a cold start of about a minute, and everything resets on redeploy — set `HAMA_PROVIDER_*` so the provider comes back by itself. See "Try it on Render" below. |
| **Hugging Face Spaces** (Docker) | No — sleeps when idle | No (filesystem resets) | **No** | Zero-friction public URL, no card at all. `deploy/huggingface-space-README.md` has the steps. Best "just show me it works" option. |
| **Koyeb / Railway** | Koyeb: no (scale-to-zero). Railway: trial credits only | Volume on paid | Usually | Similar trade to Render; Railway is not free beyond the trial. |
| **Your own PC / Raspberry Pi + Cloudflare Tunnel** | **Yes, while it is on** | **Yes** | No | Genuinely free and fully capable. `cloudflared tunnel` gives HTTPS and a public URL with no port forwarding. The catch is that "24/7" is your electricity bill. |

**Not suitable at all:** Vercel, Netlify, Cloudflare Pages/Workers, GitHub Pages —
they cannot run a long-lived process, cannot spawn commands, and give you no disk.

### Step 1 — set a token (required)

A public HAMA can read and write files and run commands on its host. It therefore
**refuses to bind a non-loopback address without an access token**:

```bash
HAMA_TOKEN="$(openssl rand -hex 24)" HOST=0.0.0.0 npm start
# then open http://<host>:3000 → you are asked for that token once
```

Every `/api/*` route, every static file and the chat stream sit behind it. The
token is exchanged for an HttpOnly session cookie (30 days); `Authorization:
Bearer <token>` also works for scripts. `/api/health` and the read-only
`/api/workspace/*` asset route stay public — the first so the platform can probe
it, the second so Live App previews can load.

### Step 2 — pick a host and go

**Docker (works anywhere — Fly, Oracle, Spaces, your own box):**

```bash
docker build -t hama .
docker run -d --name hama -p 3000:3000 \
  -e HAMA_TOKEN="your-long-random-token" \
  -v hama-data:/app/data \
  -v hama-workspace:/app/workspace \
  hama
```

**Fly.io** (keeps data across restarts):

```bash
cp deploy/fly.toml fly.toml      # edit `app` to a unique name
fly volumes create hama_state --size 1
fly volumes create hama_workspace --size 1
fly secrets set HAMA_TOKEN="your-long-random-token"
fly deploy
```

**Render:** push the repo to GitHub → *New → Blueprint* → pick the repo.
`render.yaml` is already at the root, so there is nothing to move; Render reads it
automatically. Set `HAMA_TOKEN` when prompted (the service exits without it, by
design). No disk on the free plan — see "Try it on Render" below for what that
means and how to make the provider survive it.

**Hugging Face Spaces:** create a Space with **SDK: Docker**, copy these files in,
and follow `deploy/huggingface-space-README.md` (it needs a small front-matter
block in the Space's README).

### Try it on Render (5 minutes, no card)

The fastest way to see the whole thing running on a public URL.

1. **Push this folder to GitHub** (a private repo is fine — Render can read it).
2. In Render: **New → Blueprint**, pick the repo. It finds `render.yaml` at the
   root and proposes one free web service. Apply it.
3. When prompted for **`HAMA_TOKEN`**, paste a long random value:
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
   The server refuses to bind a public interface without it, so a deploy with
   this left empty crash-loops on purpose.
4. Open the URL, enter that token once on the sign-in page, and you are in.

**The one thing that will confuse you otherwise:** the free plan has no disk, so
`data/` and `workspace/` reset on every redeploy, restart and wake-from-sleep.
Your provider, your chats and your generated files are gone each time. Two ways
to live with that:

- **Recommended for a test:** set `HAMA_PROVIDER_PRESET` and `HAMA_PROVIDER_KEY`
  in the service's environment (they are commented out in `render.yaml`, ready to
  uncomment). The provider is then re-created at every boot, and made the default,
  so the console works identically after a cold start. It never touches a provider
  you already configured by hand, and the key is never logged.
- Or just re-add the provider in **Providers → Add provider** each time you wake
  the service.

Everything else works normally there: streaming turns, file tools, the shell, the
workspace panel and the Live App preview. Long turns are fine — the app pings the
connection every 15 seconds so a sleeping proxy cannot cut a build off. The first
request after the service has been idle takes roughly a minute while the instance
starts.

### Step 3 — make the data survive (the difference between a demo and a deployment)

If the host gives you a disk or volume, point the app at it:

```
HAMA_DATA_DIR=/data        # providers.json, chats.json, settings.json
HAMA_WORKSPACE_DIR=/workspace   # every generated file
```

On a host without persistent storage those directories reset on each restart and
redeploy — chats, API keys and generated files included. On Render/Spaces free
tiers that is unavoidable; on Fly, Oracle or your own machine it is one volume
away, and it is the single biggest reason to prefer them.

### What free really costs you

Free tiers generally do not bill money, they bill **cold starts** and **state**.
A suspended container takes 30–60 seconds to answer its first request, and a
redeploy erases the workspace. Nothing here breaks — it is just slower and more
forgetful than the same app on a $0 always-free VM. If you want it genuinely
always-on with your data intact and no card, the honest answer is a machine you
already own plus a free Cloudflare Tunnel.

## Go live (60 seconds)

1. Click **Providers** (bottom-left) → **Add provider**
2. Pick a preset — paste your **API key** — choose or fetch a **model**
3. (Optional) Write **Custom rules** for that provider — e.g. *"Always answer in English, keep replies under 200 words, sign off as 'HAMA Support'"*
4. **Test connection** → **Save** → it becomes the active provider

### Supported providers

| Preset | Protocol | Notes |
|---|---|---|
| OpenAI | OpenAI | gpt-4o, gpt-4.1… |
| Anthropic | Anthropic | Claude Sonnet/Opus/Haiku |
| Google Gemini | Gemini | Flash & Pro |
| Groq | OpenAI-compat | ultra-fast Llama/Mixtral |
| Mistral | OpenAI-compat | Mistral Large… |
| DeepSeek | OpenAI-compat | chat & reasoner |
| xAI | OpenAI-compat | Grok |
| OpenRouter | OpenAI-compat | one key, 100s of models |
| Together AI | OpenAI-compat | open models |
| Cohere | OpenAI-compat | compatibility endpoint |
| Perplexity | OpenAI-compat | Sonar (agent tools off — has built-in web grounding) |
| Ollama | OpenAI-compat | local models, no key needed |
| Custom | OpenAI-compat | any compatible endpoint |

## Streaming + tool loop

A turn streams over SSE (`POST /api/chat`), so every step is visible as it happens instead of arriving all at once at the end:

```
started → thinking → token → tool_start → tool_progress → tool_end → token → message_end
```

- **`thinking`** — the model's chain of thought, rendered as a collapsed *Think* row rather than mixed into the reply.
- **`token`** — reply text, streamed as it is generated.
- **`tool_start` / `tool_end`** — one pair per tool call, carrying the name, arguments, structured `meta` (exit code, `±lines`, job id) and the real duration.
- **`tool_progress`** — the elapsed time on a call that is still running, emitted every 4 seconds. A shell command can take minutes; without this the stream would be silent the whole time, and a slow build would look exactly like a hung server.
- **`message_end`** — the persisted message, and the terminal event. `aborted` and `error` can also end a turn.

The response sends a `: ping` comment every 15 seconds so a proxy never drops an idle stream. The event names and payloads are a frozen contract with `public/app.js` — `.smoke/stream.test.js` drives the real loop against a mock provider and asserts the order, the ticks and the teardown.

## Agent tools

Toggle per conversation from the composer (and per provider in settings):

- 🔎 **`web_search`** — live web search (key-free, multi-engine fallback: Bing → DuckDuckGo → Instant Answers)
- 🌐 **`fetch_url`** — read any web page
- 📄 **`write_file` / `create_directory`** — create files, code, whole websites
- ✏️ **`read_file` / `edit_file` / `list_files` / `grep` / `delete_file`** — full workspace file access
- 🖥️ **`run_shell`** — run real commands (PowerShell on Windows, bash elsewhere) in a shell that **persists** for the conversation
- ⏱️ **`start_job` / `job_output` / `job_kill` / `job_list`** — long-running commands in the background, without blocking the turn

Everything lands in `workspace/` — browsable from the **Workspace panel** (folder icon, top-right).

### Running real commands

`run_shell` executes anything the machine can — `git`, `npm`/`pnpm`, `python`, compilers, tests — and the shell **outlives the call**, so `cd`, environment variables and installed packages carry into the next command. A non-zero exit is reported as a failure with the real exit code, a timeout resets the shell instead of leaving it wedged, and output is truncated to a bounded head + tail rather than flooding the model's context.

Commands that should outlive the turn go in the background instead:

```
start_job  → job_ab12cd34   (returns immediately)
job_output → what it printed since your last read
job_kill   → stop it and everything it spawned
job_list   → every job, its status and unread output size
```

Each job keeps a bounded log, so polling a build shows each line once instead of repeating the whole log, and every job process is killed when HAMA exits — no orphaned dev server holding a port.

### Writing several files at once

`write_files` accepts every shape a model actually sends, because rejecting a clear request costs the whole call — and the model then falls back to one `write_file` per file, which is slower and burns the step budget:

```jsonc
{"files": [{"path": "index.html", "content": "…"}]}   // the documented form
{"files": {"index.html": "…", "style.css": "…"}}      // keyed by path
{"files": {"a.py": {"content": "…"}}}                 // keyed by path, wrapped
{"files": "[{\"path\": \"a.txt\", \"content\": \"…\"}]"} // JSON-encoded
{"filename": "a.js", "code": "…"}                     // alternate key names
```

A JSON string whose string bodies contain raw newlines (invalid JSON) is recovered rather than discarded, and a payload that genuinely cannot be read is refused with the shape it should have used — never half-written.

### Reading and editing large files

`read_file` truncates a long file instead of dumping it, and tells the model the line count so it can page through with `read_file({ path, offset, limit })` — the window comes back numbered. `edit_file` reports a real unified diff (`+`/`−` lines with context) alongside the line counts, so an edit is reviewable without opening the file.

### Getting unstuck

A model that repeats one identical tool call until the step budget runs out is a failure mode the budget alone cannot fix. Three layers handle it, because a hint is not always enough:

1. **Escalating reminders.** The first repeat gets a gentle nudge; **every** repeat after that gets one naming the tool, the run length and the arguments. Once a loop is confirmed the wording becomes an explicit instruction to stop and report. The chain never goes silent — a guard that stopped reminding is what let a model write the same five files seven times.
2. **A hard stop on repetition that changes nothing.** A *mutating* call (`write_file`, `write_files`, `edit_file`, `delete_file`, `run_script`, `run_shell`, `start_job`) repeated 8 times with identical arguments is refused before it runs, and the model is told the work is already done. Read-only tools are never refused: polling `job_output` while a build runs is real work, not a loop.
3. **Repeated narration is shown once.** A stuck text-protocol engine re-emits the same paragraph every step; an iteration consisting only of text the turn already produced is dropped, so the transcript shows the plan once instead of seven times. Anything new is always kept.

## Custom rules (per provider + global)

- **Global:** Settings → *Global rules* applies to **every provider and every model** — including the models the agent's team dispatches. While it is empty the agent uses its built-in default behaviour; as soon as you save something, that text is injected as a binding operator section at the end of the system prompt (the last instruction the model reads). **Reset to default** clears the field and puts the prompt back to exactly its default state.
- **Per provider:** each provider has a *Custom rules* field — injected into the system prompt with priority for every chat using that provider. Perfect for personas, tone, language, compliance rules.

## Agent tools vs. a normal chat

Each conversation has three tool groups in the composer — **Web search**, **File tools** and **App engine**. They apply per provider (a provider can have tools switched off entirely) and per conversation:

- Any group on → the conversation runs as an **agent**: the tools are offered to the model, it can call them, and it is told how.
- All three off, or tools disabled for the provider → a **normal chat**: no tool list is sent to the provider at all, and any tool the model names anyway is refused rather than executed.

## Where things live

```
ai-support-agent/
├── server.js            # zero-dep HTTP server: static + JSON API + SSE
├── src/
│   ├── providers.js     # presets + OpenAI/Anthropic/Gemini streaming adapters
│   ├── agent.js         # agentic loop (tool calls → results → final answer)
│   ├── tools.js         # web search, file tools, shell + job tools
│   ├── shell.js         # persistent PowerShell/bash session, timeouts, bounded output
│   ├── jobs.js          # background job registry (start / read / stop / list)
│   ├── diff.js          # unified-diff engine behind edit previews
│   ├── middleware/      # loop, payload, limits, diagnostics, todo, loop-guard
│   └── store.js         # JSON persistence
├── public/              # self-contained UI (no CDN — works offline)
├── data/                # providers.json (your API keys), chats.json, settings.json
└── workspace/           # the agent's file sandbox
```

**Privacy:** keys are stored only in `data/providers.json` on this machine. Requests go from this server straight to your chosen providers — nothing else.

## Notes

- Some models don't support tool calls — disable agent tools for that provider or choose a tool-capable model.
- Streaming runs over SSE; the stop button aborts the upstream request too (saves tokens).
- A `Stop` ends the reply, not the work: background jobs keep running until they finish, are stopped with `job_kill`, or the server exits.
- The conversation title comes from your first message; rename or delete chats from the sidebar.
- On Windows the shell is PowerShell. `pwsh` (PowerShell 7) is used when installed, otherwise Windows PowerShell 5.1 — install `pwsh` if you want the newer syntax everywhere.
