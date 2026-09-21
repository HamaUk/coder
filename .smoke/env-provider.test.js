// Seeding a provider from the environment.
//
// This exists for hosts with no persistent disk (Render's free plan, Hugging Face
// Spaces): `data/` is empty on every boot, so a provider added in the UI is gone
// after each restart. It runs at boot and WRITES providers.json, which makes it
// the most dangerous thing in the app to get wrong — a bug here could overwrite a
// working configuration or leak a key into a log. Both are pinned below.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'hama-envprov-'));
process.env.HAMA_DATA_DIR = path.join(SCRATCH, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(SCRATCH, 'workspace');

const store = require(path.join(ROOT, 'src', 'store'));
const { seedProviderFromEnv, ENV_NAMES } = require(path.join(ROOT, 'src', 'env-provider'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function resetData() {
  fs.rmSync(path.join(process.env.HAMA_DATA_DIR), { recursive: true, force: true });
  fs.mkdirSync(process.env.HAMA_DATA_DIR, { recursive: true });
}

// Deliberately NOT shaped like a real key: this repo is public, and a string
// that looks like a leaked OpenRouter key trips secret scanning and alarms the
// owner for nothing.
const OPENROUTER_KEY = 'not-a-real-key-for-tests-0123456789';

// ---------------------------------------------------------------------------
// 1. Nothing happens unless it is asked for
// ---------------------------------------------------------------------------
{
  resetData();
  const before = store.getProviders().length;
  const out = seedProviderFromEnv({});
  check('an unset HAMA_PROVIDER_KEY adds nothing', out.provider === null && store.getProviders().length === before,
    out.reason || '');
}

// ---------------------------------------------------------------------------
// 2. A preset + key produces a usable, DEFAULT provider
// ---------------------------------------------------------------------------
{
  resetData();
  const out = seedProviderFromEnv({
    [ENV_NAMES.preset]: 'openrouter',
    [ENV_NAMES.key]: OPENROUTER_KEY,
    [ENV_NAMES.model]: 'anthropic/claude-3.5-sonnet'
  });
  const p = out.provider;
  check('a provider was created from the preset', Boolean(p), out.reason || '');
  check('it takes the protocol and base URL from the preset',
    p && p.type === 'openai' && p.baseUrl === 'https://openrouter.ai/api/v1',
    p ? p.type + ' ' + p.baseUrl : '');
  check('it carries exactly the model that was asked for', p && p.model === 'anthropic/claude-3.5-sonnet');
  check('it is enabled and can call tools', p && p.enabled === true && p.toolsEnabled === true);
  check('the key is stored on the provider', p && p.apiKey === OPENROUTER_KEY);
  check('it was persisted, not just returned',
    store.getProviders().some((x) => x.id === p.id && x.apiKey === OPENROUTER_KEY));
  check('it became the DEFAULT, so the console does not quietly answer with the no-key engine',
    store.getSettings().defaultProviderId === p.id,
    store.getSettings().defaultProviderId);

  // -------------------------------------------------------------------------
  // 3. Idempotent, and never destructive
  // -------------------------------------------------------------------------
  const again = seedProviderFromEnv({
    [ENV_NAMES.preset]: 'openrouter',
    [ENV_NAMES.key]: OPENROUTER_KEY,
    [ENV_NAMES.model]: 'anthropic/claude-3.5-sonnet'
  });
  check('a second boot does not add a duplicate', again.provider === null && /already configured/i.test(again.reason),
    again.reason || '');
  check('exactly one provider holds the key',
    store.getProviders().filter((x) => x.apiKey === OPENROUTER_KEY).length === 1);

  // A provider somebody configured by hand wins, key and model intact.
  resetData();
  const mine = {
    id: 'prov_mine', name: 'My provider', type: 'openai', apiKey: 'sk-mine',
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', enabled: true, toolsEnabled: true
  };
  store.saveProviders([mine]);
  const skipped = seedProviderFromEnv({
    [ENV_NAMES.preset]: 'openrouter',
    [ENV_NAMES.key]: OPENROUTER_KEY,
    [ENV_NAMES.model]: 'x/y'
  });
  const after = store.getProviders();
  check('a configured provider is left completely alone', skipped.provider === null && after.length === 1,
    skipped.reason || '');
  check('its key and model were not replaced', after[0].apiKey === 'sk-mine' && after[0].model === 'gpt-4o');
}

// ---------------------------------------------------------------------------
// 4. Bad input is refused with a reason, never half-applied
// ---------------------------------------------------------------------------
{
  resetData();
  const noModel = seedProviderFromEnv({ [ENV_NAMES.key]: OPENROUTER_KEY, [ENV_NAMES.preset]: 'openrouter', [ENV_NAMES.model]: '' });
  check('a preset supplies a default model, so a missing model is fine',
    Boolean(noModel.provider) && noModel.provider.model.length > 0, noModel.provider ? noModel.provider.model : noModel.reason);

  resetData();
  const badPreset = seedProviderFromEnv({ [ENV_NAMES.key]: OPENROUTER_KEY, [ENV_NAMES.preset]: 'not-a-preset' });
  check('an unknown preset is refused rather than guessed at',
    badPreset.provider === null && /unknown/i.test(badPreset.reason), badPreset.reason || '');
  check('a refused seed writes nothing', !store.getProviders().some((x) => x.apiKey === OPENROUTER_KEY));

  resetData();
  const noKey = seedProviderFromEnv({ [ENV_NAMES.preset]: 'openrouter', [ENV_NAMES.model]: 'x/y' });
  check('a keyless preset is not seeded (the UI must not show an empty provider)',
    noKey.provider === null, noKey.reason || '');

  resetData();
  const custom = seedProviderFromEnv({
    [ENV_NAMES.key]: 'local-key',
    [ENV_NAMES.baseUrl]: 'http://127.0.0.1:11434/v1',
    [ENV_NAMES.model]: 'llama3.1',
    [ENV_NAMES.name]: 'Ollama'
  });
  check('a custom endpoint needs no preset',
    custom.provider && custom.provider.baseUrl === 'http://127.0.0.1:11434/v1' && custom.provider.name === 'Ollama');
}

// ---------------------------------------------------------------------------
// 5. The key is never written anywhere but providers.json
// ---------------------------------------------------------------------------
{
  resetData();
  seedProviderFromEnv({ [ENV_NAMES.preset]: 'openrouter', [ENV_NAMES.key]: OPENROUTER_KEY, [ENV_NAMES.model]: 'x/y' });
  const dataDir = process.env.HAMA_DATA_DIR;
  const leaks = fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .filter((e) => e.name !== 'providers.json')
    .filter((e) => fs.readFileSync(path.join(dataDir, e.name), 'utf8').includes(OPENROUTER_KEY))
    .map((e) => e.name);
  check('the key lands only in providers.json', leaks.length === 0, leaks.join(', ') || 'no other file contains it');

  const source = fs.readFileSync(path.join(ROOT, 'src', 'env-provider.js'), 'utf8');
  check('the module never logs a value it read from the environment',
    !/console\.log\([^)]*(apiKey|\.key|key\b)/.test(source.replace(/console\.log\([^)]*reason[^)]*\)/g, '')));
}

try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
