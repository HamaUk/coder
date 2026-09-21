// End-to-end proof that the agent loop works with a real model.
//
// scripts/check-models.js proves the model *can* call a tool. This proves the
// whole pipeline does: prompt -> model -> DSML tool call -> tool execution ->
// file on disk. It uses a scratch workspace, so it never touches your chats.
//
// Usage: node scripts/verify-agent.js [--model=<id>] [--keep]
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SCRATCH = process.env.HAMA_VERIFY_DIR || path.join(ROOT, '.smoke', 'workspace');

// Only the WORKSPACE is redirected to scratch. The real data/ dir is used (read
// only) so the real configured provider and its model are tested; runAgent never
// persists a chat, so nothing in your history is touched.
process.env.HAMA_WORKSPACE_DIR = SCRATCH;

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const KEEP = argv.includes('--keep');
const WANT_MODEL = opt('model', '');

const store = require(path.join(ROOT, 'src', 'store'));
const agent = require(path.join(ROOT, 'src', 'agent'));
const toolsKit = require(path.join(ROOT, 'src', 'tools'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const base = store.getProviders().find((p) => p.enabled !== false);
  if (!base) {
    console.error('No provider configured.');
    process.exit(1);
  }
  const provider = { ...base, model: WANT_MODEL || base.model };
  const chatId = 'verify_agent_' + Date.now();

  const events = [];
  const emit = (type, data) => events.push({ type, data });

  console.log(`\n  Provider: ${provider.name} (${provider.type})`);
  console.log(`  Model:    ${provider.model}`);
  console.log(`  Target:   ${path.join(SCRATCH, 'chats', chatId)}\n`);

  const started = Date.now();
  let res;
  try {
    res = await agent.runAgent({
      provider,
      providers: [provider],
      history: [{ role: 'user', content: 'Create a file called verify.txt containing exactly the word: works' }],
      tools: { web: false, files: true, code: false },
      settings: { agentName: 'HAMA', agent: { mode: 'solo', crewEnabled: false } },
      signal: null,
      emit,
      chatId
    });
  } catch (e) {
    check('the agent turn completed', false, e.message);
    console.log(`\n  0/${results.length} checks passed\n`);
    process.exit(1);
  }

  const toolStarts = events.filter((e) => e.type === 'tool_start');
  const names = (res.toolRuns || []).map((r) => r.name);
  const wrote = (res.toolRuns || []).some((r) => /^(write_file|write_files)$/.test(r.name));
  const file = path.join(SCRATCH, 'chats', chatId, 'verify.txt');
  const onDisk = fs.existsSync(file);

  check('the agent turn completed', true, `${Date.now() - started}ms`);
  check('it called a real tool (not just prose)', toolStarts.length > 0, names.join(', ') || 'none');
  check('it wrote the file with write_file', wrote, names.join(', ') || 'none');
  check('the file exists on disk', onDisk, file);

  if (onDisk) {
    const body = fs.readFileSync(file, 'utf8');
    check('the file has the requested content', /works/.test(body), JSON.stringify(body.slice(0, 40)));
  }

  if (!KEEP) {
    try { fs.rmSync(path.join(SCRATCH, 'chats', chatId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n  ${results.length - failed}/${results.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(2);
});
