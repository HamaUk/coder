// Live health check for every configured provider/model.
//
// Sends one tiny completion through the real adapter stack (the same code path
// the console uses) plus a tool-call probe, so a dead model, a bad key, or a
// rate limit is visible immediately instead of surfacing as a confusing reply
// in the chat.
//
// Usage:
//   npm run check:models
//   node scripts/check-models.js --timeout=60000
//   node scripts/check-models.js --only=GLM
//   node scripts/check-models.js --provider=prov_llamacoder
//   node scripts/check-models.js --no-tools
//   node scripts/check-models.js --json
const path = require('path');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'src', 'store'));
const providers = require(path.join(ROOT, 'src', 'providers'));

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const flag = (name) => argv.includes(`--${name}`);

const TIMEOUT = Math.max(5000, Number(opt('timeout', 45000)) || 45000);
const ONLY = opt('only', '');
const PROVIDER = opt('provider', '');
const AS_JSON = flag('json');
const WITH_TOOLS = !flag('no-tools');

/** Every provider/model pair the console could actually select. */
function targets() {
  const out = [];
  for (const p of store.getProviders()) {
    if (p.enabled === false) continue;
    if (PROVIDER && p.id !== PROVIDER) continue;
    const models = [];
    if (p.model) models.push(p.model);
    for (const m of p.modelsCache || []) if (!models.includes(m)) models.push(m);
    if (!models.length) models.push('(no model set)');
    for (const model of models) {
      if (ONLY && !model.includes(ONLY)) continue;
      out.push({ provider: p, model });
    }
  }
  return out;
}

(async () => {
  const list = targets();
  if (!list.length) {
    console.log('No enabled providers/models matched.');
    process.exit(1);
  }

  if (!AS_JSON) {
    console.log(`\n  Checking ${list.length} model(s) — ${TIMEOUT}ms timeout each${WITH_TOOLS ? ', tool call included' : ''}\n`);
  }

  const report = [];
  for (const { provider, model } of list) {
    if (!AS_JSON) process.stdout.write(`  ${provider.name} · ${model} … `);
    const r = await providers.probeModel(provider, model, { timeoutMs: TIMEOUT, withTools: WITH_TOOLS });
    report.push({ providerId: provider.id, provider: provider.name, type: provider.type, model, ...r });
    if (AS_JSON) continue;
    if (r.ok) {
      const ttft = r.ttftMs != null ? `, first token ${r.ttftMs}ms` : '';
      const tools = WITH_TOOLS
        ? (r.canCallTools ? `  tools: ${r.toolCalls.join(', ')}` : '  tools: NONE')
        : '';
      console.log(`OK    ${r.ms}ms${ttft}  ->  "${r.sample}"${tools}`);
    } else {
      console.log(`FAIL  ${r.ms}ms  ${String(r.error).slice(0, 150)}`);
    }
  }

  const failed = report.filter((r) => !r.ok);
  const noTools = report.filter((r) => r.ok && r.canCallTools === false);
  if (AS_JSON) {
    console.log(JSON.stringify({
      total: report.length,
      failed: failed.length,
      noToolCall: noTools.length,
      results: report
    }, null, 2));
  } else {
    console.log(`\n  ${report.length - failed.length}/${report.length} model(s) answered`);
    if (noTools.length) {
      console.log(`  Answered but did NOT call a tool: ${noTools.map((r) => r.model).join(', ')}`);
      console.log('  (fine for chat, weaker for agentic file/app work)');
    }
    if (failed.length) {
      console.log('  Failed:');
      for (const f of failed) console.log(`    - ${f.model}: ${String(f.error).slice(0, 120)}`);
    }
    console.log('');
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(2);
});
