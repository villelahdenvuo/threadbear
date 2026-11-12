import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { makeHarness } from '../helpers/fakes.ts';

// The harness trusts every patch (TRUST_ALL). If it read home patches from
// the real ~/.threadbear, each test thread would run the user's own patches
// with the test's temp data dir. A PRs patch then wrote "no thread mentions
// any PR" into its shared cache on every test run (Ville, 12 Nov 2026).
test("the test harness never loads the real home's patches", () => {
  const h = makeHarness();
  const root = (h.runner as unknown as { panelsRoot?: string }).panelsRoot ?? os.homedir();
  assert.notEqual(root, os.homedir());
  assert.equal(root, h.home);
});
