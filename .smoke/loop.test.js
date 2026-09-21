// Focused test for the "work the job through to the end" behaviour: the loop
// must not treat "the model stopped talking" as "the job is done" while the
// model's own task list still has open items.
//
// The provider is stubbed by patching dispatch before loop.js loads (loop.js
// destructures streamBodyHandler at require time, so the patch has to land
// first).
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

// Point the stores at the scratch dir BEFORE anything requires src/store, so a
// stray `npm test` can never touch the real data/ or workspace/.
process.env.HAMA_DATA_DIR = path.join(__dirname, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(__dirname, 'workspace');
for (const d of [process.env.HAMA_DATA_DIR, process.env.HAMA_WORKSPACE_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const dispatch = require(path.join(ROOT, 'src', 'middleware', 'dispatch'));

let call = 0;
const script = [
  // 1: start the job — plan three tasks, mark the first in progress
  { text: 'Starting. ', toolCalls: [{ id: 'c1', name: 'update_todos', args: { todos: [
      { text: 'scaffold the project', status: 'in_progress' },
      { text: 'write the styles', status: 'pending' },
      { text: 'wire up the app', status: 'pending' }] } }] },
  // 2: verify the first task, still two open
  { text: 'Scaffold done. ', toolCalls: [{ id: 'c2', name: 'update_todos', args: { todos: [
      { text: 'scaffold the project', status: 'completed' },
      { text: 'write the styles', status: 'in_progress' },
      { text: 'wire up the app', status: 'pending' }] } }] },
  // 3: model stops talking here — but two items are still open, so the loop
  //    must nudge it back to work rather than accept the turn as finished
  { text: 'That looks like a good stopping point.' },
  // 4: nudged — finishes the styling
  { text: 'Styling done. ', toolCalls: [{ id: 'c4', name: 'update_todos', args: { todos: [
      { text: 'scaffold the project', status: 'completed' },
      { text: 'write the styles', status: 'completed' },
      { text: 'wire up the app', status: 'in_progress' }] } }] },
  // 5: stops again — still one open, loop nudges again
  { text: 'Nearly there.' },
  // 6: closes it out
  { text: 'App wired up. ', toolCalls: [{ id: 'c6', name: 'update_todos', args: { todos: [
      { text: 'scaffold the project', status: 'completed' },
      { text: 'write the styles', status: 'completed' },
      { text: 'wire up the app', status: 'completed' }] } }] },
  // 7: genuinely done — empty list, model finishes for real
  { text: 'All three tasks are complete.' }
];

let capMode = false;
let abortMode = false;
dispatch.generateChatCompletion = async (provider, formData, ctx) => {
  if (abortMode) {
    // Stream half an answer, do one tool call, then get stopped.
    const n = call++;
    if (n === 0) {
      ctx.onToken?.('Here is half an answer');
      return { text: 'Here is half an answer', toolCalls: [{ id: 'a1', name: 'list_files', args: {} }] };
    }
    ctx.onToken?.(' and the rest');
    const e = new Error('Aborted');
    e.name = 'AbortError';
    throw e;
  }
  if (capMode) {
    // Never stops asking for tools — the only way out is the iteration cap.
    ctx.onToken?.('tick ');
    return { text: 'tick ', toolCalls: [{ id: 'k' + call++, name: 'list_files', args: {} }] };
  }
  const step = script[call++] || { text: '(out of script)' };
  if (step.text) ctx.onToken?.(step.text);
  return { text: step.text || '', toolCalls: step.toolCalls || [] };
};

const { runToolLoop, makeThinkingStripper } = require(path.join(ROOT, 'src', 'middleware', 'loop'));
const todo = require(path.join(ROOT, 'src', 'middleware', 'todo'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// The scripted model drives the auto-continue behaviour through `update_todos`,
// so that tool has to be in the offered set — the loop refuses a tool the
// conversation never offered, and an empty list here would be a contradiction
// rather than a shortcut.
const OFFERED = [{ name: 'update_todos' }];

(async () => {
  const events = [];
  const history = [];
  const res = await runToolLoop({
    provider: { id: 'stub', model: 'stub', type: 'stub' },
    formData: { model: 'stub', messages: history, tools: OFFERED, temperature: 0.7 },
    metadata: { system: '', chatId: 'test-continue' },
    emit: (type, payload) => events.push({ type, ...payload }),
    tokenEvent: 'token',
    separatorOnToolCall: false,
    maxIterations: 60,
    maxAutoContinues: 6,
    todoKey: 'test-continue'
  });

  check('ran to natural completion', res.exhausted === false, 'exhausted=' + res.exhausted);
  check('did not stop at the first pause', res.continues >= 2, res.continues + ' auto-continue(s)');
  check('used the full script', call === script.length, call + '/' + script.length + ' model calls');
  check('every narration line survived in `text`',
    res.text.includes('Starting.') && res.text.includes('Scaffold done.') &&
    res.text.includes('That looks like a good stopping point.') &&
    res.text.includes('Styling done.') && res.text.includes('All three tasks are complete.'),
    JSON.stringify(res.text.slice(0, 70)));
  check('tool runs recorded', res.toolRuns.length === 4, res.toolRuns.map(r => r.name).join(','));
  check('continuation was announced to the user',
    events.some(e => e.type === 'status' && /to go — continuing/.test(e.text || '')),
    (events.find(e => e.type === 'status') || {}).text);
  check('task list released at the end', todo.renderOpen('test-continue') === '');

  // Role alternation: Anthropic and Gemini reject two same-role turns in a row,
  // and the auto-continue nudge is exactly the place that would introduce one.
  let adjacentSame = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i].role === history[i - 1].role) adjacentSame++;
  }
  check('no two adjacent same-role turns', adjacentSame === 0, adjacentSame + ' violation(s)');
  check('nudge pushed an assistant turn first',
    history.some((m, i) => m.role === 'assistant' && history[i + 1]?.role === 'user'
      && /task list still has open items/.test(history[i + 1].content)),
    history.filter(m => m.role === 'user').length + ' user turns');

  // Cap behaviour: with continues switched off the loop must stop cleanly and
  // report exhaustion rather than silently truncating.
  call = 0;
  capMode = true;
  const capped = await runToolLoop({
    provider: { id: 'stub', model: 'stub', type: 'stub' },
    formData: { model: 'stub', messages: [], tools: OFFERED, temperature: 0.7 },
    metadata: { system: '', chatId: 'test-cap' },
    emit: () => {},
    tokenEvent: 'token',
    maxIterations: 3,
    maxAutoContinues: 0,
    todoKey: 'test-cap'
  });
  capMode = false;
  check('step cap reports exhaustion', capped.exhausted === true, 'iterations=' + capped.iterations);
  check('step cap stops at the limit', capped.iterations === 3, String(capped.iterations));
  check('partial text still returned', capped.text.includes('tick'), JSON.stringify(capped.text.slice(0, 40)));
  check('task list released after a capped run', todo.renderOpen('test-cap') === '');

  // An aborted turn must not throw away what the user already read.
  call = 0;
  abortMode = true;
  const ac = new AbortController();
  let partial = null;
  try {
    await runToolLoop({
      provider: { id: 'stub', model: 'stub', type: 'stub' },
      formData: { model: 'stub', messages: [], tools: OFFERED, temperature: 0.7 },
      metadata: { system: '', chatId: 'test-abort' },
      emit: () => {},
      tokenEvent: 'token',
      signal: ac.signal,
      maxIterations: 10,
      todoKey: 'test-abort'
    });
    check('abort throws', false, 'no throw');
  } catch (e) {
    partial = e.partial;
    check('abort throws AbortError', e.name === 'AbortError', e.name);
  }
  abortMode = false;
  check('aborted turn keeps its streamed text',
    partial && partial.text.includes('half an answer'), JSON.stringify((partial || {}).text || ''));
  check('aborted turn keeps its tool runs',
    partial && partial.toolRuns.length === 1, ((partial || {}).toolRuns || []).map(r => r.name).join(','));
  check('task list released after an abort', todo.renderOpen('test-abort') === '');

  // Out of continuation budget with work still open: the user must be told the
  // job is unfinished instead of the task list just vanishing with the turn.
  call = 0;
  const cappedContinues = await runToolLoop({
    provider: { id: 'stub', model: 'stub', type: 'stub' },
    formData: { model: 'stub', messages: [], tools: OFFERED, temperature: 0.7 },
    metadata: { system: '', chatId: 'test-cont-cap' },
    emit: () => {},
    tokenEvent: 'token',
    maxIterations: 60,
    maxAutoContinues: 1,
    todoKey: 'test-cont-cap'
  });
  check('stops cleanly when continuations run out', cappedContinues.exhausted === false, String(cappedContinues.exhausted));
  check('unfinished job is admitted in the reply',
    /still open/.test(cappedContinues.text), JSON.stringify(cappedContinues.text.slice(-90)));
  check('unfinished job is still saved', cappedContinues.text.length > 100, String(cappedContinues.text.length));

  // ---- <thinking> blocks must never leak into the visible answer --------
  {
    let text = '', think = '';
    const s = makeThinkingStripper((t) => text += t, (t) => think += t);
    s('hey he. building it. <thin'); s('king> 3D scene plan </thinking> here it is.');
    s.end();
    check('thinking stripped from visible text', text === 'hey he. building it.  here it is.', JSON.stringify(text));
    check('thinking routed to the thought channel', think === ' 3D scene plan ', JSON.stringify(think));

    let t2 = '', h2 = '';
    const s2 = makeThinkingStripper((t) => t2 += t, (t) => h2 += t);
    s2('start <thinking> unclosed'); s2.end();
    check('unclosed thinking does not leak as text', t2 === 'start ', JSON.stringify(t2));
    check('unclosed thinking captured as thought', h2 === ' unclosed', JSON.stringify(h2));
  }

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
