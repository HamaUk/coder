// The tool-calling contract of the system prompt.
//
// The free Hama AI / LlamaCoder engine has no structured tool API — the model
// only sees the prompt. Listing the tools was not enough: the model invented its
// own convention (writing ```js{path=…} fences) and the agent silently degraded
// to "write files only" — no read_file, edit_file, grep or run_script. Spelling
// out the invocation markup is what makes real tool calls happen, so it is
// pinned here.
//
// Native providers (OpenAI/Anthropic/Gemini) must NOT receive that markup: they
// use structured tool calls and would be confused into emitting it as text.
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.HAMA_DATA_DIR = path.join(__dirname, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(__dirname, 'workspace');

const { composeSystemPrompt } = require(path.join(ROOT, 'src', 'agent'));
const toolsKit = require(path.join(ROOT, 'src', 'tools'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const settings = { agentName: 'HAMA' };
const defs = toolsKit.defsFor({ web: true, files: true, code: true });

const free = composeSystemPrompt(
  { type: 'llamacoder', name: 'Hama AI', model: 'm', customInstructions: '' },
  settings, defs, 'prompt-test-free'
);
check('the free engine is told the tool-call markup', free.includes('<|DSML|tool_calls>'));
check('the markup shows an invoke + parameter shape',
  free.includes('<|DSML|invoke name="TOOL_NAME">') && free.includes('<|DSML|parameter name="PARAM_NAME">'));
check('the free engine is told not to use code fences for files',
  /Do NOT create files by writing code blocks/.test(free));
check('the tools are still listed by name',
  free.includes('- write_file:') && free.includes('- grep:'));
check('file paths are described as workspace-relative', /workspace root/.test(free));

// ---------------------------------------------------------------------------
// Output-size guidance
//
// Every request for a substantial file ("a template", "a dashboard", "a real
// scraper") came back as a 30–60 line stub that compiled and did nothing. The
// prompt is what the model calibrates against, so the guidance that sets the
// floor is pinned here — and so is the absence of the old wording that set the
// ceiling ("prefer finishing one file properly over scaffolding several" was
// being read as "keep files small").
// ---------------------------------------------------------------------------
{
  check('the prompt tells the model to write complete files, not skeletons',
    /## How much code to write/.test(free) && /Never satisfy a request with a skeleton/.test(free));
  check('the prompt gives a concrete sense of a substantial file',
    /150–600 lines/.test(free), 'a floor the model can aim at');
  check('the prompt explains how to exceed one call\'s worth of content',
    /append: true/.test(free) && /split it across calls/.test(free));
  check('the prompt tells the model to make the files work together',
    /actually use each other/.test(free));
  check('the prompt still forbids padding',
    /Do not pad/.test(free));
  check('the "prefer one file over scaffolding" rule no longer caps file size',
    /but "properly" means the whole file, not a shortened one/.test(free));
  check('the size guidance reaches native providers too',
    /## How much code to write/.test(
      composeSystemPrompt(
        { type: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', customInstructions: '' },
        settings, defs, 'prompt-test-size-native'
      )
    ));
}

const native = composeSystemPrompt(
  { type: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', customInstructions: '' },
  settings, defs, 'prompt-test-native'
);
check('native providers are NOT given the DSML markup', !native.includes('<|DSML|tool_calls>'));
check('native providers still get the tool list', native.includes('- write_file:'));

const custom = composeSystemPrompt(
  { type: 'openai', name: 'Local (OpenAI-compatible)', model: 'x', customInstructions: '' },
  settings, defs, 'prompt-test-compat'
);
check('OpenAI-compatible presets are NOT given the DSML markup', !custom.includes('<|DSML|tool_calls>'));

// Exhaustive: every provider type the app ships must land on the right side.
{
  const { PRESETS } = require(path.join(ROOT, 'src', 'providers'));
  const types = [...new Set(PRESETS.map((p) => p.type))];
  for (const type of types) {
    const prompt = composeSystemPrompt(
      { type, name: type, model: 'm', customInstructions: '' },
      settings, defs, 'prompt-test-' + type
    );
    const hasMarkup = prompt.includes('<|DSML|tool_calls>');
    const should = !['openai', 'anthropic', 'google'].includes(type);
    check(`${type} gets the DSML markup: ${should}`, hasMarkup === should, hasMarkup ? 'present' : 'absent');
  }
}

const noTools = composeSystemPrompt(
  { type: 'llamacoder', name: 'Hama AI', model: 'm', customInstructions: '' },
  settings, [], 'prompt-test-notools'
);
check('no tools means no call markup', !noTools.includes('<|DSML|tool_calls>'));
check('no tools says so explicitly', /No external tools are enabled/.test(noTools));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
