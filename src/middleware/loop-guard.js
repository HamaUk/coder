// Repeat-call guard: notices when the model is calling the same tool with the
// same arguments over and over and says so in the conversation.
//
// WHY THIS EXISTS
// A step budget bounds a runaway turn, but it does not stop the pattern that
// burns the budget: the model calls `read_file` on the same path for the sixth
// time, or re-runs a `grep` that already returned "no matches", because the
// previous result did not change its mind. The turn then ends "exhausted" —
// which reads to the user as the agent being broken, not as it being stuck.
//
// WHAT IT DOES
// It counts CONSECUTIVE identical calls (tool name + canonicalised arguments)
// and, at the second, fourth and sixth repeat, adds a short instruction to the
// conversation next to that call's result. The first is gentle; the later ones
// name the tool, the run length and the arguments, because by then the model has
// ignored a hint and needs the specifics.
//
// It ALSO counts a second kind of repeat that identical arguments can never see:
// the same set of files being written again and again with DIFFERENT content.
// That is the loop this project actually recorded — seven rewrites of five
// files, each pass smaller than the last — and it is worse than a wasted call,
// because every pass overwrites the previous version. See REWRITE_BLOCK_AT.
//
// WHAT IT DOES NOT DO
// It never rewrites a result and never fails a turn by itself. Past the
// thresholds a mutating call is refused with a reason the model can read — see
// BLOCK_AT and REWRITE_BLOCK_AT — but a model that genuinely needs to poll
// something (a build finishing, a server starting) still can: read-only tools
// are never refused.
//
// The counter is keyed per run and reset by a user message, so repetition across
// a real user interjection is not a loop, and two overlapping turns on one chat
// cannot share a chain. It is also reset by any DIFFERENT call, because the
// chain is about consecutive identical work.
'use strict';

/**
 * Repeat counts that earn an escalating reminder.
 *
 * The first entry is the gentle nudge. Every count from the second entry onward
 * gets a reminder — not only the listed ones. A chain that went quiet after its
 * last threshold is exactly how a model wrote the same five files seven times
 * and then repeated its own narration until the step budget ran out: the guard
 * had said all it had to say by call seven, and the model simply kept going.
 * Once a loop is confirmed, silence is the one thing that cannot work.
 */
const THRESHOLDS = [2, 4, 6];

/**
 * Consecutive identical calls at which the reminder stops being a hint and
 * becomes an instruction to stop and report.
 */
const FIRM_AT = 6;

/**
 * Consecutive identical MUTATING calls at which the call is refused outright.
 *
 * Reminders alone did not stop the recorded loop: the model received four of
 * them — one per repeat, growing firmer each time — and wrote the same five
 * files seven times anyway before the step budget ended the turn. At that point
 * the only thing left that respects the user's quota is to stop running the
 * call.
 *
 * Only tools that CHANGE something are ever refused. Re-reading a file or
 * polling `job_output` is how a model legitimately waits for a build, and
 * blocking that would break real work to fix a cosmetic one.
 */
const BLOCK_AT = 8;

/** Tools whose repetition is pure waste: the work is already done and stored. */
const MUTATING_TOOLS = new Set([
  'write_file',
  'write_files',
  'edit_file',
  'create_directory',
  'delete_file',
  'run_script',
  'run_shell',
  'start_job',
  'llamacoder_generate'
]);

/**
 * The tools that REWRITE a whole file, and the thresholds for a rewrite loop.
 *
 * The identical-argument chain above cannot see the loop this app actually
 * recorded: `write_files` was called seven times with the SAME five paths and
 * DIFFERENT content each time — the model re-derived the whole project every
 * step and each pass was smaller than the last (1441 → 1201 → 1091 → … → 918
 * bytes). Every argument object was unique, so nothing counted it as a repeat,
 * and the turn ended with the WORST version of the project on disk: each pass
 * overwrote the previous one. A file rewrite is not "different work" just
 * because the bytes moved; re-writing the same set of files in a row is the
 * loop, and the fix is to stop the model before it degrades its own output.
 *
 * The count only advances when the content CHANGES (an identical call is the
 * other chain's business), so a model that writes a file, edits it, and writes
 * it again is not affected: that is not a consecutive rewrite of one set with
 * no other work in between.
 */
const REWRITE_TOOLS = new Set(['write_file', 'write_files']);
const REWRITE_REMIND_AT = 2;
const REWRITE_FIRM_AT = 3;
const REWRITE_BLOCK_AT = 4;

/** The chain key for a run's rewrite chain, kept beside its identical-call chain. */
const REWRITE_SUFFIX = '\u0001rewrite';

/**
 * The gentle first reminder.
 *
 * It states the observation without assuming the model is wrong: a second
 * identical call is often perfectly reasonable, and a reminder that scolds on
 * the first repeat trains the model to ignore reminders.
 */
const GENTLE = [
  'You have now made this exact tool call twice with identical arguments.',
  'Check the previous result before calling it again: if the answer is already there, use it;',
  'if it is not, change the arguments or the approach rather than repeating the call.'
].join(' ');

/** How many characters of the arguments a detailed reminder quotes. */
const ARGUMENT_PREVIEW_CHARS = 400;

/**
 * The escalating reminder, naming the call and its run length.
 *
 * @param {string} tool - tool name.
 * @param {number} count - consecutive identical calls so far.
 * @param {string} argumentsPreview - the canonical arguments, already bounded.
 * @returns {string} the reminder text.
 */
function detailed(tool, count, argumentsPreview) {
  const lines = [
    `Repeated tool call detected: ${tool} has now been called ${count} times in a row with identical arguments.`,
    `Arguments: ${argumentsPreview}`,
    'These calls are not making progress — the result cannot have changed.',
    'Do not call this tool with these arguments again. Read the latest result, then either take a different action,',
    'change the arguments, or tell the user what is blocking the task.'
  ];
  if (count >= FIRM_AT) {
    // Past this point the instruction has to be unambiguous, because a model
    // this deep into a loop is not reading hints — it is re-deriving the same
    // plan from a transcript that already contains the work.
    lines.push(
      '',
      `STOP. This is call ${count}. The work you are repeating has already been done and stored —`,
      'calling again cannot change the outcome. Reply to the user in plain text now, summarising what',
      'exists, and do not call this tool again in this turn.'
    );
  }
  return lines.join('\n');
}

/**
 * Deep key-sort so two argument objects that differ only in property order
 * canonicalise identically. Argument values reach the loop as parsed JSON (or as
 * the raw string when the model emitted malformed JSON), so JSON's value domain
 * is the whole input domain here.
 *
 * @param {unknown} value - a parsed argument value.
 * @returns {unknown} the same value with object keys in sorted order.
 */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
    return sorted;
  }
  return value;
}

/**
 * The identity of a call: its name plus its canonical arguments.
 *
 * @param {string} name - tool name.
 * @param {unknown} args - the call's arguments.
 * @returns {string} a stable key.
 */
function callKey(name, args) {
  let canonical;
  try {
    canonical = JSON.stringify(sortValue(args));
  } catch {
    // A cyclic or otherwise unserialisable argument object cannot be compared
    // structurally; treating it as its own unique key is safer than throwing.
    canonical = String(args);
  }
  return String(name) + '\u0000' + canonical;
}

/** A bounded, single-line rendering of a call's arguments for the reminder. */
function previewArgs(args) {
  let text;
  try {
    text = JSON.stringify(args);
  } catch {
    text = String(args);
  }
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ');
  return value.length > ARGUMENT_PREVIEW_CHARS
    ? value.slice(0, ARGUMENT_PREVIEW_CHARS) + '… (+' + (value.length - ARGUMENT_PREVIEW_CHARS) + ' more characters)'
    : value;
}

/**
 * The per-run chains: one last-call key and run length per run key.
 *
 * A `Map` rather than a `WeakMap` because the key is the loop's own run key
 * string; entries are released by {@link reset} when the turn ends, and the size
 * cap is a backstop against a caller that forgets to.
 *
 * @type {Map<string, {key: string, count: number, reminded: Set<number>}>}
 */
const chains = new Map();
const MAX_CHAINS = 64;

/** Drops every chain. Used when a turn ends and by the tests. */
function resetAll() {
  chains.clear();
}

/**
 * Drops one run's chain.
 *
 * @param {string|null} runKey - the loop's run key.
 */
function reset(runKey) {
  if (!runKey) return;
  chains.delete(String(runKey));
  // Both chains belong to the run: leaving the rewrite chain behind would let a
  // later turn inherit a count it never earned.
  chains.delete(String(runKey) + REWRITE_SUFFIX);
}

/**
 * Clears only the rewrite chain, keeping the identical-call chain.
 *
 * A new STAGE of the same turn — a repair round, the completeness round, a crew
 * reviewer taking its turn — is not the same model re-deriving the same plan:
 * it is a different pass over the same files, which is the whole point of those
 * stages. Without this, a lead that wrote five files, a completeness round that
 * finished them and two reviewers that polished them would trip the rewrite
 * limit on the fourth pass and the reviewers would be refused the edit they
 * exist to make. Repetition WITHIN one stage is still caught, which is the
 * failure the guard was built for.
 *
 * @param {string|null} runKey - the loop's run key.
 */
function resetRewrite(runKey) {
  if (runKey) chains.delete(String(runKey) + REWRITE_SUFFIX);
}

/** The escalation text for a file set that keeps coming back with new content. */
function rewriteReminder(count) {
  const lines = [
    `Rewrite loop detected: the same files have now been written ${count} times in a row,`,
    'each time with different content. Every pass replaces the previous version, so this is not',
    'progress — whatever is on disk now is simply whichever pass ran last.',
    'Stop rewriting them. Read what is on disk, then either fix only what is genuinely broken with',
    'edit_file, or reply to the user in plain text saying what is still missing.'
  ];
  if (count >= REWRITE_FIRM_AT) {
    lines.push(
      '',
      `STOP. This is pass ${count} over the same files. Do not write them again in this turn.`,
      'Reply now, in plain text, describing what exists.'
    );
  }
  return lines.join('\n');
}

/**
 * Advances the rewrite chain for one call and returns its reminder, if any.
 *
 * @param {string} runKey - the loop's run key.
 * @param {string} fileKey - the call's file-set identity.
 * @param {string} callId - the call's full identity (name + canonical arguments).
 * @returns {string|null} the reminder to append, or null.
 */
function observeRewrite(runKey, fileKey, callId) {
  if (!fileKey) return null;
  const chainKey = String(runKey) + REWRITE_SUFFIX;
  let chain = chains.get(chainKey);
  if (!chain || chain.fileKey !== fileKey) {
    chains.set(chainKey, { fileKey, count: 1, lastKey: callId, reminded: new Set() });
    return null;
  }
  // An identical argument object is the identical-call chain's business; this
  // chain only advances when the SAME files come back with DIFFERENT content.
  if (chain.lastKey !== callId) chain.count++;
  chain.lastKey = callId;
  const count = chain.count;
  if (count < REWRITE_REMIND_AT || chain.reminded.has(count)) return null;
  chain.reminded.add(count);
  return rewriteReminder(count);
}

/**
 * Records one executed call and returns the reminder to append to its result.
 *
 * Counting happens for every call, including one whose result was an error or a
 * refusal: a model hammering a call that fails is exactly the loop worth
 * breaking.
 *
 * @param {object} request - the call that just ran.
 * @param {string} request.runKey - the loop's run key for this turn.
 * @param {string} request.name - tool name.
 * @param {unknown} request.args - the arguments the tool was called with.
 * @returns {string|null} the reminder to append, or null when no threshold was hit.
 */
function observe({ runKey, name, args } = {}) {
  if (!runKey || !name) return null;
  const key = callKey(name, args);
  // The rewrite chain is consulted first: it can only be advancing when the
  // content CHANGED, so the identical-call chain below is silent on exactly
  // those calls. One of the two always has something to say about a repeat.
  const rewrite = observeRewrite(String(runKey), fileSetKey(name, args), key);

  const existing = chains.get(String(runKey));
  const count = existing && existing.key === key ? existing.count + 1 : 1;

  if (!existing || existing.key !== key) {
    if (!chains.has(String(runKey)) && chains.size >= MAX_CHAINS) {
      // Every chain here belongs to a finished or abandoned run; the oldest one
      // is the safest to drop.
      const oldest = chains.keys().next();
      if (!oldest.done) chains.delete(oldest.value);
    }
    chains.set(String(runKey), { key, count: 1, reminded: new Set() });
  } else {
    existing.count = count;
  }

  const chain = chains.get(String(runKey));

  // The first repeat gets the gentle nudge, and only once.
  if (count === THRESHOLDS[0]) {
    if (!chain.reminded.has(count)) {
      chain.reminded.add(count);
      return GENTLE;
    }
    return rewrite;
  }

  // Every repeat beyond that gets a reminder, once per count. This is the part
  // that must not fall silent: a model in a confirmed loop needs to be told at
  // call 8 just as much as at call 4, because it is re-deriving the same plan
  // from a transcript that already contains the work.
  if (count > THRESHOLDS[0]) {
    if (!chain.reminded.has(count)) {
      chain.reminded.add(count);
      return detailed(name, count, previewArgs(args));
    }
    return rewrite;
  }

  return rewrite;
}

/**
 * The file set a write call targets, as a stable identity — or null.
 *
 * Paths are normalised (separator, leading `./`) and sorted, so the same five
 * files listed in a different order are still the same set. Accepts every shape
 * `write_files` allows plus a single-path `write_file`.
 *
 * @param {string} name - tool name.
 * @param {unknown} args - the call's arguments.
 * @returns {string|null} the fileset key, or null when this is not a rewrite.
 */
function fileSetKey(name, args) {
  if (!REWRITE_TOOLS.has(String(name))) return null;
  const a = args && typeof args === 'object' ? args : {};
  let paths = [];
  if (Array.isArray(a.files)) paths = a.files.map((f) => f && f.path).filter(Boolean);
  else if (a.files && typeof a.files === 'object') paths = Object.keys(a.files);
  else if (typeof a.path === 'string') paths = [a.path];
  if (!paths.length) return null;
  const norm = paths
    .map((p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim())
    .filter(Boolean)
    .sort();
  if (!norm.length) return null;
  return String(name) + '\u0001' + norm.join('|');
}

/**
 * Whether this call has been repeated so often that running it again is waste.
 *
 * Checked BEFORE execution, unlike {@link observe}: a refused call must not do
 * the work a seventh or eighth time. The refusal is reported as a tool error so
 * the model sees a reason rather than silence, and only mutating tools are ever
 * refused — see {@link BLOCK_AT}.
 *
 * @param {object} request - the call about to run.
 * @param {string} request.runKey - the loop's run key for this turn.
 * @param {string} request.name - tool name.
 * @param {unknown} request.args - the arguments it was called with.
 * @returns {{blocked: boolean, output?: string}} whether to refuse it.
 */
function shouldBlock({ runKey, name, args } = {}) {
  if (!runKey || !name) return { blocked: false };
  if (!MUTATING_TOOLS.has(String(name))) return { blocked: false };
  const chain = chains.get(String(runKey));
  // `chain.count` is how many identical calls have already RUN, and this call is
  // refused once that reaches BLOCK_AT — i.e. the (BLOCK_AT + 1)th call in the
  // chain is the first refused, and BLOCK_AT-1 repeats never trigger it. The
  // suite in `.smoke/shell.test.js` pins exactly that pair of cases.
  if (!chain || chain.count < BLOCK_AT) return { blocked: false };
  if (chain.key !== callKey(name, args)) return { blocked: false };
  const output = [
    `Refused: ${name} has been called ${chain.count} times in a row with identical arguments,`,
    'and the work it performs has already been done and stored — running it again cannot change anything.',
    'Reply to the user in plain text now and summarise what exists. Do not call this tool again in this turn.'
  ].join(' ');
  return { blocked: true, output };
}

/**
 * Whether this rewrite is past the point where another pass destroys work.
 *
 * Checked before execution, like {@link shouldBlock}, and only for a write of a
 * file set that has already been rewritten repeatedly in this run.
 *
 * @param {object} request - the call about to run.
 * @param {string} request.runKey - the loop's run key.
 * @param {string} request.name - tool name.
 * @param {unknown} request.args - the arguments it was called with.
 * @returns {{blocked: boolean, output?: string}} whether to refuse it.
 */
function shouldBlockRewrite({ runKey, name, args } = {}) {
  if (!runKey || !name) return { blocked: false };
  const fileKey = fileSetKey(name, args);
  if (!fileKey) return { blocked: false };
  const chain = chains.get(String(runKey) + REWRITE_SUFFIX);
  if (!chain || chain.fileKey !== fileKey) return { blocked: false };
  // Same convention as shouldBlock: the rewrite is refused once REWRITE_BLOCK_AT
  // rewrites of this file set have already run.
  if (chain.count < REWRITE_BLOCK_AT) return { blocked: false };
  const output = [
    `Refused: this turn has already written ${chain.count} different versions of the same files,`,
    'and each pass replaced the last one — the version on disk right now is the newest, and rewriting it',
    'again cannot improve it, only replace it. Stop writing these files.',
    'Read what is on disk, then reply to the user in plain text describing what exists and what is missing.'
  ].join(' ');
  return { blocked: true, output };
}

/**
 * Whether a user message arrived, which means the context changed and
 * repetition across it is not a loop. The loop calls this before each model
 * step with the messages it is about to send.
 *
 * @param {string|null} runKey - the loop's run key.
 * @param {Array<{role?: string}>} messages - the messages about to be sent.
 * @returns {boolean} whether the chain was cleared.
 */
function noteNewUserTurn(runKey, messages) {
  if (!runKey) return false;
  if (Array.isArray(messages) && messages.some((message) => message && message.role === 'user')) {
    reset(runKey);
    return true;
  }
  return false;
}

module.exports = {
  observe,
  shouldBlock,
  shouldBlockRewrite,
  reset,
  resetRewrite,
  resetAll,
  noteNewUserTurn,
  callKey,
  previewArgs,
  fileSetKey,
  THRESHOLDS,
  GENTLE,
  FIRM_AT,
  BLOCK_AT,
  MUTATING_TOOLS,
  ARGUMENT_PREVIEW_CHARS,
  REWRITE_TOOLS,
  REWRITE_REMIND_AT,
  REWRITE_FIRM_AT,
  REWRITE_BLOCK_AT
};
