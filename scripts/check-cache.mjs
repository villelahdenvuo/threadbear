#!/usr/bin/env node
// check.sh's pass records: a step, or one of the runner's unit test files,
// that passed with exactly these inputs before is skipped (Ville, 21 Nov
// 2026: "Keep track of changes and only run the deltas"). A landing's check
// on a Mac with no check host took 20 to 25 minutes, most of it the runner's
// unit tests, rerunning files nothing had touched.
//
// The key is made from what the files hold (git's blob ids), never from
// commits or dates, so a pass in one worktree counts in every other, after
// a rebase, and after one of Mike's releases comes in: a release that
// changes 1000 files reruns only what those files reach. Each key also
// holds the Node version, the step's command line, its tool's version
// (cargo, swift), check.sh and this file, so a new tool or a changed check
// reruns everything it touches.
//
//   node scripts/check-cache.mjs tree <checkout> <out>
//       writes "<blob id> <path>" for every file the checkout has (tracked
//       and untracked, not ignored; or every file, with no .git)
//   node scripts/check-cache.mjs step <tree> <checkout> <step name> [<command and args...>]
//       prints the step's key, or nothing for a step that's never skipped
//   node scripts/check-cache.mjs tests <tree> <checkout> <records> <file...>
//       for each test file (from runner/): "run <file> <key>" or
//       "skip <file> <key> <when and where it passed>"
//
// The records are empty-ish files named by key, under check.sh's records
// folder (~/Library/Caches/Threadbear/check-passes), shared by every
// checkout. One older than RECORD_DAYS doesn't count, so whatever a key
// misses (a file a test reads by a name built at run time) runs again
// within a week anyway.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const RECORD_DAYS = 7;
const VERSION = 'check-cache 1';

// What every key holds besides its own inputs: the check itself.
const CHECK_FILES = ['check.sh', 'scripts/check-cache.mjs', 'scripts/limit-step.mjs', 'runner/scripts/find-node.sh'];
// And every test file's: how the tests are run, and the packages they get.
const TEST_FILES = ['runner/package.json', 'runner/package-lock.json', 'runner/tsconfig.json',
  'runner/test/helpers/clean-env.ts', 'runner/test/helpers/failed-files-reporter.mjs', 'runner/test/helpers/passed-files-reporter.mjs'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const blob = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ---- the checkout's files ---------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.build', 'target', '.fixtures', 'dist', '.swiftpm']);

function hashFile(abs) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return blob(Buffer.from(fs.readlinkSync(abs)));
  if (!st.isFile()) return undefined;
  return blob(fs.readFileSync(abs));
}

function walk(root) {
  const out = new Map();
  const go = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) go(r);
      } else if (e.isFile() || e.isSymbolicLink()) {
        const h = hashFile(path.join(root, r));
        if (h) out.set(r, h);
      }
    }
  };
  go('');
  return out;
}

// git ls-files -s gives tracked files' blob ids without reading them; files
// that differ from the index, and untracked ones, are hashed here the same
// way, so a dirty checkout and a clean one with the same text agree.
export function treeOf(root) {
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(root)) return walk(root);
  const staged = git(['ls-files', '-s', '-z']);
  const dirty = git(['ls-files', '-m', '-o', '--exclude-standard', '-z']);
  if (staged.status !== 0 || dirty.status !== 0) return walk(root);
  const out = new Map();
  for (const entry of staged.stdout.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d\t(.+)$/s.exec(entry);
    // Submodules (160000) aren't files here.
    if (m && m[1] !== '160000') out.set(m[3], m[2]);
  }
  for (const rel of dirty.stdout.split('\0')) {
    if (!rel) continue;
    let h;
    try { h = hashFile(path.join(root, rel)); } catch { h = undefined; }
    if (h) out.set(rel, h); else out.delete(rel);
  }
  return out;
}

export function readTree(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0) out.set(line.slice(i + 1), line.slice(0, i));
  }
  return out;
}

const keyOf = (tree, files, extra) => {
  const lines = [VERSION, ...extra];
  for (const f of [...new Set(files)].sort()) lines.push(`${tree.get(f) ?? 'none'} ${f}`);
  return sha(lines.join('\n'));
};

// ---- steps ------------------------------------------------------------------

// Top-level files a step's tools read (package.json, tsconfig, eslint config),
// not the docs beside them.
const rootConfig = (f) => !f.includes('/') && !f.endsWith('.md');
const under = (...prefixes) => (f) => prefixes.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

// Step name → which files it reads. A step not listed keys on every file:
// it's skipped only when nothing at all changed (a rebase with nothing new).
const STEPS = [
  [/^runner (typecheck|deploy tests)$/, under('runner/')],
  [/^app tools parse$/, under('app/Tools/', 'mock-runner/')],
  [/^(convex|web) /, (f) => under('convex/', 'web/', 'convex.json')(f) || rootConfig(f)],
  [/^site build$/, under('site/', 'docs/guide.md', 'docs/experiments.md')],
  [/^feature/, (f) => under('features/', 'docs/gpui-port/features.md')(f) || rootConfig(f)],
  [/^desktop /, under('desktop/', 'rust-toolchain.toml', 'features/support/', 'site/app-doc-slugs.json', 'mock-runner/', 'runner/src/',
    'runner/package.json', 'runner/package-lock.json', 'shared/')],
  [/^(app|dock) /, under('app/', 'dock/', 'shared/', 'mock-runner/')],
  [/^iphone /, under('ios/', 'app/', 'shared/')],
];
// Never skipped: installs aren't checks, and the end-to-end tests and the
// screenshots are asked for to be run.
const NEVER = /( packages| e2e|screenshots)$/;
const LINT_CONFIG = under('eslint.config.mjs', 'eslint-suppressions.json', 'package.json', 'package-lock.json');

// The version line of the tool a command runs, once a check (kept beside the tree).
function toolVersion(treeFile, args) {
  const tool = args.some((a) => /(^|\/)cargo$/.test(a)) ? 'cargo'
    : args.some((a) => /(^|\/)swift$/.test(a)) ? 'swift' : args.includes('npm') ? 'npm' : '';
  if (!tool) return '';
  const memo = `${treeFile}.${tool}-version`;
  try { return fs.readFileSync(memo, 'utf8'); } catch {}
  const cmd = tool === 'cargo'
    ? [args.find((a) => /(^|\/)cargo$/.test(a)), ['--version', '--verbose']]
    : tool === 'swift' ? ['swift', ['--version']] : ['npm', ['--version']];
  const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', cwd: path.join(path.dirname(treeFile)) });
  let v = `${tool}: ${(r.stdout ?? '').trim()} ${r.status}`;
  if (tool === 'cargo') {
    const rustc = spawnSync('rustc', ['--version', '--verbose'], { encoding: 'utf8' });
    v += ` rustc: ${(rustc.stdout ?? '').trim()}`;
  }
  try { fs.writeFileSync(memo, v); } catch {}
  return v;
}

export function stepKey(tree, name, args, { root = '', tools = '' } = {}) {
  if (NEVER.test(name) || name === 'runner unit tests') return '';
  // Where the checkout is doesn't matter, only what it holds.
  const rel = args.map((a) => (root && a.startsWith(`${root}/`) ? a.slice(root.length + 1) : a === root && root ? '.' : a));
  let pick = STEPS.find(([re]) => re.test(name))?.[1] ?? (() => true);
  if (name === 'lint') {
    // The files it's given, or all of them for "lint .".
    const given = new Set(rel);
    pick = given.has('.') ? () => true : (f) => given.has(f) || LINT_CONFIG(f);
  }
  const files = [...tree.keys()].filter((f) => pick(f));
  return keyOf(tree, [...files, ...CHECK_FILES], [`step ${name}`, `args ${JSON.stringify(rel)}`, `node ${process.version}`, tools]);
}

// ---- test files -------------------------------------------------------------

const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|sh|bash|pl)$/;
const TEST_SIDE = /^(runner\/test\/|scripts\/|runner\/scripts\/|runner\/bin\/|desktop\/scripts\/|[^/]+\.(sh|pl)$)/;
const runsAsProgram = (f) => CODE.test(f) || /(^|\/)bin\/[^/.]+$/.test(f);

// What one file reads: its relative imports, and any string in it that names
// a file or folder of the checkout ('docs/guide.md', path.join(ROOT,
// 'scripts', 'check-remote.sh')'s 'check-remote.sh', 'app/Tests/Fixtures'). A
// bare name matching more than three files counts only beside the file,
// at the top or in runner/ (index.ts, package.json).
function indexTree(tree) {
  const byBase = new Map();
  const dirs = new Map();
  const add = (m, k, v) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const f of tree.keys()) {
    add(byBase, path.posix.basename(f), f);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!dirs.has(d)) add(byBase, `${parts[i - 1]}/`, d);
      add(dirs, d, f);
    }
  }
  return { byBase, dirs };
}

export function makeReader(root, tree) {
  const { byBase, dirs } = indexTree(tree);
  const memo = new Map();
  const direct = (file) => {
    if (memo.has(file)) return memo.get(file);
    const out = new Set();
    memo.set(file, out);
    // The check's own files are in every key already, and this one names
    // folders all over.
    if (!runsAsProgram(file) || !tree.has(file) || CHECK_FILES.includes(file)) return out;
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { return out; }
    const here = path.posix.dirname(file);
    // The app's own code (runner/src and the like) names scripts, docs and
    // folders all over, mostly to tell an agent or a person about them, and
    // following those made nearly every test read nearly everything (1750
    // files each). From there only its imports count; from the tests' side
    // (tests, their helpers, the scripts they run) every name does.
    const testSide = TEST_SIDE.test(file);
    const addFile = (f) => { if (testSide && tree.has(f)) out.add(f); };
    const addDir = (d) => { if (testSide) for (const f of dirs.get(d) ?? []) out.add(f); };
    for (const m of text.matchAll(/['"`]([^'"`\s$<>{}*|,;:!?]{2,200})['"`]/g)) {
      let s = m[1];
      if (s.startsWith('./') || s.startsWith('../')) {
        const r = path.posix.normalize(path.posix.join(here, s));
        if (tree.has(r)) { out.add(r); continue; }
        if (tree.has(`${r}.ts`)) { out.add(`${r}.ts`); continue; }
        if (r.endsWith('.js') && tree.has(r.replace(/\.js$/, '.ts'))) { out.add(r.replace(/\.js$/, '.ts')); continue; }
        if (dirs.has(r)) { addDir(r); continue; }
        s = s.replace(/^(\.\.?\/)+/, '');
      }
      s = s.replace(/\/+$/, '');
      if (!s || s.startsWith('/')) continue;
      const base = path.posix.basename(s);
      if (s.includes('/')) {
        for (const f of byBase.get(base) ?? []) if (f === s || f.endsWith(`/${s}`)) addFile(f);
        for (const d of byBase.get(`${base}/`) ?? []) if (d === s || d.endsWith(`/${s}`)) addDir(d);
      } else if (/^[\w.@+-]+\.[A-Za-z0-9]{1,8}$/.test(s)) {
        const all = byBase.get(s) ?? [];
        const near = all.length <= 3 ? all : all.filter((f) => [here, '.', 'runner'].includes(path.posix.dirname(f)));
        for (const f of near) addFile(f);
      }
    }
    // And paths with a folder in them outside quotes, or inside a shell's
    // "$ROOT/scripts/x.sh".
    for (const m of text.matchAll(/(?:^|[^\w.@+/-])((?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,8})(?![\w/])/gm)) {
      const s = m[1];
      for (const f of byBase.get(path.posix.basename(s)) ?? []) if (f === s || f.endsWith(`/${s}`) || s.endsWith(`/${f}`)) addFile(f);
    }
    out.delete(file);
    return out;
  };
  const closure = (file) => {
    const seen = new Set();
    const todo = [file];
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const g of direct(f)) if (!seen.has(g)) todo.push(g);
    }
    return seen;
  };
  return { direct, closure };
}

export function testKeys(root, tree, files) {
  const reader = makeReader(root, tree);
  const common = new Set([...CHECK_FILES]);
  for (const f of TEST_FILES) for (const g of reader.closure(f)) common.add(g);
  const out = new Map();
  for (const t of files) {
    const all = reader.closure(`runner/${t}`);
    out.set(t, keyOf(tree, [...all, ...common], ['test', `file ${t}`, `node ${process.version}`]));
  }
  return out;
}

// When a key passed: the record's text, or undefined if there's none or it's
// older than RECORD_DAYS.
export function passed(records, kind, key, now = Date.now()) {
  const file = path.join(records, kind, key);
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs > RECORD_DAYS * 86_400_000) return undefined;
    return fs.readFileSync(file, 'utf8').trim() || 'before';
  } catch {
    return undefined;
  }
}

// ---- command line -----------------------------------------------------------

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'tree') {
    const [root, out] = rest;
    const tree = treeOf(path.resolve(root));
    fs.writeFileSync(out, [...tree].map(([f, h]) => `${h} ${f}`).join('\n') + '\n');
    return 0;
  }
  if (cmd === 'step') {
    const [treeFile, root, name, ...args] = rest;
    const key = stepKey(readTree(treeFile), name, args, { root, tools: toolVersion(treeFile, args) });
    if (key) console.log(key);
    return 0;
  }
  if (cmd === 'tests') {
    const [treeFile, root, records, ...files] = rest;
    const tree = readTree(treeFile);
    const lines = [];
    for (const [t, key] of testKeys(root, tree, files)) {
      const when = passed(records, 'tests', key);
      lines.push(when ? `skip ${t} ${key} ${when}` : `run ${t} ${key}`);
    }
    if (lines.length) console.log(lines.join('\n'));
    return 0;
  }
  console.error('usage: check-cache.mjs tree|step|tests ...');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
