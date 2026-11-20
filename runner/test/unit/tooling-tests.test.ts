// scripts/tooling-tests.mjs: which slow tests of Threadbear's own tooling a
// --quick check leaves out, as nothing they test changed (Ville, 20 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error a plain .mjs script, no types
import { TOOLING_TESTS, closure, leaveOut } from '../../../scripts/tooling-tests.mjs';

const runner = path.resolve(import.meta.dirname, '../..');

test('every tooling test named is a file here', () => {
  for (const t of TOOLING_TESTS as string[]) assert.ok(fs.existsSync(path.join(runner, t)), t);
});

test('a change outside what they import leaves them all out; one they import keeps those that use it', () => {
  assert.deepEqual(leaveOut(['desktop/gpui/src/highlights.rs', 'docs/protocol.md']), TOOLING_TESTS);
  const kept = (TOOLING_TESTS as string[]).filter((t) => !leaveOut(['runner/src/upstream.ts']).includes(t));
  assert.ok(kept.includes('test/unit/upstream-releases.test.ts'), kept.join(' '));
  assert.ok(closure('runner/test/unit/upstream-releases.test.ts').has('runner/src/upstream.ts'));
  // A test file itself changing runs it.
  assert.ok(!leaveOut(['runner/test/unit/perf-lock.test.ts']).includes('test/unit/perf-lock.test.ts'));
});

test('a change to anything run as a program, or nothing changed, runs them all', () => {
  assert.deepEqual(leaveOut(['scripts/check-remote.sh']), []);
  assert.deepEqual(leaveOut(['check.sh']), []);
  assert.deepEqual(leaveOut(['runner/scripts/deploy-runner.sh']), []);
  assert.deepEqual(leaveOut([]), []);
});
