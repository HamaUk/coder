// A unified-diff engine, for showing what an edit actually changed.
//
// WHY THIS EXISTS
// `edit_file` already reports "replaced 1 of 3 occurrence(s)", and the row shows
// `+4 −2` from the metadata. Those numbers tell the user *how much* changed and
// nothing about *what* changed — so the only way to see the effect of a surgical
// edit was to open the file and read the whole thing. This module produces the
// standard three-line-context unified diff the model and the UI can both render:
// the exact lines removed, the exact lines added, and enough surrounding context
// to locate them.
//
// HOW IT WORKS
// A classic longest-common-subsequence diff over lines. Files that reach an
// edit tool are source files — hundreds of lines, not millions — and the
// quadratic table is the honest implementation for that size: it produces the
// same hunks `git diff` would, with no heuristics to explain. Above
// MAX_DIFF_LINES the engine declines rather than allocating a table whose size
// is the square of the input (a 200k-line file would ask for 40 GB), and the
// caller falls back to the byte-size summary that already existed.
'use strict';

/**
 * Lines above which the diff is skipped. 2 × 20000² Int32 cells would be 3.2 GB,
 * so this is the point where the algorithm stops being the right tool rather
 * than an arbitrary style cutoff.
 */
const MAX_DIFF_LINES = 6000;

/**
 * Splits text into the lines a diff compares, preserving whether the file ends
 * with a newline.
 *
 * @param {string} text - file contents.
 * @returns {{lines: string[], trailingNewline: boolean}}
 */
function splitLines(text) {
  const value = String(text == null ? '' : text);
  const trailingNewline = value.endsWith('\n');
  const body = trailingNewline ? value.slice(0, -1) : value;
  // `''` is one empty line in a diff, but an empty *file* has no lines.
  const lines = body === '' && trailingNewline ? [] : body.split('\n');
  return { lines, trailingNewline };
}

/**
 * The edit script between two line arrays.
 *
 * @param {string[]} before - lines of the old content.
 * @param {string[]} after - lines of the new content.
 * @returns {Array<{type: 'same'|'del'|'add', text: string}>} the script, in order.
 */
function editScript(before, after) {
  const n = before.length;
  const m = after.length;
  // lcs[i * (m + 1) + j] = length of the longest common subsequence of
  // before[i..] and after[j..].
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * width;
    const nextRow = row + width;
    for (let j = m - 1; j >= 0; j--) {
      lcs[row + j] = before[i] === after[j]
        ? lcs[nextRow + j + 1] + 1
        : Math.max(lcs[nextRow + j], lcs[row + j + 1]);
    }
  }

  const script = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      script.push({ type: 'same', text: before[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      script.push({ type: 'del', text: before[i] });
      i++;
    } else {
      script.push({ type: 'add', text: after[j] });
      j++;
    }
  }
  while (i < n) script.push({ type: 'del', text: before[i++] });
  while (j < m) script.push({ type: 'add', text: after[j++] });
  return script;
}

/**
 * The counts the UI shows without rendering a diff at all.
 *
 * @param {Array<{type: string}>} script - an edit script.
 * @returns {{added: number, removed: number}} line counts.
 */
function countChanges(script) {
  let added = 0;
  let removed = 0;
  for (const step of script) {
    if (step.type === 'add') added++;
    else if (step.type === 'del') removed++;
  }
  return { added, removed };
}

/**
 * Groups an edit script into hunks with `context` unchanged lines around each
 * change, exactly as `diff -u` does: hunks closer than twice the context are
 * merged into one, and no hunk carries more context than it needs.
 *
 * @param {Array<{type: string, text: string}>} script - the edit script.
 * @param {number} [context] - unchanged lines to keep around each change.
 * @returns {Array<{oldStart: number, oldCount: number, newStart: number, newCount: number,
 *   lines: Array<{type: string, text: string, oldLine: number|null, newLine: number|null}>}>}
 */
function buildHunks(script, context = 3) {
  // Number every line so each hunk can print its own @@ header.
  const numbered = [];
  let oldLine = 1;
  let newLine = 1;
  for (const step of script) {
    numbered.push({
      type: step.type,
      text: step.text,
      oldLine: step.type === 'add' ? null : oldLine,
      newLine: step.type === 'del' ? null : newLine
    });
    if (step.type !== 'add') oldLine++;
    if (step.type !== 'del') newLine++;
  }

  const changedAt = numbered.map((line, index) => (line.type === 'same' ? -1 : index)).filter((index) => index !== -1);
  if (!changedAt.length) return [];

  const hunks = [];
  let start = Math.max(0, changedAt[0] - context);
  let end = Math.min(numbered.length, changedAt[0] + context + 1);
  for (const index of changedAt.slice(1)) {
    if (index - context <= end) {
      end = Math.min(numbered.length, index + context + 1);
      continue;
    }
    hunks.push(sliceHunk(numbered, start, end));
    start = Math.max(0, index - context);
    end = Math.min(numbered.length, index + context + 1);
  }
  hunks.push(sliceHunk(numbered, start, end));
  return hunks;
}

/** Turns one `[start, end)` range of numbered lines into a hunk record. */
function sliceHunk(numbered, start, end) {
  const lines = numbered.slice(start, end);
  const oldLines = lines.filter((line) => line.type !== 'add');
  const newLines = lines.filter((line) => line.type !== 'del');
  return {
    oldStart: oldLines.length ? oldLines[0].oldLine : 0,
    oldCount: oldLines.length,
    newStart: newLines.length ? newLines[0].newLine : 0,
    newCount: newLines.length,
    lines
  };
}

/**
 * Renders hunks as a unified diff.
 *
 * @param {Array<object>} hunks - from {@link buildHunks}.
 * @param {string} [path] - file name for the `---`/`+++` header.
 * @param {number} [maxLines] - stop after this many body lines and say how many followed.
 * @returns {{text: string, truncated: boolean, omitted: number}}
 */
function renderHunks(hunks, path = '', maxLines = 120) {
  if (!hunks.length) return { text: '', truncated: false, omitted: 0 };
  const out = [];
  if (path) {
    out.push('--- ' + path);
    out.push('+++ ' + path);
  }
  let shown = 0;
  let omitted = 0;
  for (const hunk of hunks) {
    const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
    if (shown >= maxLines) {
      omitted += hunk.lines.length + 1;
      continue;
    }
    out.push(header);
    shown++;
    for (const line of hunk.lines) {
      if (shown >= maxLines) {
        omitted++;
        continue;
      }
      const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      out.push(marker + line.text);
      shown++;
    }
  }
  if (omitted > 0) out.push(`…[${omitted} more diff lines — open the file to see the rest]`);
  return { text: out.join('\n'), truncated: omitted > 0, omitted };
}

/**
 * Full report for one edit: the script, its counts, the hunks and their text.
 *
 * @param {string} before - file contents before the edit.
 * @param {string} after - file contents after the edit.
 * @param {object} [options] - presentation options.
 * @param {string} [options.path] - file name for the header.
 * @param {number} [options.context] - unchanged lines to keep around each change.
 * @param {number} [options.maxLines] - body-line cap for {@link renderHunks}.
 * @returns {{skipped: boolean, reason?: string, added: number, removed: number,
 *   hunks: Array<object>, diff: string, truncated: boolean}}
 */
function diffText(before, after, { path = '', context = 3, maxLines = 120 } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.lines.length > MAX_DIFF_LINES || b.lines.length > MAX_DIFF_LINES) {
    return {
      skipped: true,
      reason: 'the file has more than ' + MAX_DIFF_LINES + ' lines',
      added: 0,
      removed: 0,
      hunks: [],
      diff: '',
      truncated: false
    };
  }
  if (a.lines.length === b.lines.length && a.lines.every((line, index) => line === b.lines[index])) {
    return { skipped: false, added: 0, removed: 0, hunks: [], diff: '', truncated: false };
  }

  const script = editScript(a.lines, b.lines);
  const counts = countChanges(script);
  const hunks = buildHunks(script, context);
  const rendered = renderHunks(hunks, path, maxLines);
  return {
    skipped: false,
    added: counts.added,
    removed: counts.removed,
    hunks,
    diff: rendered.text,
    truncated: rendered.truncated
  };
}

/**
 * Builds an excerpt suitable for a tool result: the diff, or nothing when it
 * would be longer than the value of showing it.
 *
 * @param {string} before - contents before the edit.
 * @param {string} after - contents after the edit.
 * @param {string} [path] - file name for the header.
 * @param {number} [maxLines] - body-line cap.
 * @returns {{diff: string, added: number, removed: number, skipped: boolean, truncated: boolean}}
 */
function editPreview(before, after, path = '', maxLines = 60) {
  const result = diffText(before, after, { path, maxLines, context: 2 });
  return {
    diff: result.skipped ? '' : result.diff,
    added: result.added,
    removed: result.removed,
    skipped: Boolean(result.skipped),
    truncated: Boolean(result.truncated)
  };
}

module.exports = {
  diffText,
  editPreview,
  editScript,
  buildHunks,
  renderHunks,
  countChanges,
  splitLines,
  MAX_DIFF_LINES
};
