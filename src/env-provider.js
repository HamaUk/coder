// Optional provider seeding from the environment.
//
// WHY THIS EXISTS
// A host with an ephemeral filesystem — Render's free plan, Hugging Face Spaces,
// any container without a mounted volume — boots every redeploy and every wake
// from sleep with an empty `data/`. Everything configured in the console is gone,
// so the app comes up with only the built-in no-key engine and the operator has
// to paste their API key in again after every single restart. On a host where a
// disk cannot be mounted, an environment variable is the only thing that
// survives, and this turns that variable into a provider.
//
// WHAT IT DOES NOT DO
// It never edits, disables or deletes a provider that already exists, and it does
// nothing at all once any configured provider holds a key — so a normal install,
// where the operator added their provider in the UI, is untouched. It is the
// last resort of a boot, not a configuration channel that overrides the console.
//
// The key is never logged, and is written only into the same providers.json the
// UI writes it to.
const store = require('./store');
const { PRESETS } = require('./providers');

/** The environment variable names, in one place so the docs and the code agree. */
const ENV_NAMES = {
  preset: 'HAMA_PROVIDER_PRESET',
  key: 'HAMA_PROVIDER_KEY',
  model: 'HAMA_PROVIDER_MODEL',
  baseUrl: 'HAMA_PROVIDER_BASE_URL',
  type: 'HAMA_PROVIDER_TYPE',
  name: 'HAMA_PROVIDER_NAME'
};

function readEnv(env, key) {
  const raw = env[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Adds a provider described by the environment, if one is asked for and none is
 * configured yet.
 *
 * @param {object} [env] - environment to read (defaults to process.env).
 * @returns {{provider: object, reason: null}|{provider: null, reason: string}}
 *   `provider` is the row that was written, or null with the reason it was not.
 */
function seedProviderFromEnv(env = process.env) {
  const key = readEnv(env, ENV_NAMES.key);
  if (!key) return { provider: null, reason: 'no ' + ENV_NAMES.key };

  const existing = store.getProviders();
  // A provider with a key means somebody configured this console already —
  // through the UI, or on a previous boot with a persistent disk. Leave it be.
  if (existing.some((p) => p && String(p.apiKey || '').trim())) {
    return { provider: null, reason: 'a provider with a key is already configured' };
  }

  const presetId = readEnv(env, ENV_NAMES.preset).toLowerCase();
  const preset = PRESETS.find((p) => p.id === presetId) || null;
  if (presetId && !preset) {
    return { provider: null, reason: 'unknown ' + ENV_NAMES.preset + ' "' + presetId + '"' };
  }

  const type = readEnv(env, ENV_NAMES.type) || (preset && preset.type) || 'openai';
  const baseUrl = readEnv(env, ENV_NAMES.baseUrl) || (preset && preset.baseUrl) || 'https://api.openai.com/v1';
  const model = readEnv(env, ENV_NAMES.model) || (preset && preset.model) || '';
  if (!model) {
    return { provider: null, reason: 'no ' + ENV_NAMES.model + ' (and no preset default)' };
  }

  const provider = {
    id: 'prov_' + store.uid().replace(/-/g, '').slice(0, 8),
    name: readEnv(env, ENV_NAMES.name) || (preset && preset.label) || 'Environment provider',
    type,
    presetId: preset ? preset.id : 'custom',
    apiKey: key,
    baseUrl,
    model,
    temperature: 0.7,
    maxTokens: null,
    customInstructions: '',
    toolsEnabled: preset ? preset.toolsEnabled !== false : true,
    enabled: true,
    modelsCache: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  store.saveProviders([...existing, provider]);

  // Make it the default, or the console would keep answering with the keyless
  // built-in engine and the deployment would look broken ("I set my key and it
  // still used the free model").
  const settings = store.getSettings();
  const current = (settings.defaultProviderId && existing.find((p) => p.id === settings.defaultProviderId)) || null;
  if (!current || !String(current.apiKey || '').trim()) {
    store.saveSettings({ defaultProviderId: provider.id });
  }

  return { provider, reason: null };
}

module.exports = { seedProviderFromEnv, ENV_NAMES };
