// Oversized tool output storage.
//
// Before this, a tool that produced more text than was worth putting in the
// model's context simply dropped the rest: the model got a truncated blob and no
// way to see what it missed, so it would either guess or ask the user to paste the
// part that was cut. The full text is now written into the chat's own workspace
// and the model is handed a path it can read in windows, which is what the
// harness does with its spill store — minus the pluggable backends.
//
// The directory is dot-prefixed on purpose: list_files, the workspace tree and
// the ZIP download all skip dot-entries, so the artefacts stay retrievable
// without cluttering the project the user is actually building.
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');

const SPILL_DIR = '.spill';

// How much of a result stays inline. Comfortably more than a model needs to
// understand an output, comfortably less than a context window.
const MAX_INLINE_BYTES = 24000;

// Spill files are a debugging aid, not an archive. Keeping the newest handful
// bounds what one long session can accumulate.
const KEEP_FILES = 20;

/** Drops the oldest spill files once there are more than KEEP_FILES. */
function prune(spillDir) {
  try {
    const files = fs.readdirSync(spillDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(spillDir, e.name)).mtimeMs; } catch { /* ignore */ }
        return { name: e.name, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(KEEP_FILES)) {
      try { fs.unlinkSync(path.join(spillDir, f.name)); } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
}

/**
 * Writes the full text into the chat's workspace.
 *
 * @returns {{locator: string, bytes: number, retrievalHint: string}|null}
 *   `locator` is a workspace-relative path the model can pass straight to
 *   read_file; null when there is no workspace or the write failed.
 */
function saveText({ chatId, label, suggestedName, content }) {
  const text = String(content == null ? '' : content);
  let dir = null;
  try { dir = store.getChatWorkspaceDir(chatId); } catch { /* no workspace */ }
  if (!dir) return null;

  const spillDir = path.join(dir, SPILL_DIR);
  try {
    fs.mkdirSync(spillDir, { recursive: true });
    const stem = String(suggestedName || label || 'output')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/\.[^.]+$/, '')
      .slice(0, 48) || 'output';
    const ext = (path.extname(String(suggestedName || '')) || '.log').slice(0, 8);
    const name = `${stem}-${Date.now().toString(36)}${ext}`;
    fs.writeFileSync(path.join(spillDir, name), text, 'utf8');
    prune(spillDir);
    const locator = `${SPILL_DIR}/${name}`;
    return {
      locator,
      bytes: Buffer.byteLength(text),
      retrievalHint: `Read it with read_file({ "path": "${locator}", "offset": 1, "limit": 200 }), or search it with grep({ "pattern": "...", "path": "${locator}" }).`
    };
  } catch {
    return null;
  }
}

/**
 * Bounds a model-facing result to something worth sending, keeping the head and
 * the tail inline and putting the whole thing on disk.
 *
 * @returns {{text: string, spilled: object|null, truncated: boolean}}
 */
function boundResult({ chatId, label, suggestedName, text, maxBytes = MAX_INLINE_BYTES }) {
  const full = String(text == null ? '' : text);
  const bytes = Buffer.byteLength(full);
  if (bytes <= maxBytes) return { text: full, spilled: null, truncated: false };

  const ref = saveText({ chatId, label, suggestedName, content: full });
  const headBytes = Math.floor(maxBytes * 0.7);
  const tailBytes = maxBytes - headBytes;
  // Slice on characters, but budget on the bytes we actually measured: a
  // character is at most one UTF-16 unit here, so a byte-sized slice is always
  // at least as short as intended.
  const head = full.slice(0, headBytes);
  const tail = full.slice(-tailBytes);

  if (!ref) {
    // Storage is unavailable — say so rather than pointing at a file that is not
    // there.
    return {
      text: `${head}\n…[${bytes} bytes total; the middle could not be saved]\n${tail}`,
      spilled: null,
      truncated: true
    };
  }

  return {
    text: `${head}\n…[${bytes} bytes total — the middle is omitted here]\n${tail}\n\nFull output saved to ${ref.locator} (${ref.bytes} bytes). ${ref.retrievalHint}`,
    spilled: ref,
    truncated: true
  };
}

module.exports = { saveText, boundResult, MAX_INLINE_BYTES, SPILL_DIR, KEEP_FILES };
