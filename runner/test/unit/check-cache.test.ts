// check.sh's pass records (scripts/check-cache.mjs): a step or a runner unit
// test file that passed with the same inputs is skipped, in any worktree,
// after a rebase or a release coming in (Ville, 21 Nov 2026: "Keep track of
// changes and only run the deltas").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error a plain .mjs script, no types
import { treeOf, stepKey, testKeys, passed } from '../../../scripts/check-cache.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');

function tmp(name: string) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `tb-check-cache-${name}-`));
}
function writer(root: string) {
  return (rel: string, text: string, mode?: number) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
    if (mode) fs.chmodSync(path.join(root, rel), mode);
  };
}
const git = (root: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('a git checkout and a plain copy with the same files agree, dirty files included', () => {
  const a = tmp('git');
  const b = tmp('plain');
  try {
    for (const root of [a, b]) {
      const put = writer(root);
      put('runner/src/x.ts', 'export const x = 1;\n');
      put('docs/guide.md', '# guide\n');
    }
    git(a, 'init', '-q');
    git(a, 'add', '.');
    git(a, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'one');
    assert.deepEqual([...treeOf(a)].sort(), [...treeOf(b)].sort());
    // An edit not yet committed, and a new file, count as what they hold.
    for (const root of [a, b]) {
      writer(root)('runner/src/x.ts', 'export const x = 2;\n');
      writer(root)('runner/src/y.ts', 'export const y = 1;\n');
    }
    assert.deepEqual([...treeOf(a)].sort(), [...treeOf(b)].sort());
    assert.equal(treeOf(a).size, 3);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("a step's key changes with what it reads, its command, the check and Node, not with other files", () => {
  const tree = new Map([
    ['site/build.mjs', 'a1'], ['docs/guide.md', 'b1'], ['runner/src/x.ts', 'c1'], ['check.sh', 'd1'], ['README.md', 'e1'],
  ]);
  const key = (t: Map<string, string>, name = 'site build', args = ['node', 'scripts/build.mjs', '--check']) => stepKey(t, name, args);
  const base = key(tree);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(key(new Map([...tree, ['runner/src/x.ts', 'c2']])), base, 'the runner is nothing the site reads');
  assert.notEqual(key(new Map([...tree, ['docs/guide.md', 'b2']])), base);
  assert.notEqual(key(new Map([...tree, ['check.sh', 'd2']])), base);
  assert.notEqual(key(tree, 'site build', ['node', 'scripts/build.mjs']), base);
  // Where the checkout is doesn't matter.
  assert.equal(stepKey(tree, 'site build', ['/a/b/site/x'], { root: '/a/b' }), stepKey(tree, 'site build', ['/c/site/x'], { root: '/c' }));
  // The tool's version is part of it.
  assert.notEqual(stepKey(tree, 'desktop lint', ['cargo'], { tools: 'cargo 1.90' }), stepKey(tree, 'desktop lint', ['cargo'], { tools: 'cargo 1.91' }));
  // A step it doesn't know reads everything: skipped only when nothing changed.
  assert.notEqual(key(new Map([...tree, ['README.md', 'e2']]), 'brand new step'), key(tree, 'brand new step'));
  // Lint reads the files it's given and its config.
  const lint = (t: Map<string, string>) => stepKey(t, 'lint', ['npm', 'run', 'lint:files', '--', 'runner/src/x.ts']);
  assert.equal(lint(new Map([...tree, ['site/build.mjs', 'a2']])), lint(tree));
  assert.notEqual(lint(new Map([...tree, ['runner/src/x.ts', 'c2']])), lint(tree));
  // Installs and end-to-end runs are never skipped.
  assert.equal(stepKey(tree, 'runner packages', ['npm', 'ci']), '');
  assert.equal(stepKey(tree, 'runner e2e', ['node']), '');
});

test("a test file's key follows its imports and the files it names, and the test helpers change them all", () => {
  const root = tmp('tests');
  try {
    const put = writer(root);
    put('runner/src/a.ts', "import { b } from './b.ts';\nexport const a = b;\n");
    put('runner/src/b.ts', 'export const b = 1;\n');
    // The app's code names docs to tell people about them; a test names
    // the ones it reads.
    put('runner/src/c.ts', "export const c = 'see docs/protocol.md';\n");
    put('runner/test/unit/a.test.ts', "import { a } from '../../src/a.ts';\n");
    put('runner/test/unit/c.test.ts', "import { c } from '../../src/c.ts';\nconst guide = path.join(ROOT, 'docs/guide.md');\n");
    put('runner/test/unit/s.test.ts', "const s = path.join(ROOT, 'scripts', 'go.sh');\n");
    put('scripts/go.sh', 'bash "$ROOT/scripts/inner.sh"\n');
    put('scripts/inner.sh', 'true\n');
    put('docs/guide.md', '# guide\n');
    put('docs/protocol.md', '# protocol\n');
    put('runner/test/helpers/clean-env.ts', '');
    put('check.sh', '');
    const files = ['test/unit/a.test.ts', 'test/unit/c.test.ts', 'test/unit/s.test.ts'];
    const keys = () => testKeys(root, treeOf(root), files) as Map<string, string>;
    const before = keys();
    const changed = (rel: string, text: string) => {
      const old = fs.readFileSync(path.join(root, rel), 'utf8');
      put(rel, text);
      const after = keys();
      put(rel, old);
      return files.filter((f) => after.get(f) !== before.get(f));
    };
    assert.deepEqual(changed('runner/src/b.ts', 'export const b = 2;\n'), ['test/unit/a.test.ts'], 'through an import of an import');
    assert.deepEqual(changed('docs/guide.md', '# new\n'), ['test/unit/c.test.ts'], 'a file the test names');
    assert.deepEqual(changed('docs/protocol.md', '# new\n'), [], 'a file only the code names');
    assert.deepEqual(changed('scripts/inner.sh', 'false\n'), ['test/unit/s.test.ts'], 'a script the script it runs runs');
    assert.deepEqual(changed('runner/test/helpers/clean-env.ts', '// x\n'), files);
    assert.deepEqual(changed('check.sh', '# x\n'), files);
    // Copied somewhere else, the keys are the same.
    const copy = tmp('copy');
    fs.cpSync(root, copy, { recursive: true });
    assert.deepEqual([...testKeys(copy, treeOf(copy), files)], [...before]);
    fs.rmSync(copy, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a record counts for a week', () => {
  const dir = tmp('records');
  try {
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests', 'k'), '21 Nov 17:00 on thread/x\n');
    assert.equal(passed(dir, 'tests', 'k'), '21 Nov 17:00 on thread/x');
    assert.equal(passed(dir, 'tests', 'k', Date.now() + 8 * 86_400_000), undefined);
    assert.equal(passed(dir, 'tests', 'none'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The real check.sh in a throwaway checkout whose steps are stand-ins, as
// check-only.test.ts does it.
const PASSES = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const FAILS = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n";

function checkout() {
  const root = tmp('run');
  const put = writer(root);
  const copy = (rel: string, mode?: number) => put(rel, fs.readFileSync(path.join(repo, rel), 'utf8'), mode);
  copy('check.sh', 0o755);
  copy('scripts/swift-freeze.sh', 0o755);
  copy('scripts/check-cache.mjs');
  copy('runner/scripts/find-node.sh');
  copy('scripts/limit-step.mjs');
  copy('runner/test/helpers/failed-files-reporter.mjs');
  copy('runner/test/helpers/passed-files-reporter.mjs');
  put('runner/package.json', JSON.stringify({ scripts: { typecheck: 'true' } }));
  put('runner/node_modules/.package-lock.json', '{}');
  put('runner/test/helpers/clean-env.ts', '');
  put('runner/src/one.ts', 'export const one = 1;\n');
  put('runner/test/unit/one.test.ts', `import '../../src/one.ts';\n${PASSES}`);
  put('runner/test/unit/two.test.ts', PASSES);
  put('package.json', JSON.stringify({ scripts: { 'convex:typecheck': 'true', 'web:typecheck': 'true', 'web:test': 'true', lint: 'true', 'lint:files': 'true' } }));
  put('node_modules/.package-lock.json', '{}');
  put('app/Tools/ok.mjs', '');
  put('mock-runner/ok.mjs', '');
  put('mock-runner/node_modules/.package-lock.json', '{}');
  put('desktop/.keep', '');
  put('bin/swift', '#!/bin/bash\n', 0o755);
  put('bin/cargo', '#!/bin/bash\n', 0o755);
  return { root, put, records: path.join(root, 'Library', 'Caches', 'Threadbear', 'check-passes') };
}

function run(c: { root: string, records: string }, flags: string[] = ['--quick'], extra: NodeJS.ProcessEnv = {}) {
  const list = path.join(c.root, '.changed');
  fs.writeFileSync(list, 'runner/src/one.ts\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${path.join(c.root, 'bin')}:${process.env.PATH}`,
    THREADBEAR_CHECK_CHANGED_FILE: list, THREADBEAR_NODE: process.execPath, TMPDIR: c.root, HOME: c.root,
  };
  for (const k of Object.keys(env)) if (/^THREAD(BEAR|BARE)_(CHECK_|HOME$)/.test(k) && k !== 'THREADBEAR_CHECK_CHANGED_FILE') delete env[k];
  delete env.NODE_TEST_CONTEXT;
  // As a thread's tb land runs it: THREADBEAR_HOME is the real one (this
  // test's HOME's), so the records go in the real folder.
  env.THREADBEAR_HOME = path.join(c.root, 'Library', 'Application Support', 'Threadbear');
  Object.assign(env, extra);
  const r = spawnSync('bash', [path.join(c.root, 'check.sh'), ...flags, '--local'], { env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const line = (out: string, name: string) => out.split('\n').find((l) => new RegExp(`^(ok|FAIL|skip)\\s+${name}\\b`).test(l)) ?? '';

test('check.sh skips what passed with the same inputs, says so, and runs what changed', () => {
  const c = checkout();
  try {
    const first = run(c);
    assert.equal(first.status, 0, first.out);
    assert.match(line(first.out, 'web tests'), /^ok/, first.out);
    assert.match(line(first.out, 'runner unit tests'), /^ok/, first.out);

    assert.equal(fs.readdirSync(path.join(c.records, 'tests')).length, 2, 'both test files recorded');
    const again = run(c);
    assert.equal(again.status, 0, again.out);
    assert.match(line(again.out, 'web tests'), /^ok\s+web tests\s+0s  \(skipped: passed with the same inputs \d\d \w+ \d\d:\d\d on a copy\)$/, again.out);
    assert.match(line(again.out, 'runner unit tests'), /^ok .*\(skipped: all 2 test files passed/, again.out);

    // One test's import changes: just that file runs, and the line says so.
    c.put('runner/src/one.ts', 'export const one = 2;\n');
    const one = run(c);
    assert.equal(one.status, 0, one.out);
    assert.match(line(one.out, 'runner unit tests'), /^ok .*skipped 1 test files/, one.out);
    assert.match(one.out, /ran: test\/unit\/one\.test\.ts$/m, one.out);
    assert.match(line(one.out, 'web tests'), /skipped: passed/, 'nothing web reads changed');

    // A failing file: the others still count, and the next run is just it.
    c.put('runner/test/unit/bad.test.ts', FAILS);
    const bad = run(c);
    assert.equal(bad.status, 1, bad.out);
    c.put('runner/test/unit/bad.test.ts', PASSES);
    const fixed = run(c);
    assert.equal(fixed.status, 0, fixed.out);
    assert.match(fixed.out, /ran: test\/unit\/bad\.test\.ts$/m, fixed.out);

    // --all runs everything (and the steps this stand-in checkout can't
    // pass, which nothing else asks for).
    const all = run(c, ['--quick', '--all']);
    assert.match(line(all.out, 'web tests'), /^ok\s+web tests\s+\d+s$/, all.out);
    assert.match(line(all.out, 'runner unit tests'), /^ok/, all.out);
    assert.doesNotMatch(all.out, /skipped \d+ test files/);

    // --fresh (tb land --full) runs everything again without --all's extra
    // steps, the same through THREADBEAR_CHECK_FRESH, and still records.
    for (const fresh of [run(c, ['--quick', '--fresh']), run(c, ['--quick'], { THREADBEAR_CHECK_FRESH: '1' })]) {
      assert.equal(fresh.status, 0, fresh.out);
      assert.match(line(fresh.out, 'web tests'), /^ok\s+web tests\s+\d+s$/, fresh.out);
      assert.doesNotMatch(fresh.out, /skipped/, fresh.out);
    }
    assert.match(line(run(c).out, 'web tests'), /skipped: passed/);

    // A change to the check itself runs everything again.
    fs.appendFileSync(path.join(c.root, 'check.sh'), '\n');
    const changed = run(c);
    assert.match(line(changed.out, 'web tests'), /^ok\s+web tests\s+\d+s$/, changed.out);
    assert.match(line(changed.out, 'runner unit tests'), /^ok/, changed.out);
    assert.doesNotMatch(changed.out, /skipped \d+ test files/);
  } finally {
    fs.rmSync(c.root, { recursive: true, force: true });
  }
});
