// Deterministic project diagnostics.
//
// Why this exists: the execute relay tells each model to "fix the errors in the
// project", but nothing in HAMA could detect an error. Verification checked only
// that files existed, were non-empty, and had balanced braces — so a project that
// does not compile could still be scored 95/100 PASS, and the retry loop would
// exit on it. "Fix all errors" was unachievable because no error was ever found.
//
// Everything here is deterministic and side-effect free: it reads the workspace
// and reports what is actually wrong. Findings are facts a repair pass can act on,
// not a model's opinion — which is what makes the relay cooperative instead of a
// series of independent rewrites.
//
// Nothing in here may throw. A chat must never fail because diagnostics did.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const toolsKit = require('../tools');
const bundler = require('../react_bundler');

const SOURCE_EXT = new Set(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs']);
const MARKUP_EXT = new Set(['.html', '.htm']);
const MAX_PARSE_BYTES = 512 * 1024;
const MAX_FINDINGS = 40;
const MAX_ORPHANS = 8;

const EMPTY = { ok: true, projectType: 'none', entry: null, findings: [], manifest: [], errors: 0, warnings: 0 };

// Packaged shims that are genuinely implemented, so importing them is fine and
// warning about it would be noise.
const SHIM_IS_REAL = new Set(['clsx', 'tailwind-merge', 'class-variance-authority', 'date-fns']);

// ---------------------------------------------------------------------------
// Workspace walking
// ---------------------------------------------------------------------------

/** Recursive manifest of a chat's workspace: [{ path, size, ext }]. */
function walkManifest(root) {
  const out = [];
  (function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (!e.isFile()) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      out.push({ path: r, size, ext: path.extname(e.name).toLowerCase() });
    }
  })(root, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readText(root, rel, cap = MAX_PARSE_BYTES) {
  try {
    const full = path.join(root, rel);
    if (fs.statSync(full).size > cap) return null;
    return fs.readFileSync(full, 'utf8');
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Import extraction & local resolution
//
// esbuild elides an unused import *before* resolving it, so a bundler-only check
// silently ignores dead imports that point at nothing. This scan is therefore not
// a redundant second opinion — it is the only thing that sees them.
// ---------------------------------------------------------------------------
function extractImports(source) {
  const specs = new Set();
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g, // import … from '…'
    /(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g,                             // import '…'
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                            // require('…')
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g                              // import('…')
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) specs.add(m[1]);
  }
  return [...specs];
}

// The extension list mirrors the bundler's resolver exactly. If these ever drift,
// diagnostics would report a clean project that the preview cannot build.
const RESOLVE_EXTS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs',
  '/index.tsx', '/index.ts', '/index.js', '/index.jsx'];

function resolvesToFile(base, root) {
  for (const ext of RESOLVE_EXTS) {
    const full = base + ext;
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return path.relative(root, full).split(path.sep).join('/');
      }
    } catch { /* ignore */ }
  }
  // A directory with an index file is already covered above; anything else is a miss.
  return null;
}

// The bundler resolves these through virtual shims *before* it ever looks for a
// real file, so their absence is normal and must never be reported as an error.
// Flagging them made every React project in the app diagnose as broken.
const SHIMMED_PREFIXES = ['@/components/ui/', '@/lib/'];

/**
 * @returns {null | string} null when the specifier resolves, else a message.
 */
function checkLocalSpec(spec, fromRel, root, srcDir) {
  if (SHIMMED_PREFIXES.some(p => spec.startsWith(p))) return null;

  let candidate = null;
  if (spec.startsWith('@/')) {
    candidate = path.join(srcDir, spec.slice(2));
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    candidate = path.resolve(root, path.dirname(fromRel), spec);
  } else {
    return null; // a bare package specifier — not a local file
  }
  return resolvesToFile(candidate, root) ? null : `Cannot resolve "${spec}" — no such file in the project`;
}

/**
 * Resolves a local specifier (`@/x`, `./x`, `../x`) to its workspace-relative
 * path, or null. Both forms must be handled: a project that aliases everything
 * through `@/` would otherwise look like it imports nothing at all.
 */
function resolveLocalSpec(spec, fromRel, root, srcDir) {
  if (SHIMMED_PREFIXES.some(p => spec.startsWith(p))) return null;
  if (spec.startsWith('@/')) return resolvesToFile(path.join(srcDir, spec.slice(2)), root);
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return resolvesToFile(path.resolve(root, path.dirname(fromRel), spec), root);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Duplicate implementations — the direct detector for "each model writes its own"
// ---------------------------------------------------------------------------

// `export default function X` — the identifier pattern below would otherwise
// capture the keyword "function" itself and report it as a duplicate in every
// file, drowning the real findings in noise.
const RESERVED_AFTER_DEFAULT = new Set([
  'function', 'class', 'async', 'const', 'let', 'var', 'new', 'await', 'this'
]);

/** Names this module exports as its default (or as a named component). */
function exportedNames(source) {
  const names = new Set();
  let m;
  const defFn = /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = defFn.exec(source)) !== null) names.add(m[1]);
  const defIdent = /export\s+default\s+([A-Za-z_$][\w$]*)/g;
  while ((m = defIdent.exec(source)) !== null) {
    if (!RESERVED_AFTER_DEFAULT.has(m[1])) names.add(m[1]);
  }
  const namedFn = /export\s+(?:async\s+)?function\s+([A-Z][\w$]*)/g;
  while ((m = namedFn.exec(source)) !== null) names.add(m[1]);
  return [...names];
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function staticChecks(root, manifest) {
  const findings = [];
  const htmlFiles = manifest.filter(f => MARKUP_EXT.has(f.ext));
  const srcFiles = manifest.filter(f => SOURCE_EXT.has(f.ext));

  // Empty source files: a file tool that wrote nothing, or a truncation.
  for (const f of srcFiles) {
    if (f.size === 0) {
      findings.push({
        severity: 'error', file: f.path, line: null, column: null, source: 'empty-file',
        message: 'File is empty (0 bytes) — it was created but never filled in.'
      });
    }
  }

  // index.html pointing at assets that are not in the project.
  for (const f of htmlFiles) {
    const html = readText(root, f.path, 256 * 1024);
    if (!html) continue;
    const refRe = /<(?:script|link|img)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = refRe.exec(html)) !== null) {
      const ref = m[1];
      if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('mailto:')) continue;
      const clean = ref.split('?')[0].split('#')[0];
      if (!clean) continue;
      const target = clean.startsWith('/')
        ? path.join(root, clean.slice(1))
        : path.resolve(root, path.dirname(f.path), clean);
      try {
        if (!fs.existsSync(target)) {
          findings.push({
            severity: 'error', file: f.path, line: null, column: null, source: 'missing-asset',
            message: `References "${ref}", which does not exist in the project.`
          });
        }
      } catch { /* ignore */ }
    }
  }

  // Duplicate exports across files — one model's component re-declared by another.
  const byName = new Map();
  for (const f of srcFiles) {
    const text = readText(root, f.path, 256 * 1024);
    if (!text) continue;
    for (const name of exportedNames(text)) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(f.path);
    }
  }
  for (const [name, files] of byName) {
    if (files.length < 2) continue;
    findings.push({
      severity: 'warning', file: files[0], line: null, column: null, source: 'duplicate-export',
      message: `"${name}" is declared in ${files.length} files (${files.join(', ')}) — one is almost certainly a duplicate implementation. Keep a single copy and delete the other.`
    });
  }

  return { findings, htmlFiles, srcFiles };
}

/**
 * Files that nothing imports. In a React project a component file with no
 * importer is dead code — usually the parallel copy a later model added instead
 * of editing the original.
 */
function orphanComponents(root, manifest, entryRel) {
  const srcFiles = manifest.filter(f => SOURCE_EXT.has(f.ext)
    && (f.ext === '.tsx' || f.ext === '.jsx')
    && f.path !== entryRel);
  if (srcFiles.length < 2) return [];

  const srcDir = fs.existsSync(path.join(root, 'src')) ? path.join(root, 'src') : root;
  const imported = new Set();
  for (const f of manifest.filter(x => SOURCE_EXT.has(x.ext))) {
    const text = readText(root, f.path, 256 * 1024);
    if (!text) continue;
    for (const spec of extractImports(text)) {
      const hit = resolveLocalSpec(spec, f.path, root, srcDir);
      if (hit) imported.add(hit);
    }
  }

  const orphans = [];
  for (const f of srcFiles) {
    if (imported.has(f.path)) continue;
    // A component referenced only from an index.html-free React tree is dead.
    orphans.push(f.path);
    if (orphans.length >= MAX_ORPHANS) break;
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// Compile pass — the real thing
// ---------------------------------------------------------------------------

function findingsFromEsbuildError(err, root) {
  const findings = [];
  const list = Array.isArray(err?.errors) ? err.errors : [];
  for (const e of list) {
    let file = null, line = null, column = null;
    if (e.location) {
      line = e.location.line ?? null;
      column = e.location.column ?? null;
      if (e.location.file) {
        const rel = path.relative(root, e.location.file);
        file = rel.startsWith('..') ? e.location.file : rel.split(path.sep).join('/');
      }
    }
    findings.push({
      severity: 'error', file, line, column, source: 'compile',
      message: String(e.text || 'Build error').replace(/\s+/g, ' ').trim()
    });
  }
  if (!findings.length) {
    findings.push({
      severity: 'error', file: null, line: null, column: null, source: 'compile',
      message: String(err?.message || 'The project failed to build.').split('\n')[0]
    });
  }
  return findings;
}

const LOADERS = { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.js': 'js', '.mjs': 'js', '.cjs': 'js' };

/** Parses one file for syntax errors only. Returns findings (never throws). */
async function syntaxCheckFile(root, entry, covered) {
  if (covered.has(entry.path)) return [];
  const text = readText(root, entry.path);
  if (text === null) return [];
  try {
    await esbuild.transform(text, { loader: LOADERS[entry.ext] || 'js' });
    return [];
  } catch (err) {
    // transform() reports its location against a synthetic filename, not the real
    // one, so the file is pinned here rather than read off the error.
    return findingsFromEsbuildError(err, root).map(x => ({ ...x, file: entry.path, source: 'parse' }));
  }
}

async function compileProject(root, manifest) {
  const findings = [];
  const shimmed = new Set();
  const sourceFiles = manifest.filter(x => SOURCE_EXT.has(x.ext));

  const files = manifest.map(f => f.path);
  const entryRel = bundler.findEntry(root, files);

  if (entryRel) {
    const srcDir = fs.existsSync(path.join(root, 'src')) ? path.join(root, 'src') : root;
    try {
      await bundler.bundleProject({
        entryPath: path.join(root, entryRel),
        srcDir,
        projectDir: root,
        onShimmed: (name, kind) => { if (kind === 'vendor') shimmed.add(name); }
      });
    } catch (err) {
      findings.push(...findingsFromEsbuildError(err, root));
    }
  }

  // Every source file gets a syntax check, not just the ones the bundler reached.
  // esbuild only parses what the entry point imports, so a file nothing imports
  // yet — exactly the state a model leaves behind mid-relay — would otherwise
  // carry a syntax error all the way to the preview before anyone noticed.
  const covered = new Set(findings.filter(f => f.file).map(f => f.file));
  for (const f of sourceFiles) {
    findings.push(...await syntaxCheckFile(root, f, covered));
  }

  // Packages that only resolve because the sandbox substitutes a stub. The build
  // succeeds, but the library is not really there.
  for (const name of shimmed) {
    if (SHIM_IS_REAL.has(name)) continue;
    findings.push({
      severity: 'warning', file: null, line: null, column: null, source: 'shimmed-package',
      message: `"${name}" is not available in the sandbox; a stub is substituted, so anything relying on it will not behave as written. Prefer built-in browser APIs or a plain implementation.`
    });
  }

  return { findings, entryRel };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspects a chat's workspace and reports what is factually wrong with it.
 * Never throws; on any internal failure it returns an empty, ok result so a chat
 * is never broken by diagnostics.
 *
 * @returns {Promise<{ok, projectType, entry, findings, manifest, errors, warnings}>}
 */
async function diagnose(chatId) {
  if (!chatId) return EMPTY;
  let root;
  try { root = toolsKit.safePath('', chatId); } catch { return EMPTY; }
  return diagnoseDir(root);
}

/** Same as diagnose(), against an explicit directory. Used by tests. */
async function diagnoseDir(root) {
  if (!root || !fs.existsSync(root)) return EMPTY;

  try {
    const manifest = walkManifest(root);
    if (!manifest.length) return EMPTY;

    const { findings: staticFindings } = staticChecks(root, manifest);
    const { findings: compileFindings, entryRel } = await compileProject(root, manifest);

    const findings = [...compileFindings, ...staticFindings];

    // The import scan runs last so it can skip anything the compiler already
    // reported, avoiding two findings for the same broken import.
    const alreadyReported = new Set(
      findings.filter(f => f.source === 'compile' && f.file)
        .map(f => f.file + '|' + f.message)
    );
    const srcDir = fs.existsSync(path.join(root, 'src')) ? path.join(root, 'src') : root;
    for (const f of manifest.filter(x => SOURCE_EXT.has(x.ext))) {
      if (f.size > MAX_PARSE_BYTES) continue;
      const text = readText(root, f.path);
      if (!text) continue;
      for (const spec of extractImports(text)) {
        const problem = checkLocalSpec(spec, f.path, root, srcDir);
        if (!problem) continue;
        // Skip if the compiler already flagged this same specifier in this file.
        const key = f.path + '|' + problem;
        const dup = [...alreadyReported].some(k => k.startsWith(f.path + '|') && k.includes(spec));
        if (dup) continue;
        findings.push({
          severity: 'error', file: f.path, line: null, column: null, source: 'unresolved-import',
          message: problem
        });
      }
    }

    if (entryRel) {
      for (const p of orphanComponents(root, manifest, entryRel)) {
        findings.push({
          severity: 'warning', file: p, line: null, column: null, source: 'orphan',
          message: 'Nothing in the project imports this file — it is dead code, most likely a duplicate of an existing component.'
        });
      }
    }

    const trimmed = findings.slice(0, MAX_FINDINGS);
    const errors = trimmed.filter(f => f.severity === 'error').length;
    const warnings = trimmed.filter(f => f.severity === 'warning').length;

    let projectType = 'script';
    if (entryRel) projectType = 'react';
    else if (manifest.some(f => MARKUP_EXT.has(f.ext))) projectType = 'web';

    return {
      ok: errors === 0,
      projectType,
      entry: entryRel,
      findings: trimmed,
      manifest: manifest.map(f => ({ path: f.path, size: f.size })),
      errors, warnings
    };
  } catch {
    return EMPTY;
  }
}

/** Formats one finding as an actionable line for a prompt. */
function formatFinding(f) {
  const where = f.file ? (f.line ? `${f.file}:${f.line}${f.column ? ':' + f.column : ''}` : f.file) : 'project';
  return `[${f.severity.toUpperCase()}] ${where} — ${f.message}`;
}

/**
 * The diagnostic block injected into execute and verify prompts.
 * Returns '' when there is nothing to report, so callers can test truthiness.
 */
function renderDiagnostics(diag) {
  if (!diag || !diag.findings.length) return '';
  const errors = diag.findings.filter(f => f.severity === 'error');
  const warnings = diag.findings.filter(f => f.severity === 'warning');

  const lines = [
    `## Deterministic Build Report (authoritative — produced by compiling the project, not by a model)`,
    `Project type: ${diag.projectType}${diag.entry ? ` (entry: ${diag.entry})` : ''}`,
    `Result: ${errors.length} error(s), ${warnings.length} warning(s).`
  ];
  if (errors.length) {
    lines.push('', '### ERRORS — these must all be fixed', ...errors.map(f => `- ${formatFinding(f)}`));
  }
  if (warnings.length) {
    lines.push('', '### WARNINGS', ...warnings.map(f => `- ${formatFinding(f)}`));
  }
  return lines.join('\n');
}

/** Renders the recursive file manifest, so a model can see the real structure. */
function renderManifest(diag, limit = 200) {
  if (!diag || !diag.manifest.length) return '';
  const rows = diag.manifest.slice(0, limit)
    .map(f => `- ${f.path} (${f.size} bytes)`);
  if (diag.manifest.length > limit) rows.push(`- … and ${diag.manifest.length - limit} more`);
  return ['## Files in the project (recursive)', ...rows].join('\n');
}

/**
 * The project's source, budgeted, for injection into a prompt.
 *
 * The relay used to hand each model the last 1500 characters of the previous
 * model's *prose* — never the code. That is the single biggest reason each model
 * produced its own fresh implementation instead of editing what existed.
 *
 * @param {object} diag     result of diagnose()
 * @param {string} chatId
 * @param {number} budget   max characters of file content to include
 */
function renderSources(diag, chatId, budget = 12000) {
  if (!diag || !diag.manifest.length) return '';
  let root;
  try { root = toolsKit.safePath('', chatId); } catch { return ''; }

  const TEXT_EXT = new Set([...SOURCE_EXT, ...MARKUP_EXT, '.css', '.json', '.md', '.txt', '.svg']);
  // Entry point first, then source files, then everything else — so a tight
  // budget is spent on the code that matters.
  const ordered = [...diag.manifest].sort((a, b) => {
    const rank = (p) => (diag.entry && p === diag.entry ? 0 : /\.(tsx|ts|jsx|js|html|css)$/.test(p) ? 1 : 2);
    return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
  });

  const parts = [];
  let used = 0;
  let omitted = 0;

  for (const f of ordered) {
    const ext = path.extname(f.path).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    const text = readText(root, f.path, MAX_PARSE_BYTES);
    if (text === null) { omitted++; continue; }

    const header = `\n### FILE: ${f.path}\n`;
    const room = budget - used - header.length;
    if (room <= 120) { omitted++; continue; }

    if (text.length <= room) {
      parts.push(header + text);
      used += header.length + text.length;
    } else {
      parts.push(header + text.slice(0, room) + `\n… [truncated — ${text.length - room} more characters in this file]`);
      used += budget;
      omitted++;
    }
  }

  if (!parts.length) return '';
  const lines = [
    '## Current source code (read this before changing anything)',
    'These are the real files on disk, written by the previous pass.'
  ];
  if (omitted) lines.push(`(${omitted} file(s) omitted or truncated for length — use read_file / list_files for the rest.)`);
  return lines.concat(parts).join('\n');
}

module.exports = {
  diagnose,
  diagnoseDir,
  renderDiagnostics,
  renderManifest,
  renderSources,
  formatFinding,
  walkManifest,
  extractImports
};
