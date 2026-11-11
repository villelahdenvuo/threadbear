// test/helpers/git-timeout.ts: a sync git run that hangs is killed, so the
// test fails rather than holding the whole check up.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HELPER = path.join(import.meta.dirname, '..', 'helpers', 'git-timeout.ts');

// Runs `body` in a fresh node with the helper loaded, a 1 s git timeout, and
// a `git` on PATH that sleeps for 30 s.
function run(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-git-timeout-'));
  fs.writeFileSync(path.join(dir, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const script = `import { execFileSync, execSync, spawnSync } from 'node:child_process';\n${body}`;
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--import', HELPER, '--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TB_TEST_GIT_TIMEOUT_MS: '1000' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...r, ms: Date.now() - started };
}

test('a hanging git is killed in every sync form, args or none', () => {
  const r = run(`
    const out = [];
    const code = (f) => { try { f(); out.push('ran'); } catch (e) { out.push(e.code); } };
    code(() => execFileSync('git', ['status']));
    code(() => execFileSync('git', { stdio: 'pipe' }));
    code(() => execFileSync('git'));
    code(() => execSync('git status', { stdio: 'pipe' }));
    out.push(spawnSync('git', ['status']).error?.code);
    out.push(spawnSync('git', undefined, { stdio: 'pipe' }).error?.code);
    console.log(out.join(' '));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), Array(6).fill('ETIMEDOUT').join(' '));
  assert.ok(r.ms < 15_000, `took ${r.ms} ms`);
});

test('a timeout of its own is kept, and other commands are left alone', () => {
  const r = run(`
    const t0 = Date.now();
    spawnSync('git', ['status'], { timeout: 3000 });
    const ownMs = Date.now() - t0;
    const echo = execFileSync('echo', ['hi'], { encoding: 'utf8' }).trim();
    console.log(ownMs >= 2500 ? 'own' : 'replaced', echo);
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'own hi');
});
