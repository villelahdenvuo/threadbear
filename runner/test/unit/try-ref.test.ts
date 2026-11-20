import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeTry, endTry, readTry, setTry } from '../../src/try-ref.ts';

function repo(): { dir: string; git: (...a: string[]) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-try-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  return { dir, git };
}

test('a try stands until main has its commit, or its branch lands, or it is ended', async () => {
  const { dir, git } = repo();
  assert.equal(await readTry(dir), undefined);
  git('switch', '-q', '-c', 'thread/a');
  git('commit', '-q', '--allow-empty', '-m', 'two');
  const two = git('rev-parse', 'HEAD');
  await setTry(dir, two, { branch: 'thread/a', thread: 't1', at: 'now' });
  assert.deepEqual(await activeTry(dir), { commit: two, branch: 'thread/a', thread: 't1', at: 'now' });
  // Another branch's landing doesn't end it.
  assert.equal(await endTry(dir, 'thread/b'), false);
  assert.equal((await activeTry(dir))?.commit, two);
  // Main getting its commit does.
  git('switch', '-q', 'main');
  git('merge', '-q', '--ff-only', 'thread/a');
  assert.equal(await activeTry(dir), undefined);
  assert.equal(await readTry(dir), undefined);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'threadbear-try.json')), false);
  // And so does its branch landing (rebased, so main hasn't this very commit).
  git('commit', '-q', '--allow-empty', '-m', 'three');
  await setTry(dir, git('rev-parse', 'HEAD~1'), { branch: 'thread/a' });
  git('switch', '-q', '-c', 'thread/c', 'HEAD~1');
  git('commit', '-q', '--allow-empty', '-m', 'four');
  await setTry(dir, git('rev-parse', 'HEAD'), { branch: 'thread/c' });
  assert.equal(await endTry(dir, 'thread/c'), true);
  assert.equal(await readTry(dir), undefined);
});
