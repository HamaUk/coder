// Simple JSON-file persistence layer (no external dependencies).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Overridable so a test run can point at a scratch directory instead of the
// real one — the stores are plain files with no transactions to roll back.
const DATA_DIR = process.env.HAMA_DATA_DIR
  ? path.resolve(process.env.HAMA_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const WORKSPACE_DIR = process.env.HAMA_WORKSPACE_DIR
  ? path.resolve(process.env.HAMA_WORKSPACE_DIR)
  : path.join(__dirname, '..', 'workspace');

for (const dir of [DATA_DIR, WORKSPACE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Reads a JSON store.
 *
 * A corrupt or unreadable file used to be indistinguishable from a missing one:
 * the parse error was swallowed and the fallback returned, so `getProviders()`
 * happily re-seeded over a providers.json it simply could not parse — destroying
 * every configured provider and its API key — and the next chat write replaced a
 * damaged chats.json with `[]`. A file that exists but will not parse is now
 * copied aside first, so the data is recoverable.
 */
function readJSON(file, fallback) {
  const target = path.join(DATA_DIR, file);
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    console.error(`[store] could not read ${file}: ${e.message}`);
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const bak = `${target}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(target, bak); } catch { /* best effort */ }
    console.error(`[store] ${file} is not valid JSON (${e.message}). A copy was kept at ${bak}.`);
    return fallback;
  }
}

// Two writes that share a staging filename can rename each other's half-written
// bytes into place, so the name is unique per call, not just per process.
let writeSeq = 0;

function writeJSON(file, data) {
  const target = path.join(DATA_DIR, file);
  const tmp = `${target}.${process.pid}.${++writeSeq}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Serialised read-modify-write transactions
// ---------------------------------------------------------------------------
// Every mutation of a JSON store is a read -> change -> write of the WHOLE file.
// Two of those overlapping in time silently discard one of the two changes
// (the classic lost update), and because a chat turn can run for minutes while
// holding a snapshot, the window is wide: deleting a chat or renaming it while
// a reply streams would be undone when the reply is persisted.
//
// Everything here runs in one Node process, so a promise chain is a sufficient
// mutex — `withLock` guarantees the next transaction only starts after the
// previous one has finished writing.
function makeLock() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

const withChatsLock = makeLock();
const withProvidersLock = makeLock();
const withSettingsLock = makeLock();

/**
 * Runs `fn(chats)` as a locked transaction and persists the result.
 * `fn` mutates the array it is given and returns whatever the caller needs.
 * The array is re-read from disk inside the lock, so it is never stale.
 */
function mutateChats(fn) {
  return withChatsLock(() => {
    const chats = getChats();
    const out = fn(chats);
    saveChats(chats);
    return out;
  });
}

function mutateProviders(fn) {
  return withProvidersLock(() => {
    const providers = getProviders();
    const out = fn(providers);
    saveProviders(providers);
    return out;
  });
}

function mutateSettings(fn) {
  return withSettingsLock(() => {
    const settings = getSettings();
    const out = fn(settings);
    writeJSON('settings.json', settings);
    return out;
  });
}

// ---------- Providers ----------
function getProviders() {
  const list = readJSON('providers.json', null);
  if (Array.isArray(list)) return list;
  // Seed ONLY when the file genuinely does not exist. Seeding over an existing
  // file that merely failed to parse overwrote every stored API key.
  if (!fs.existsSync(path.join(DATA_DIR, 'providers.json'))) return seedProviders();
  return [];
}

function seedProviders() {
  const llamacoder = {
    id: 'prov_llamacoder',
    name: 'LlamaCoder (Free / No Key)',
    type: 'llamacoder',
    presetId: 'llamacoder',
    apiKey: '',
    baseUrl: 'https://llamacoder.together.ai',
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    temperature: 0.4,
    maxTokens: 20000,
    customInstructions: '',
    toolsEnabled: true,
    enabled: true,
    modelsCache: [
      'deepseek-ai/DeepSeek-V4-Flash-0731',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
      'zai-org/GLM-5.3-Flash',
      'zai-org/GLM-5.2'
    ],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  writeJSON('providers.json', [llamacoder]);
  return [llamacoder];
}

function saveProviders(list) {
  writeJSON('providers.json', list);
}

function getProvider(id) {
  return getProviders().find(p => p.id === id) || null;
}

// ---------- Chats ----------
function getChats() {
  return readJSON('chats.json', []);
}

function saveChats(list) {
  writeJSON('chats.json', list);
}

function getChat(id) {
  return getChats().find(c => c.id === id) || null;
}

// ---------- Settings ----------
const DEFAULT_SETTINGS = {
  agentName: 'HAMA',
  theme: 'dark',
  defaultProviderId: 'prov_llamacoder',
  globalInstructions: '',
  agent: {
    // 'auto' — dispatch the crew only for genuine project requests.
    // 'crew' — always collaborate with the rest of the enabled team.
    // 'solo' — never collaborate; a single model handles the whole turn.
    mode: 'auto',
    crewEnabled: true,
    crewSize: 2,
    maxSteps: 60,
    maxAutoContinues: 12
  }
};

function getSettings() {
  const raw = readJSON('settings.json', {});
  const merged = { ...DEFAULT_SETTINGS, ...raw };

  // Deep-merge the nested `agent` block so a partial settings.json can never
  // drop a default (e.g. an older file that predates the crew settings).
  if (raw.agent && typeof raw.agent === 'object' && !Array.isArray(raw.agent)) {
    merged.agent = { ...DEFAULT_SETTINGS.agent, ...raw.agent };
  }

  // `pipeline` was removed when the multi-stage mode was dropped. Older
  // settings.json files still carry the key; strip it so it cannot resurface
  // through /api/settings or get written back on the next save.
  delete merged.pipeline;

  return merged;
}

function saveSettings(s) {
  writeJSON('settings.json', { ...getSettings(), ...s });
}

// ---------- Per-Chat Workspaces ----------
const CHATS_WORKSPACE_DIR = path.join(WORKSPACE_DIR, 'chats');
if (!fs.existsSync(CHATS_WORKSPACE_DIR)) fs.mkdirSync(CHATS_WORKSPACE_DIR, { recursive: true });

/**
 * Whether an id can name a per-chat workspace directory.
 *
 * The sanitiser below strips anything outside `[A-Za-z0-9_-]`, so an id made
 * entirely of other characters sanitises to the empty string and `path.join`
 * would land on the `chats/` PARENT — the shared workspace root. Every caller
 * that needs a chat-scoped directory has to check this first: `getChatWorkspaceDir`
 * returning null is not an error signal to the caller, it is a "no workspace",
 * and the file endpoints then fall back to the root and serve every other
 * conversation's files.
 *
 * @param {unknown} chatId - the id to test.
 * @returns {boolean} true when the id names a usable chat workspace.
 */
function isValidChatId(chatId) {
  if (typeof chatId !== 'string') return false;
  const clean = chatId.replace(/[^a-zA-Z0-9_-]/g, '');
  return clean.length > 0 && clean.length <= 64 && clean === chatId;
}

function getChatWorkspaceDir(chatId) {
  if (!chatId) return null;
  const clean = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return null;
  const dir = path.join(CHATS_WORKSPACE_DIR, clean);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function deleteChatWorkspace(chatId) {
  if (!chatId) return;
  const clean = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return;
  const dir = path.join(CHATS_WORKSPACE_DIR, clean);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* ignore */ }
}

module.exports = {
  DATA_DIR,
  WORKSPACE_DIR,
  CHATS_WORKSPACE_DIR,
  isValidChatId,
  getChatWorkspaceDir,
  deleteChatWorkspace,
  uid,
  getProviders,
  saveProviders,
  getProvider,
  getChats,
  saveChats,
  getChat,
  mutateChats,
  mutateProviders,
  mutateSettings,
  getSettings,
  saveSettings
};

