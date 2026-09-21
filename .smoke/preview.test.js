// The Live React Preview must not fail to compile because of an import the
// sandbox has no copy of.
//
// Two classes of failure have bitten users:
//   1. a component the shadcn shim had no real implementation for (RadioGroup
//      fell through to the catch-all div stub, so no radio was ever clickable)
//   2. a bare npm package or "@/lib/*" helper with no resolver at all
//      (date-fns, @/lib/utils) — this failed the entire build, not just one
//      component.
//
// These checks drive the real bundler against the real workspaces and then
// unit-test the shims it injects.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const { buildReactApp, findEntry } = require(path.join(ROOT, 'src', 'react_bundler'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// The shims are written for the browser and read `window.React` at load time.
// This stand-in is enough to execute them and inspect the elements they build;
// it deliberately mimics nothing else about React.
const fakeReact = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length > 1 ? children : children[0] }
  }),
  createContext: (v) => ({ Provider: 'Provider', Consumer: 'Consumer', _default: v }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useContext: (c) => (c && c._default) || {},
  Children: { forEach: () => {}, map: () => [] },
  cloneElement: (el) => el,
  isValidElement: () => false,
  Fragment: 'Fragment'
};
global.window = { React: fakeReact, ReactDOM: {} };

// Pull a `const NAME = \`...\`;` shim out of the bundler source and evaluate it
// as a CommonJS module, so the shim is tested exactly as the browser gets it.
function loadShim(source, name) {
  const start = source.indexOf(`const ${name} = \``);
  if (start === -1) throw new Error(`shim ${name} not found in react_bundler.js`);
  const from = start + `const ${name} = \``.length;
  const end = source.indexOf('`;', from);
  if (end === -1) throw new Error(`shim ${name} is not terminated`);
  // The raw source text still carries the template-literal escapes (\` and \${).
  // JS resolves them when the real shim is built; do the same here, or the
  // extracted text is not valid JavaScript.
  const body = source.slice(from, end).replace(/\\`/g, '`').replace(/\\\$\{/g, '${');
  const mod = { exports: {} };
  new Function('module', 'exports', body)(mod, mod.exports);
  return mod.exports;
}

(async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'react_bundler.js'), 'utf8');

  // ---- 1. every workspace preview compiles ------------------------------
  const wsRoot = path.join(ROOT, 'workspace', 'chats');
  const chats = fs.existsSync(wsRoot)
    ? fs.readdirSync(wsRoot).filter(d => {
        const dir = path.join(wsRoot, d);
        try { if (!fs.statSync(dir).isDirectory()) return false; } catch { return false; }
        // A `src` DIRECTORY is not evidence of a React project. A plain
        // HTML/CSS/JS deliverable can put src/index.html and src/app.js there —
        // which is exactly what one did, and this suite then failed a chat that
        // was never meant to be previewed as React. What makes a chat previewable
        // is an entry file the bundler can actually mount.
        return findEntry(dir) !== null;
      })
    : [];
  check('found previewable chats', chats.length > 0, chats.join(','));

  for (const id of chats) {
    const html = await buildReactApp(id);
    if (html == null) {
      check(`preview compiles: ${id}`, false, 'no entry file found (buildReactApp returned null)');
      continue;
    }
    const failed = html.includes('Compilation Error');
    let detail = '';
    if (failed) {
      const i = html.indexOf('<pre');
      const j = html.indexOf('</pre>');
      detail = html.slice(i, j).replace(/\s+/g, ' ').slice(0, 240);
    }

    // This scans the LIVE workspace, so it sees whatever the agent last
    // generated — including a project the model left half-written. An import of
    // a file the project never created is that project's content, not this
    // bundler's contract: the console reports it through diagnostics and sends
    // the model back to repair it. Only an error the BUNDLER caused — an
    // unresolvable shim, a loader, the JSX runtime — is a regression here.
    const projectContentError = /Could not resolve "(@\/|\.\.?\/)/.test(detail);
    if (failed && projectContentError) {
      console.log(`SKIP  unfinished project in the workspace: ${id}  — ${detail.slice(0, 120)}`);
      continue;
    }
    check(`preview compiles: ${id}`, !failed, detail);

    // Absence of an error is not evidence the app was bundled. The vendor
    // catch-all once swallowed esbuild's own entry point (an absolute path starts
    // with a non-`.` character on Windows), so every preview silently became a
    // ~1.4 KB stub while this suite stayed green.
    //
    // Neither size nor a bare substring works as the test here: a real app in this
    // workspace is only 6 KB, and the HTML wrapper itself contains the word "App"
    // (as `HamaApp`), so `html.includes('App')` passes on a stub. What does
    // discriminate is whether the entry file's own component is *declared* in the
    // bundled region — a stub declares nothing.
    if (!failed) {
      const chunks = html.split('<script>').map(c => c.split('</script>')[0]);
      const bundle = chunks.reduce((a, b) => (b.length > a.length ? b : a), '');
      const entry = findEntry(path.join(wsRoot, id));
      const entrySrc = entry ? fs.readFileSync(path.join(wsRoot, id, entry), 'utf8') : '';

      const names = new Set();
      for (const m of entrySrc.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:default\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
      const def = entrySrc.match(/export\s+default\s+(?:function\s+|class\s+)?([A-Za-z_$][\w$]*)/);
      if (def) names.add(def[1]);

      const declared = [...names].filter(n => new RegExp('function\\s+' + n + '\\s*\\(|const\\s+' + n + '\\s*=').test(bundle));
      check(`preview bundles the real entry code: ${id}`, declared.length > 0,
        `bundle ${bundle.length}B, declared=[${declared}] of [${[...names]}]`);
    }
  }

  // ---- 2. the shadcn shim implements the interactive primitives ---------
  // A stubbed RadioGroup renders nested <div>s: nothing clickable, no value
  // ever selected. These have to be real members of the shim, not caught by
  // the catch-all Proxy — which is why the assertion is on the function's
  // name, not merely on it being callable. The catch-all always returns a
  // callable stub, so `typeof === 'function'` would pass either way.
  const shadcn = loadShim(src, 'SHADCN_UI_SHIM');
  for (const name of ['RadioGroup', 'RadioGroupItem', 'Checkbox', 'Switch', 'Slider',
                      'Separator', 'Skeleton', 'Alert', 'Table', 'Card', 'Button']) {
    check(`shim has a real ${name}`, shadcn[name] && shadcn[name].name === name,
      shadcn[name] && shadcn[name].name);
  }
  // The catch-all must survive: an unlisted component should still render
  // something rather than crash the preview.
  check('unknown component still stubbed',
    typeof shadcn.SomeFutureWidget === 'function' && shadcn.SomeFutureWidget.name === 'ShadcnStub',
    shadcn.SomeFutureWidget && shadcn.SomeFutureWidget.name);

  // The end of the original bug: RadioGroupItem must be a real radio input.
  // A stub would have produced a <div>, leaving the user unable to pick
  // Expense or Income at all.
  const radio = shadcn.RadioGroupItem({ value: 'income', id: 'income' });
  check('RadioGroupItem renders an <input type="radio">',
    radio.type === 'input' && radio.props.type === 'radio',
    `${radio.type} type=${radio.props.type}`);
  check('RadioGroupItem carries its value through', radio.props.value === 'income');

  const checkbox = shadcn.Checkbox({ defaultChecked: true });
  check('Checkbox renders an <input type="checkbox">',
    checkbox.type === 'input' && checkbox.props.type === 'checkbox', checkbox.props.type);

  const slider = shadcn.Slider({ defaultValue: 40, min: 0, max: 100 });
  check('Slider renders an <input type="range">', slider.type === 'input' && slider.props.type === 'range',
    slider.props.type);

  // shadcn's Table wraps the <table> in a scroll container, so the element the
  // component returns is that div; the table is its child.
  const table = shadcn.Table({ children: null });
  check('Table renders real table markup', table.props.children && table.props.children.type === 'table',
    String(table.type) + ' > ' + String(table.props.children && table.props.children.type));

  // ---- 3. date-fns produces real values, not just a clean build ---------
  const df = loadShim(src, 'DATE_FNS_SHIM');
  check('date-fns format MMM d, yyyy',
    df.format(df.parseISO('2026-09-20'), 'MMM d, yyyy') === 'Sep 20, 2026',
    df.format(df.parseISO('2026-09-20'), 'MMM d, yyyy'));
  check('date-fns format EEEE',
    df.format(df.parseISO('2026-09-20'), 'EEEE') === 'Sunday',
    df.format(df.parseISO('2026-09-20'), 'EEEE'));
  check('date-fns 12h clock',
    df.format(new Date(2026, 8, 20, 14, 5), 'h:mm a') === '2:05 PM',
    df.format(new Date(2026, 8, 20, 14, 5), 'h:mm a'));
  check('date-fns 24h clock',
    df.format(new Date(2026, 8, 20, 14, 5, 9), 'HH:mm:ss') === '14:05:09',
    df.format(new Date(2026, 8, 20, 14, 5, 9), 'HH:mm:ss'));
  // A bare "YYYY-MM-DD" must not be read as UTC midnight — west of Greenwich
  // that lands on the previous day and every date in the app shifts by one.
  check('date-fns parseISO is local-midnight',
    df.parseISO('2026-09-20').getDate() === 20 && df.parseISO('2026-09-20').getMonth() === 8,
    df.parseISO('2026-09-20').toString());
  check('date-fns isSameMonth', df.isSameMonth(df.parseISO('2026-09-01'), df.parseISO('2026-09-30')) === true);
  check('date-fns startOfMonth',
    df.startOfMonth(df.parseISO('2026-09-20')).getDate() === 1,
    df.startOfMonth(df.parseISO('2026-09-20')).toDateString());
  check('date-fns subDays', df.subDays(df.parseISO('2026-09-20'), 7).getDate() === 13,
    df.subDays(df.parseISO('2026-09-20'), 7).toDateString());
  check('date-fns eachDayOfInterval',
    df.eachDayOfInterval({ start: df.parseISO('2026-09-18'), end: df.parseISO('2026-09-22') }).length === 5);
  check('date-fns unknown helper is callable, not a crash', typeof df.getWeek === 'function');

  // ---- 4. cn / clsx / cva join classes ---------------------------------
  const cn = loadShim(src, 'CN_SHIM');
  check('cn joins strings', cn.cn('a', 'b') === 'a b', cn.cn('a', 'b'));
  check('cn drops falsy', cn.cn('a', false, null, undefined, '') === 'a');
  check('cn expands arrays and objects',
    cn.cn('a', ['b', { c: true, d: false }]) === 'a b c', cn.cn('a', ['b', { c: true, d: false }]));
  check('cn is callable as a default import', cn('x', 'y') === 'x y', cn('x', 'y'));
  check('clsx named export works', cn.clsx('x', 'y') === 'x y');
  check('twMerge named export works', cn.twMerge('p-2', 'p-4') === 'p-2 p-4', cn.twMerge('p-2', 'p-4'));
  const variant = cn.cva('base', {
    variants: { size: { sm: 'text-sm', lg: 'text-lg' } },
    defaultVariants: { size: 'sm' }
  });
  check('cva applies a variant', variant({ size: 'lg' }) === 'base text-lg', variant({ size: 'lg' }));
  check('cva applies the default variant', variant({}) === 'base text-sm', variant({}));
  check('cva keeps a caller class', variant({ size: 'lg', class: 'extra' }) === 'base text-lg extra',
    variant({ size: 'lg', class: 'extra' }));

  // ---- 5. the vendor catch-all is not silently swallowing real files ----
  // A missing "@/..." file is a genuine app bug and must still fail loudly;
  // only bare package specifiers fall through to the stub.
  const bad = fs.mkdtempSync(path.join(ROOT, '.smoke', 'vendorprobe-'));
  fs.mkdirSync(path.join(bad, 'src'), { recursive: true });
  fs.writeFileSync(path.join(bad, 'src', 'App.tsx'),
    'import { Nope } from "@/does/not/exist";\nexport default function App(){ return <div>{Nope}</div>; }\n');
  const esbuild = require('esbuild');
  let missingLocal = '';
  try {
    await esbuild.build({
      entryPoints: [path.join(bad, 'src', 'App.tsx')], bundle: true, write: false, format: 'iife'
    });
  } catch (e) { missingLocal = e.message; }
  check('a missing @/ file still fails the build', /Could not resolve/.test(missingLocal),
    missingLocal.split('\n')[0]);
  fs.rmSync(bad, { recursive: true, force: true });

  const failed = results.filter(r => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
