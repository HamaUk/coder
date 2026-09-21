// How hard the agent is allowed to work on one turn.
//
// Everything is operator-tunable through `settings.agent`, so a long build can
// be given more room without a code change — and a metered key can be reined in.
//
// The ceilings are a runaway backstop, not a recommendation: they exist so a
// typo in settings.json cannot authorise an unbounded number of model calls.
const CEILING = {
  maxSteps: 400,            // tool-calling round trips in a single turn
  maxAutoContinues: 40      // times the agent is nudged to carry on after stopping early
};

const DEFAULTS = {
  // Was a hard-coded 8, which forced the agent to give up mid-project on
  // anything larger than a handful of files.
  maxSteps: 60,
  // Cursor/Antigravity-style persistence: if the agent stops while its own task
  // list still has open items, it is told to carry on instead of ending the turn.
  // Raised from 6: a multi-file build routinely wants a nudge per file, and
  // stopping at six left real work on the table. The turn still ends the moment
  // the list is clear, so a short job never pays for the higher ceiling.
  maxAutoContinues: 12
};

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Merges defaults ← settings.agent ← per-request override, then clamps.
 *
 * @param {object} [override] per-request budget (from the chat body)
 * @param {object} [settings] the app settings object
 * @returns {{ maxSteps: number, maxAutoContinues: number }}
 */
function resolveLimits(override, settings) {
  const cfg = { ...DEFAULTS, ...(settings?.agent || {}), ...(override || {}) };
  return {
    maxSteps: clampInt(cfg.maxSteps, 1, CEILING.maxSteps, DEFAULTS.maxSteps),
    maxAutoContinues: clampInt(cfg.maxAutoContinues, 0, CEILING.maxAutoContinues, DEFAULTS.maxAutoContinues)
  };
}

module.exports = { resolveLimits, DEFAULTS, CEILING };
