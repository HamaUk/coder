// Real command execution for the agent: a persistent PowerShell (or bash) child
// process the model can drive with `run_shell`.
//
// WHY A PERSISTENT PROCESS
// run_script (in tools.js) can already run a *file* the model wrote. What it
// cannot do is run one command — `npm install`, `git status`, `node --version`,
// `python -m pytest`, `ffmpeg -i in.mp4 out.mp3` — and it carries no state, so a
// two-step job ("cd into the folder", then "build it") is impossible: each call
// starts from the workspace root with a fresh environment. This module keeps one
// shell alive per HAMA process, so `Set-Location`, `$env:FOO = 'bar'`, `npm
// install` and a background server all survive into the next call.
//
// WHY THE MARKER PROTOCOL
// A child process whose stdin is a pipe has no console, so nothing prints a
// prompt and there is no exit status to read. Each command is therefore wrapped:
// emit a unique start nonce, run the model's command, then emit
// `<end nonce>:<exit code>`. stdout/stderr are merged into one byte stream (that
// is what a terminal does, and it is what keeps a compiler error and its output
// in the order the tool actually produced them), so the wrapper is the only
// frame the reader needs: everything between the nonces is the command's output
// and the digits after the end nonce are its exit code.
//
// The nonce is regenerated per command from `crypto.randomBytes`, so a command
// that deliberately prints a guessable marker cannot fabricate a completion.
//
// WHY A BOUNDED BUFFER
// One shell handling a build log would otherwise grow its capture buffer without
// limit for the life of the server. The reader keeps a sliding window
// (MAX_BUFFER) and counts the bytes it dropped from the front, so a huge output
// reports "[N earlier bytes dropped]" instead of silently losing its head — or
// its tail, which is where a failure usually says what went wrong.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Tuning — every one of these is a bound on something that can run away.
// ---------------------------------------------------------------------------

/** Default wall-clock limit for one command. A build can take a while; a hang must not. */
const DEFAULT_TIMEOUT_MS = 120000;
/** Hard cap a caller cannot raise, so a stuck command cannot own the server forever. */
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
/** Bytes of a command's output that ride back to the model. The rest is reported as dropped. */
const DEFAULT_MAX_OUTPUT_BYTES = 24000;
/** Bytes of raw output the session keeps before the front is trimmed away. */
const MAX_BUFFER_BYTES = 512 * 1024;
/** How long an untouched session is kept before its process is killed. */
const IDLE_TTL_MS = 15 * 60 * 1000;
/** How long to wait for the shell's own UTF-8 bootstrap before the first command goes out. */
const READY_TIMEOUT_MS = 15000;
/** How long a killed shell gets to die before it is abandoned. */
const KILL_GRACE_MS = 1500;
/** An echo of the command longer than this is not the echo — it is the command's own output. */
const ECHO_WINDOW_CHARS = 8192;
/** How much of the buffered output is searched for a completion frame. */
const SCAN_WINDOW_CHARS = 96 * 1024;

// ---------------------------------------------------------------------------
// Locating a shell
// ---------------------------------------------------------------------------

/** Cached resolution: the filesystem is probed once per process, not per command. */
let cachedShell = null;

function fileExists(target) {
  try { return fs.existsSync(target); } catch { return false; }
}

/**
 * Finds every `pwsh` on PATH without a shell of our own.
 *
 * `spawn('pwsh')` would work, but detecting *which* interpreter we got lets the
 * error message name it, and the Windows fallback has to be found the same way.
 */
function findOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = isWin
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        if (fileExists(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolves the shell used for every `run_shell` call in this process.
 *
 * Order is deliberate: PowerShell 7 when present (UTF-8 by default and the same
 * cross-platform syntax everywhere), then Windows PowerShell 5.1 (present on
 * every supported Windows, so the tool never simply "cannot run"), then bash on
 * POSIX. The result is memoized because the answer cannot change while the
 * server runs, and probing PATH on every call would be pure overhead.
 *
 * @returns {{kind: 'pwsh'|'powershell'|'bash'|'sh', file: string, label: string, args: string[],
 *            init: string[]|null, wrapper: (command: string, start: string, end: string) => string,
 *            recovery: string}|null}
 *   The resolved shell, or null when nothing usable exists.
 */
function resolveShell() {
  if (cachedShell) return cachedShell;

  // An explicit shell wins over detection. Two real reasons to want it: a host
  // where the shell is not on PATH under a name this file guesses, and a
  // container whose entry point is a different binary (`HAMA_SHELL=wsl.exe`
  // with HAMA_SHELL_ARGS="-e bash -s" is how the POSIX path is exercised on
  // Windows). The wrapper is chosen from the file name, so an override cannot
  // silently get the PowerShell framing on a POSIX shell.
  const override = String(process.env.HAMA_SHELL || '').trim();
  if (override) {
    const base = path.basename(override).toLowerCase().replace(/\.exe$/, '');
    const powershellish = base.includes('pwsh') || base.includes('powershell');
    const extra = String(process.env.HAMA_SHELL_ARGS || '').trim();
    const overrideArgs = extra
      ? extra.split(/\s+/).filter(Boolean)
      : (powershellish
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']
        : ['--norc', '--noprofile', '-s']);
    cachedShell = powershellish
      ? {
        kind: base.includes('pwsh') ? 'pwsh' : 'powershell',
        file: override,
        label: 'PowerShell (HAMA_SHELL)',
        args: overrideArgs,
        init: pwshInitLines(!base.includes('pwsh')),
        wrapper: powershellWrapper,
        recovery: override
      }
      : {
        kind: 'bash',
        file: override,
        label: (base || 'bash') + ' (HAMA_SHELL)',
        args: overrideArgs,
        init: null,
        wrapper: bashWrapper,
        recovery: override
      };
    return cachedShell;
  }

  if (isWin) {
    const pwsh = findOnPath(['pwsh']);
    if (pwsh) {
      cachedShell = {
        kind: 'pwsh',
        file: pwsh,
        label: 'PowerShell 7 (pwsh)',
        // The UTF-8 bootstrap is issued as its own script block before any
        // command runs, so a user's first command cannot race the encoding setup.
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        init: pwshInitLines(false),
        wrapper: powershellWrapper,
        recovery: pwsh
      };
      return cachedShell;
    }
    const system32 = path.join(String(process.env.SystemRoot || 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const legacy = fileExists(system32) ? system32 : findOnPath(['powershell']);
    if (legacy) {
      cachedShell = {
        kind: 'powershell',
        file: legacy,
        label: 'Windows PowerShell 5.1',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        init: pwshInitLines(true),
        wrapper: powershellWrapper,
        recovery: legacy
      };
      return cachedShell;
    }
  }

  const bash = findOnPath(['bash']) || (fileExists('/bin/bash') ? '/bin/bash' : null);
  if (bash) {
    cachedShell = {
      kind: 'bash',
      file: bash,
      label: 'bash',
      // `-s` is not cosmetic: it forces bash to read commands from stdin. Without
      // it, whether a non-interactive bash reads a piped stdin at all depends on
      // how it was launched — measured against a Linux bash through WSL, where
      // `bash --norc --noprofile` produced NO output for the first piped lines
      // while `bash -s` executed every one of them. A shell that silently ignores
      // its stdin turns every run_shell call into a timeout.
      args: ['--norc', '--noprofile', '-s'],
      init: null,
      wrapper: bashWrapper,
      recovery: bash
    };
    return cachedShell;
  }

  const sh = fileExists('/bin/sh') ? '/bin/sh' : findOnPath(['sh']);
  if (sh) {
    cachedShell = {
      kind: 'sh',
      file: sh,
      label: 'sh',
      // POSIX sh takes `-s` for the same reason bash does.
      args: ['-s'],
      init: null,
      wrapper: bashWrapper,
      recovery: sh
    };
    return cachedShell;
  }

  return null;
}

/**
 * The PowerShell bootstrap: make stdin UTF-8 and leave stdout alone.
 *
 * This is a measured decision, not a default. Windows PowerShell 5.1 has two
 * separate writers for a redirected stdout — the one it uses for its own
 * cmdlet output, and the .NET console writer — and forcing
 * `[Console]::OutputEncoding` to UTF-8 re-encodes *both*, which corrupts plain
 * `Write-Output 'ü'` into `├╝`. Measured on 5.1 (26100): with that line removed,
 * cmdlet output is correct UTF-8 on the wire; with it present, every cmdlet
 * result is double-encoded. So the console's output encoding is left exactly as
 * the host configured it and the one remaining gap — a native program that
 * prints UTF-8 bytes, which the shell then re-reads through the OEM code page —
 * is handled where it can actually be detected, by {@link repairOemMojibake}.
 *
 * `[Console]::InputEncoding` is still set, because stdin is ours alone: the
 * model's command text is UTF-8, and without this an em dash or a CJK path in a
 * command arrives at the shell already mangled.
 *
 * @param {boolean} legacy - true for Windows PowerShell 5.1, which needs
 *   `New-Object` instead of the `::new()` type accelerator.
 * @returns {string[]} one physical line per statement, fed to stdin in order.
 */
function pwshInitLines(legacy) {
  const utf8 = legacy ? 'New-Object System.Text.UTF8Encoding $false' : '[System.Text.UTF8Encoding]::new($false)';
  return [
    '$ProgressPreference = "SilentlyContinue"',
    'try { [Console]::InputEncoding = ' + utf8 + ' } catch { }',
    'try { $PSDefaultParameterValues["Out-File:Encoding"] = "utf8" } catch { }'
  ];
}

/**
 * Wraps a command so its output can be framed and its exit code recovered.
 *
 * `& { … }` is the whole trick: every statement inside one script block is one
 * physical input line, so the shell echoes exactly one line (the wrapper) and
 * never the model's command line by line — which is what makes the captured
 * slice between the nonces pure output. `$LASTEXITCODE` is set by native
 * commands (`git`, `node`, `npm`); for a cmdlet it stays null and `$?` decides,
 * which is why both are consulted in that order.
 *
 * @param {string} command - the model's command text.
 * @param {string} start - start nonce.
 * @param {string} end - end nonce (the exit code is appended to it).
 * @returns {string} the single-line wrapper to write to the shell's stdin.
 */
function powershellWrapper(command, start, end) {
  return 'Write-Output \'' + start + '\'\n'
    + '& { $global:LASTEXITCODE = $null'
    + '; $__hama_ok = $true'
    + '; try { ' + command + ' } catch { $__hama_ok = $false; Write-Output $_ }'
    + '; if ($null -ne $LASTEXITCODE) { $__hama_code = [int]$LASTEXITCODE }'
    + ' else { if ($__hama_ok) { $__hama_code = 0 } else { $__hama_code = 1 } }'
    + '; Write-Output (\'' + end + ':\' + $__hama_code) }';
}

/**
 * The POSIX equivalent of {@link powershellWrapper}.
 *
 * `{ … }` groups the statements in the *current* shell, so `cd` and variable
 * assignments keep working for the next call, which a `( … )` subshell would
 * silently discard.
 *
 * @param {string} command - the model's command text.
 * @param {string} start - start nonce.
 * @param {string} end - end nonce (the exit code is appended to it).
 * @returns {string} the wrapper to write to the shell's stdin.
 */
function bashWrapper(command, start, end) {
  return 'printf "%s\\n" ' + start + '\n'
    + '{ ' + command + '\n'
    + '}\n'
    + '__hama_code=$?\n'
    + 'printf "%s%s\\n" ' + end + ' "$__hama_code"';
}

/** A nonce no command can print by accident: name + 16 hex bytes of CSPRNG. */
function nonce(tag) {
  return '__HAMA_' + tag + '_' + crypto.randomBytes(16).toString('hex') + '__';
}

// ---------------------------------------------------------------------------
// Recovering UTF-8 that travelled through the OEM code page
// ---------------------------------------------------------------------------

/**
 * The high half of code page 437, indexed from byte 0x80.
 *
 * CP437 is what a Windows PowerShell 5.1 host uses to read the output of a
 * native program when its stdout is redirected: the program's UTF-8 bytes are
 * reinterpreted as CP437 characters and the resulting string is what reaches
 * this reader. The table therefore serves one purpose — inverting that
 * reinterpretation — and it is written out in full rather than derived from a
 * package, because Node's `TextDecoder` cannot decode CP437 and the mapping is
 * frozen: it has not changed since 1981 and PowerShell 5.1 always uses it.
 */
const CP437_HIGH = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7,
  0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9,
  0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba,
  0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f,
  0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b,
  0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4,
  0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248,
  0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0
];

/**
 * CP437 character → the byte it decodes from, for the whole high half.
 *
 * The full range is needed, not just the trailing-byte window: UTF-8's lead
 * bytes (0xC2–0xF4) map to CP437's accented letters and Greek capitals, and a
 * repair that knew only 0xC0–0xFF would fail to rebuild the very sequences it
 * exists to rebuild. Colliding characters are dropped so the inverse stays a
 * function.
 *
 * @type {Map<number, number>}
 */
const CP437_TO_BYTE = (() => {
  const table = new Map();
  const ambiguous = new Set();
  for (let byte = 0x80; byte <= 0xff; byte++) {
    const ch = CP437_HIGH[byte - 0x80];
    if (ch === undefined) continue;
    if (table.has(ch)) ambiguous.add(ch);
    else table.set(ch, byte);
  }
  for (const ch of ambiguous) table.delete(ch);
  return table;
})();

/**
 * The characters a repair is allowed to act on.
 *
 * `box` is the airtight signal: CP437's box-drawing and block glyphs
 * (U+2500–U+25FF) are not something `npm`, `git` or a compiler prints, so one
 * of them in the capture means the bytes underneath came through the OEM code
 * page. `strong` widens that to the whole CP437 high half, because a line whose
 * mojibake happens to consist of only accented letters (`ΓÇö` for an em dash)
 * carries no box glyph at all — and requires TWO of those, which ordinary prose
 * almost never produces while every mangled sequence of two or more bytes does.
 */
const OEM_BOX_SIGNATURE = (() => {
  const set = new Set();
  for (const ch of CP437_TO_BYTE.keys()) {
    if (ch >= 0x2500 && ch <= 0x25ff) set.add(ch);
  }
  return set;
})();
/** Every CP437 high-half character, used only to count how strong the signal is. */
const OEM_STRONG = new Set(CP437_TO_BYTE.keys());

/**
 * True when a line carries enough of an OEM-code-page fingerprint to repair.
 *
 * The test is what keeps ordinary output safe: ASCII costs one scan, a line with
 * a single accented letter is left alone, and only a box glyph or two independent
 * CP437 characters — which is what a mangled multi-byte UTF-8 sequence always
 * produces — opens the line to a repair that then still has to decode as strict
 * UTF-8.
 *
 * @param {string} text - a line to test.
 * @returns {boolean} whether the repair is worth attempting.
 */
function hasOemSignature(text) {
  let strong = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (OEM_BOX_SIGNATURE.has(code)) return true;
    if (OEM_STRONG.has(code) && ++strong >= 2) return true;
  }
  return false;
}

/**
 * Repairs a line whose bytes are UTF-8 that a Windows PowerShell host decoded
 * through the console's OEM code page.
 *
 * A native program (`node`, `git`, `python`, `npm`) prints UTF-8. When the host
 * reading that output writes it back through CP437, `—` arrives as `ÔÇö`, `日本`
 * as `µùÑµ£¼`, and `café` as `caf├⌐`. The inverse is exact: map every character
 * back to the CP437 byte it decoded from and read those bytes as UTF-8 again.
 *
 * This is a safety net, not the normal path. A host whose console is already
 * UTF-8 (any PowerShell 7, or `chcp 65001`) delivers correct text, which has no
 * signature character and is returned untouched. Failure is always safe:
 * anything that does not decode as strict UTF-8 is returned exactly as it came
 * in.
 *
 * @param {string} line - one decoded line of shell output.
 * @returns {string} the repaired line, or the original when repair does not apply.
 */
function repairOemMojibake(line) {
  const text = String(line);
  if (!hasOemSignature(text)) return text;

  const bytes = Buffer.allocUnsafe(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const mapped = CP437_TO_BYTE.get(code);
    if (mapped !== undefined) bytes[i] = mapped;
    else if (code < 0x100) bytes[i] = code;
    else return text; // a character outside the code page: not this corruption
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return text; // not valid UTF-8: the original reading was the right one
  }
}

/**
 * Applies {@link repairOemMojibake} to every line of a captured result.
 *
 * Only ever applied to Windows PowerShell output: PowerShell 7 and every POSIX
 * shell write UTF-8 on the wire directly, where this pass could only do harm.
 *
 * @param {string} text - the captured output.
 * @param {string} kind - the resolved shell kind.
 * @returns {string} the repaired output.
 */
function repairCapturedOutput(text, kind) {
  if (kind !== 'powershell' || text.indexOf('\n') === -1 && !hasOemSignature(text)) return text;
  if (!hasOemSignature(text)) return text;
  return text.split('\n').map(repairOemMojibake).join('\n');
}

/** True when writing this string to a shell's stdin is safe at all. */
/** True when writing this string to a shell's stdin is safe at all. */
function assertSendable(text, what) {
  const value = String(text == null ? '' : text);
  if (value.indexOf('\u0000') !== -1) throw new Error(what + ' contains a NUL byte and cannot be sent to a shell.');
  if (value.length > 200000) throw new Error(what + ' is longer than 200000 characters.');
  return value;
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

/**
 * Kills a process and everything it started.
 *
 * `child.kill()` signals only the direct child, so a shell that launched
 * `npm install` (which launched node) leaves the grandchildren running after a
 * timeout. Windows has no process groups, so `taskkill /T /F` is the only
 * reliable tree kill; POSIX uses the group the detached child was placed in.
 *
 * @param {import('child_process').ChildProcess} child - the shell process.
 * @param {boolean} [force] - true to also kill the whole tree synchronously.
 */
function killTree(child, force = false) {
  if (!child || !child.pid) return;
  try {
    if (isWin) {
      const args = ['/pid', String(child.pid), '/T'];
      if (force) args.push('/F');
      const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { /* best effort */ });
      killer.unref();
    } else {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already gone */ }
  }
}

/**
 * The environment a shell session runs with.
 *
 * HAMA's own workspace override is inherited deliberately: a shell command that
 * runs `node server.js` should see the same tree the file tools write into.
 * `TERM=dumb` matters on POSIX — without it, tools that detect a terminal start
 * emitting colour and cursor-control escapes into a pipe that has neither.
 *
 * @returns {NodeJS.ProcessEnv} the child environment.
 */
function childEnv() {
  const env = { ...process.env };
  if (!isWin) {
    env.TERM = 'dumb';
    env.NO_COLOR = '1';
  }
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';
  return env;
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * One long-lived shell process plus the buffer that frames its output.
 *
 * Not exported for direct use: callers go through {@link runShell}, which owns
 * creation, reuse and teardown so there is exactly one place that can spawn a
 * shell.
 */
class ShellSession {
  /**
   * @param {object} options - session identity.
   * @param {string} options.key - chat (or scratch) key this session belongs to.
   * @param {string} options.cwd - directory the shell starts in.
   */
  constructor({ key, cwd }) {
    const shell = resolveShell();
    if (!shell) throw new Error('no usable shell found: install PowerShell 7 (pwsh), or bash on this system.');

    this.key = key;
    this.shell = shell;
    this.cwd = cwd;
    this.text = '';
    this.droppedHead = 0;
    this.seq = 0;
    this.dead = false;
    this.exit = null;
    this.lastUsed = Date.now();
    this.waiters = new Set();

    this._decoder = new StringDecoder('utf8');
    this._spawn();
  }

  /** Starts the process and wires every stream. */
  _spawn() {
    const options = {
      cwd: this.cwd,
      env: childEnv(),
      windowsHide: true,
      // A POSIX group is what makes a tree kill possible; Windows cannot do it
      // and uses taskkill instead.
      detached: !isWin,
      stdio: ['pipe', 'pipe', 'pipe']
    };

    this.child = spawn(this.shell.file, this.shell.args, options);

    // `stdio: 'pipe'` means every one of these streams can emit 'error'
    // asynchronously (EPIPE when the shell dies mid-write). An unhandled 'error'
    // on a stream is an uncaught exception that takes the whole server down.
    const swallow = () => { /* the exit/close handlers own the fallout */ };
    this.child.stdin.on('error', swallow);
    this.child.stdout.on('error', swallow);
    this.child.stderr.on('error', swallow);
    this.child.on('error', (err) => this._settle({ code: null, signal: null, error: err.message }));
    this.child.on('exit', (code, signal) => this._settle({ code, signal, error: null }));

    this.child.stdout.on('data', (chunk) => this._feed(chunk));
    this.child.stderr.on('data', (chunk) => this._feed(chunk));
    this.child.stdin.write(''); // make the pipe real on platforms that defer it

    if (Array.isArray(this.shell.init) && this.shell.init.length) {
      this.ready = this._bootstrap();
    } else {
      // bash --norc is interactive already: nothing to set up before use.
      this.ready = Promise.resolve();
    }
  }

  /**
   * Sends the UTF-8 bootstrap and waits for it to be echoed back.
   *
   * A fixed sleep would be a race: on a cold Windows PowerShell 5.1 start the
   * first lines can take longer than any sleep worth baking in. Instead the last
   * bootstrap line carries a sentinel, and "ready" means the sentinel came back.
   */
  async _bootstrap() {
    const done = nonce('READY');
    const lines = this.shell.init.concat(["Write-Output '" + done + "'"]);
    this._write(lines.join('\n') + '\n');
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.dead) throw new Error('the shell exited while starting: ' + (this.exit?.error || 'exit code ' + this.exit?.code));
      if (this.text.indexOf(done) !== -1) {
        // Everything before this point is bootstrap chatter (banner, encoding
        // errors we deliberately swallowed), not a command's answer.
        this.text = '';
        this.droppedHead = 0;
        return;
      }
      await this._wait(60);
    }
    throw new Error('the shell did not finish starting within ' + Math.round(READY_TIMEOUT_MS / 1000) + 's.');
  }

  /**
   * Appends raw bytes and trims the buffer from the front when it grows past
   * {@link MAX_BUFFER_BYTES}.
   *
   * Half of the cap is the window, so the trimming is amortized: one slice per
   * half-buffer of output rather than one per chunk.
   */
  _feed(chunk) {
    this.text += this._decoder.write(chunk);
    if (this.text.length > MAX_BUFFER_BYTES) {
      const cut = this.text.length - Math.floor(MAX_BUFFER_BYTES / 2);
      this.text = this.text.slice(cut);
      this.droppedHead += cut;
    }
    this._notify();
  }

  /** Marks the session dead exactly once and releases every waiter. */
  _settle(info) {
    if (this.dead) return;
    this.dead = true;
    this.exit = info;
    this._notify();
  }

  _notify() {
    for (const waiter of [...this.waiters]) waiter();
  }

  /** Resolves after `ms`, or immediately when the session dies. Never rejects. */
  _wait(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(finish);
    });
  }

  /** Writes one line to the shell, classifying a dead pipe as a dead session. */
  _write(line) {
    try {
      this.child.stdin.write(line);
      return true;
    } catch (err) {
      this._settle({ code: null, signal: null, error: err.message });
      return false;
    }
  }

  /**
   * Finds the completion frame for a command.
   *
   * The scan is bounded to the tail of the buffer: a command's completion is by
   * definition the newest thing in the stream, so searching megabytes of earlier
   * output on every polling tick would be work with no possible answer.
   */
  _scan(marker, from) {
    const window = Math.max(0, this.text.length - SCAN_WINDOW_CHARS, from);
    const head = this.text.slice(window);
    const endAt = head.lastIndexOf(marker.end);
    if (endAt === -1) return null;
    const statusMatch = /^:(-?\d+)/.exec(head.slice(endAt + marker.end.length));
    if (!statusMatch) return null; // the tail is still arriving
    const startAt = head.lastIndexOf(marker.start);
    return {
      startAt: startAt === -1 ? window : window + startAt + marker.start.length,
      endAt: window + endAt,
      exitCode: Number(statusMatch[1])
    };
  }

  /**
   * Runs one command and resolves with its framed result.
   *
   * @param {object} request - the command to run.
   * @param {string} request.command - shell text from the model.
   * @param {number} [request.timeoutMs] - wall-clock limit for this command.
   * @param {number} [request.maxBytes] - how much output rides back inline.
   * @param {AbortSignal} [request.signal] - the turn's abort signal.
   * @returns {Promise<{ok: boolean, exitCode: number|null, output: string, stdout: string,
   *   stderr: string, timedOut: boolean, aborted: boolean, truncated: boolean, droppedBytes: number,
   *   durationMs: number, shell: string, killed: boolean}>}
   */
  async run({ command, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_OUTPUT_BYTES, signal } = {}) {
    const body = assertSendable(command, 'the command').trim();
    if (!body) throw new Error('command must be a non-empty string');

    const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const budget = Math.max(Number(maxBytes) || DEFAULT_MAX_OUTPUT_BYTES, 1000);

    await this.ready;
    this.lastUsed = Date.now();

    const marker = { start: nonce('START'), end: nonce('END') };
    const script = this.shell.wrapper(body, marker.start, marker.end);

    // Everything already buffered is irrelevant to this command. The cursor is
    // taken now so an immediate answer cannot be confused with leftover output.
    const cursor = this.text.length;
    const started = Date.now();

    // Windows PowerShell echoes every submitted line to stdout but writes no
    // error record for it (verified against 5.1: a valid multi-line submission
    // echoes each line but appends nothing). Only the echo text needs removing,
    // and it is recorded before the write so a capture that happens mid-echo
    // still knows what to strip.
    this.echoLine = script;
    this.echoRecord = null;

    this._write(script + '\n');

    // The START nonce is the anchor: it is emitted before the command's own
    // first write, so the answer is everything after the LAST START nonce. When
    // the shell echoed the wrapper (the whole `& { … }` body sits on the echo
    // line, START included) the real line has already landed by then, so
    // `lastIndexOf` picks the real one. An echoed END nonce carries no status
    // digits, so it cannot fabricate a completion even before the echo passes.
    const anchor = { start: marker.start, end: marker.end };

    let timeoutHandle = null;
    const timed = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), limit);
    });
    const aborted = new Promise((resolve) => {
      if (!signal) return; // no signal: this promise never settles, which is correct
      if (signal.aborted) return resolve({ kind: 'abort' });
      const onAbort = () => resolve({ kind: 'abort' });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const completed = (async () => {
      for (;;) {
        if (this.dead) return { kind: 'dead' };
        const found = this._scan(anchor, cursor);
        if (found) return { kind: 'done', found };
        await this._wait(25);
      }
    })();

    let outcome;
    try {
      outcome = await Promise.race([completed, timed, aborted]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    const durationMs = Date.now() - started;

    if (outcome.kind === 'timeout' || outcome.kind === 'abort') {
      // Neither the command nor the shell is trustworthy after this: the shell
      // may be mid-statement with a half-read pipeline. It is killed and the
      // next call gets a fresh one, which the result says plainly.
      const partial = this._capture(marker, cursor);
      this.kill('the command ' + (outcome.kind === 'timeout' ? 'timed out' : 'was interrupted'));
      const label = outcome.kind === 'timeout'
        ? 'Command timed out after ' + Math.round(limit / 1000) + 's'
        : 'Command interrupted';
      const rendered = this._render(partial, budget, 'partial output');
      return {
        ok: false,
        exitCode: null,
        output: label + '. The shell was reset — the next call starts a fresh session.\n\n' + rendered.text,
        stdout: partial.text,
        stderr: '',
        timedOut: outcome.kind === 'timeout',
        aborted: outcome.kind === 'abort',
        truncated: rendered.truncated,
        droppedBytes: partial.dropped,
        durationMs,
        shell: this.shell.label,
        killed: true
      };
    }

    if (outcome.kind === 'dead') {
      const partial = this._capture(marker, cursor);
      const why = this.exit?.error
        ? this.exit.error
        : this.exit?.signal ? 'killed by signal ' + this.exit.signal : 'exited with code ' + this.exit?.code;
      const rendered = this._render(partial, budget, 'partial output');
      return {
        ok: false,
        exitCode: this.exit?.code ?? null,
        output: 'The shell ' + why + ' before this command finished. It will be restarted on the next call.\n\n' + rendered.text,
        stdout: partial.text,
        stderr: '',
        timedOut: false,
        aborted: false,
        truncated: rendered.truncated,
        droppedBytes: partial.dropped,
        durationMs,
        shell: this.shell.label,
        killed: true
      };
    }

    const captured = this._capture(marker, cursor, outcome.found);
    const exitCode = captured.exitCode;
    const rendered = this._render(captured, budget, 'output');
    return {
      ok: exitCode === 0,
      exitCode,
      output: '[exit code: ' + (exitCode === null ? '?' : exitCode) + ' · ' + durationMs + 'ms]\n\n' + rendered.text,
      stdout: captured.text,
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: rendered.truncated,
      droppedBytes: captured.dropped,
      durationMs,
      shell: this.shell.label,
      killed: false
    };
  }

  /**
   * Extracts one command's output from the buffer.
   *
   * @param {object} marker - the nonces for this command.
   * @param {number} cursor - buffer length before the command was written.
   * @param {object} [found] - the frame {@link _scan} located, when it already has one.
   * @returns {{text: string, exitCode: number|null, truncated: boolean, dropped: number}}
   */
  _capture(marker, cursor, found) {
    const frame = found || this._scan(marker, cursor) || null;
    const startAt = frame && frame.startAt >= cursor ? frame.startAt : cursor;
    const endAt = frame ? frame.endAt : this.text.length;
    let text = this.text.slice(startAt, endAt);

    // Windows PowerShell echoes each submitted line to stdout and appends the
    // error record it writes for a line that does not parse. Either copy can
    // reach this slice when the echo lands after the anchor was taken, so both
    // are removed here — never generically, only the exact strings this command
    // produced, so a command's own output is untouched.
    if (this.echoLine) text = text.split(this.echoLine).join('');
    if (this.echoRecord) text = text.split(this.echoRecord).join('');
    // Terminal control sequences would render as `[32m` noise in the transcript
    // and cost tokens in the model's context.
    text = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
    text = repairCapturedOutput(text, this.shell.kind);
    text = text.replace(/^\r?\n/, '').replace(/\s+$/, '');

    // Bytes trimmed from the front of the buffer before this command's start.
    const dropped = Math.max(0, this.droppedHead - cursor);
    return {
      text,
      exitCode: frame ? frame.exitCode : null,
      truncated: dropped > 0,
      dropped
    };
  }

  /**
   * Bounds a captured result for the model: head and tail inline, an exact count
   * of what was omitted.
   *
   * The byte budget covers EVERYTHING this returns — body, the omission marker
   * and the notes — because that whole string is what the caller puts in the
   * model's context. A renderer that bounded only the body would report a
   * budget it did not keep.
   *
   * @param {object} captured - from {@link _capture}.
   * @param {number} budget - maximum bytes for the rendered result.
   * @param {string} what - what to say when there is no output at all.
   * @returns {{text: string, truncated: boolean}} the rendered result and whether it was cut.
   */
  _render(captured, budget, what) {
    const notes = [];
    if (captured.dropped > 0) notes.push('[' + captured.dropped + ' earlier characters dropped — the shell buffer is bounded]');
    const body = captured.text || '(' + what + ': none)';
    const bytes = Buffer.byteLength(body, 'utf8');

    // Everything except the body must fit first: if it does not, the budget is
    // too small to say anything useful and the smallest honest answer wins.
    const overhead = Buffer.byteLength(notes.join('\n\n'), 'utf8');
    if (overhead >= budget) {
      const text = notes.join('\n');
      return { text: text.slice(0, budget), truncated: true };
    }
    const bodyBudget = budget - overhead;

    if (bytes <= bodyBudget) {
      return { text: notes.length ? body + '\n\n' + notes.join('\n') : body, truncated: captured.dropped > 0 };
    }

    const markerFor = (omitted) =>
      '\n…[' + bytes + ' bytes total — ' + Math.max(0, omitted) + ' bytes of the middle omitted]\n';
    // The marker quotes the omitted count, so its own size depends on the
    // number; one recomputation after measuring is enough for any real size.
    const marker = markerFor(bytes);
    const markerBytes = Buffer.byteLength(marker, 'utf8');
    const room = Math.max(2, bodyBudget - markerBytes);
    const headBytes = Math.floor(room * 0.6);
    const tailBytes = room - headBytes;
    const omitted = Math.max(0, bytes - headBytes - tailBytes);
    const finalMarker = markerFor(omitted);
    const shown = body.slice(0, headBytes) + finalMarker + body.slice(-tailBytes);
    notes.push('Output was truncated to its head and tail (' + bytes + ' bytes). Redirect to a file and read it in windows if you need all of it.');
    return { text: shown + '\n\n' + notes.join('\n'), truncated: true };
  }

  /** Kills the shell and its tree. Idempotent. */
  kill(reason) {
    if (this.dead && !this.child) return;
    killTree(this.child, false);
    // A shell that ignores SIGTERM (or a Windows tree still tearing down) is
    // forced after the grace period, and the session stops waiting either way.
    setTimeout(() => killTree(this.child, true), KILL_GRACE_MS).unref?.();
    this._settle({ code: null, signal: 'SIGTERM', error: reason || null });
  }

  /** True when this session has been idle past its TTL. */
  isIdle(now = Date.now()) {
    return now - this.lastUsed > IDLE_TTL_MS;
  }
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

/** Live sessions, keyed by chat id (or `__scratch__` when there is none). */
const sessions = new Map();
/** Sweep handle, started lazily so importing this module never starts a timer. */
let sweeper = null;
/** Guard so process-exit cleanup is installed exactly once. */
let exitHookInstalled = false;

function keyFor(chatId) {
  return chatId ? String(chatId) : '__scratch__';
}

/** The workspace directory a session for this chat should start in. */
function cwdFor(chatId) {
  if (chatId) {
    try {
      const dir = require('./store').getChatWorkspaceDir(chatId);
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
    } catch { /* fall through to the process-wide workspace */ }
  }
  try {
    const store = require('./store');
    fs.mkdirSync(store.WORKSPACE_DIR, { recursive: true });
    return store.WORKSPACE_DIR;
  } catch { /* last resort */ }
  return process.cwd();
}

/** Kills idle sessions. Cheap enough to run on a minute timer. */
function sweep() {
  const now = Date.now();
  for (const [key, session] of [...sessions]) {
    if (session.isIdle(now)) {
      session.kill('idle timeout');
      sessions.delete(key);
    }
  }
}

function ensureSweeper() {
  if (sweeper || sessions.size === 0) return;
  sweeper = setInterval(sweep, 60000);
  sweeper.unref?.();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // A shell is a child this process owns: leaving it behind on shutdown leaks
    // a console window on Windows and a process on POSIX.
    process.once('exit', () => { for (const s of sessions.values()) s.kill('server exit'); });
  }
}

/**
 * Returns the live session for a chat, creating it on first use.
 * @param {string|null} chatId - the conversation the shell belongs to.
 * @returns {ShellSession} the reusable session.
 */
function sessionFor(chatId) {
  const key = keyFor(chatId);
  let session = sessions.get(key);
  if (session && !session.dead) return session;
  if (session) sessions.delete(key);
  session = new ShellSession({ key, cwd: cwdFor(chatId) });
  sessions.set(key, session);
  ensureSweeper();
  return session;
}

/**
 * Runs one command in the chat's persistent shell.
 *
 * A command that kills its shell (or times one out) is retried exactly once on a
 * fresh session — but only a command that never produced output, so a replay can
 * never double-apply a side effect the first attempt already performed.
 *
 * @param {object} request - the command.
 * @param {string} request.command - shell text.
 * @param {string|null} [request.chatId] - owning conversation.
 * @param {number} [request.timeoutMs] - per-command wall clock.
 * @param {number} [request.maxBytes] - inline output budget.
 * @param {AbortSignal} [request.signal] - the turn's abort signal.
 * @returns {Promise<object>} the result described on {@link ShellSession#run}.
 */
async function runShell({ command, chatId = null, timeoutMs, maxBytes, signal } = {}) {
  const first = await sessionFor(chatId).run({ command, timeoutMs, maxBytes, signal });
  if (first.killed || first.dead) {
    sessions.delete(keyFor(chatId));
    if (!first.stdout && !first.timedOut && !first.aborted && !signal?.aborted) {
      const retry = await sessionFor(chatId).run({ command, timeoutMs, maxBytes, signal });
      retry.output = 'The shell had to be restarted before running this command.\n\n' + retry.output;
      return retry;
    }
  }
  return first;
}

/**
 * Kills a chat's shell session, so the next `run_shell` starts clean.
 * @param {string|null} chatId - owning conversation.
 * @returns {object} whether a live session existed and was killed.
 */
function resetShell(chatId) {
  const key = keyFor(chatId);
  const session = sessions.get(key);
  if (!session) return { killed: false };
  sessions.delete(key);
  session.kill('reset requested');
  return { killed: true };
}

/** Kills every session. Exposed for tests and for an orderly server shutdown. */
function killAll() {
  const count = sessions.size;
  for (const session of sessions.values()) session.kill('server shutdown');
  sessions.clear();
  return { killed: count };
}

/** Describes the shell this process would use, without starting one. */
function shellInfo() {
  const shell = resolveShell();
  if (!shell) return { available: false, label: 'none', file: null, kind: null };
  return { available: true, label: shell.label, file: shell.file, kind: shell.kind };
}

module.exports = {
  runShell,
  resetShell,
  killAll,
  shellInfo,
  resolveShell,
  killTree,
  assertSendable,
  repairOemMojibake,
  repairCapturedOutput,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_BUFFER_BYTES,
  IDLE_TTL_MS
};
