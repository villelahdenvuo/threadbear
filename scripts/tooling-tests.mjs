#!/usr/bin/env node
// Which of the runner's slow tests of Threadbear's own tooling (landing,
// worktrees, check hosts, Mike's releases, the build lock) a --quick check
// can leave out, as nothing they test changed. check.sh's runner_unit_tests
// uses it. Ville asked on 20 Nov 2026: these took about half of every
// landing's 15 to 29 minutes on his Mac, for landings that never touched
// that tooling.
//
//   node scripts/tooling-tests.mjs <file listing what changed, from the repo's top>
//
// Prints the test files (from runner/) to leave out, one a line. A test is
// kept when it changed, when a file it imports changed (followed through
// relative imports, test helpers and runner/src alike), or when anything
// under a scripts/ folder, a .sh or .pl at the top or check.sh changed,
// which the tests run as programs rather than import. With nothing changed
// (main itself) it prints nothing: everything runs.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'runner');

// The slow tooling tests, by name under runner/test/unit. Times are from a
// landing's check on 20 Nov (each file's tests summed).
export const TOOLING_TESTS = [
  'perf-lock', 'land-queue', 'land-alone', 'land-culprit', // 363, 311, 286, 207 s
  'upstream-releases', 'upstream-limits', 'upstream-refs', // 190, 170, 165 s
  'check-remote-room', 'check-remote-room-failures', 'check-remote-drops', 'check-remote-copies', 'check-remote-line', // 187, 153, 103, 96, 85 s
  'worktrees-landing', 'worktrees-cleanup', 'worktrees-spares', // 165, 105, 56 s
  'perf-swift', 'box-save', 'stage-update-hosts', 'tb-dev', 'sync-main', 'borrows', // 101, 92, 84, 73, 70, 66 s
].map((n) => `test/unit/${n}.test.ts`);

// Anything the tests run as a program: a change there runs them all.
const PROGRAMS = /^(scripts\/|runner\/scripts\/|desktop\/scripts\/|runner\/bin\/|[^/]+\.(sh|pl)$)/;

// A file's relative imports, as files from the repo's top.
function importsOf(file) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    out.push(path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), m[1])));
  }
  return out;
}

export function closure(file) {
  const seen = new Set();
  const todo = [file];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const g of importsOf(f)) if (!seen.has(g)) todo.push(g);
  }
  return seen;
}

export function leaveOut(changed) {
  if (!changed.length || changed.some((f) => PROGRAMS.test(f))) return [];
  const touched = new Set(changed);
  return TOOLING_TESTS.filter((t) => fs.existsSync(path.join(RUNNER, t)) && ![...closure(`runner/${t}`)].some((f) => touched.has(f)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = process.argv[2];
  const changed = list ? fs.readFileSync(list, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : [];
  for (const t of leaveOut(changed)) console.log(t);
}
