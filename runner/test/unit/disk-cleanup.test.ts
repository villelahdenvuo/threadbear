// disk-cleanup.ts: Threadbear clearing its own build output before a full
// disk breaks a build. On 25 Nov 2026 Ville's Mac got down to 564 MB free
// and the runner's update failed; 13 GB of it was desktop/target in thread
// worktrees, and a hand cleanup deleted one while a tb land used it.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DiskCleaner, findBuildFolders, lockHeldByOther, LOW_FREE_BYTES, type CleanerDeps, type ThreadLike } from '../../src/disk-cleanup.ts';
import { nullLogger } from '../../src/log.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { commit, makeRepo, sh } from '../helpers/worktrees-harness.ts';
import { SPARE, type WorktreeRecord } from '../../src/worktrees.ts';

const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { skip: process.platform === 'win32' && 'no process folders on Windows' }, fn);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# made by cargo\n';

// A cargo-looking build folder, last written `age` ago.
function target(dir: string, age = 2 * HOUR): string {
  fs.mkdirSync(path.join(dir, 'debug', 'deps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CACHEDIR.TAG'), TAG);
  fs.writeFileSync(path.join(dir, 'debug', 'deps', 'lib.rlib'), 'x');
  const t = new Date(Date.now() - age);
  for (const p of [path.join(dir, 'debug', 'deps', 'lib.rlib'), path.join(dir, 'debug', 'deps'), path.join(dir, 'debug'), path.join(dir, 'CACHEDIR.TAG'), dir]) fs.utimesSync(p, t, t);
  return dir;
}

function repo() {
  const { root, main } = makeRepo();
  commit(main, { '.gitignore': 'node_modules\n.setup-ran\n.build\ntarget\n' }, 'ignore target');
  const threads = path.join(root, 'proj-threads');
  const slot = (n: number, how: 'spare' | string) => {
    const wt = path.join(threads, `slot-${n}`);
    if (how === 'spare') {
      sh(main, `git worktree add -q --detach ${wt} main && git worktree lock --reason "${SPARE}" ${wt}`);
    } else {
      sh(main, `git worktree add -q -b ${how} ${wt} main`);
    }
    return wt;
  };
  return { root, main, slot };
}

function record(id: string, main: string, wt: string, branch: string, extra: Partial<ThreadLike> = {}): ThreadLike {
  const worktree = { repo: 'proj', path: wt, branch, mainCheckout: main } as unknown as WorktreeRecord;
  return { id, status: 'idle', lastActivityAt: new Date(Date.now() - 3 * DAY).toISOString(), worktree, ...extra };
}

function cleaner(records: ThreadLike[], o: Partial<CleanerDeps> = {}): DiskCleaner {
  return new DiskCleaner({
    home: tmpDir('tb-disk-home-'),
    log: nullLogger,
    enabled: true,
    on: () => true,
    records: () => records,
    cacheRoot: tmpDir('tb-disk-cache-'),
    freeBytes: () => 100 * LOW_FREE_BYTES,
    cwds: async () => [],
    lockHeld: async () => false,
    ...o,
  });
}

test('finds cargo-marked folders one or two levels down, never in node_modules or a dot folder', () => {
  const wt = tmpDir('tb-disk-find-');
  target(path.join(wt, 'target'));
  target(path.join(wt, 'desktop', 'target'));
  target(path.join(wt, 'node_modules', 'x'));
  target(path.join(wt, '.hidden', 'target'));
  fs.mkdirSync(path.join(wt, 'other', 'target'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'other', 'target', 'CACHEDIR.TAG'), 'not the signature\n');
  assert.deepEqual(findBuildFolders(wt).sort(), ['desktop/target', 'target']);
});

test("a spare's and an archived thread's build output goes; an open thread's busy one, a borrow's and the main checkout's stay", async () => {
  const { main, slot } = repo();
  const spare = slot(1, 'spare');
  const archived = slot(2, 'thread/aaaa1111');
  const open = slot(3, 'thread/bbbb2222');
  const byHand = slot(4, 'my-own-branch');
  for (const wt of [spare, archived, open, byHand, main]) target(path.join(wt, 'desktop', 'target'));
  const records = [
    record('a', main, archived, 'thread/aaaa1111', { archivedAt: new Date().toISOString() }),
    // Idle three days, but running a turn right now.
    record('b', main, open, 'thread/bbbb2222', { status: 'running' }),
  ];
  const cleared = await cleaner(records).sweep('hourly');
  assert.deepEqual(cleared.map((c) => c.path).sort(), [path.join(spare, 'desktop', 'target'), path.join(archived, 'desktop', 'target')].sort());
  assert.ok(!fs.existsSync(path.join(spare, 'desktop', 'target')));
  for (const wt of [open, byHand, main]) assert.ok(fs.existsSync(path.join(wt, 'desktop', 'target')), wt);
  // Nothing left aside.
  assert.deepEqual(fs.readdirSync(path.join(spare, 'desktop')).filter((n) => n.startsWith('.threadbear')), []);
});

test("an open thread's goes after two idle days, or two hours when the disk is low", async () => {
  const { main, slot } = repo();
  const wt = slot(1, 'thread/cccc3333');
  target(path.join(wt, 'desktop', 'target'), 3 * HOUR);
  const rec = record('c', main, wt, 'thread/cccc3333', { lastActivityAt: new Date(Date.now() - 3 * HOUR).toISOString() });
  assert.deepEqual(await cleaner([rec]).sweep('hourly'), []);
  const low = await cleaner([rec], { freeBytes: () => LOW_FREE_BYTES - 1 }).ifLow();
  assert.equal(low.length, 1);
  assert.ok(!fs.existsSync(path.join(wt, 'desktop', 'target')));
});

test('nothing goes while in use: a process in the worktree, cargo holding its lock, written lately, tracked by git, or kept by the patch', async () => {
  const { main, slot } = repo();
  const cwdIn = slot(1, 'spare');
  const locked = slot(2, 'spare');
  const fresh = slot(3, 'spare');
  const kept = slot(4, 'spare');
  for (const wt of [cwdIn, locked]) target(path.join(wt, 'desktop', 'target'));
  target(path.join(kept, 'app', 'target'));
  target(path.join(fresh, 'desktop', 'target'), 5 * 60_000);
  fs.writeFileSync(path.join(locked, 'desktop', 'target', 'debug', '.cargo-lock'), '');
  const old = new Date(Date.now() - 2 * HOUR);
  fs.utimesSync(path.join(locked, 'desktop', 'target', 'debug', '.cargo-lock'), old, old);
  fs.utimesSync(path.join(locked, 'desktop', 'target', 'debug'), old, old);
  // A tracked folder that looks like a cache.
  target(path.join(main, 'tracked', 'cache'));
  commit(main, { 'tracked/cache/CACHEDIR.TAG': TAG, 'tracked/cache/debug/deps/lib.rlib': 'x' }, 'tracked cache');
  const trackedWt = slot(5, 'spare');
  const keeper = record('k', main, path.join(path.dirname(main), 'proj-threads', 'gone'), 'thread/dddd4444', { archivedAt: new Date().toISOString() });
  (keeper.worktree as WorktreeRecord).keep = ['app/target'];
  const cleared = await cleaner([keeper], {
    cwds: async () => [path.join(cwdIn, 'desktop')],
    lockHeld: async (f) => f.includes(locked),
  }).sweep('hourly');
  assert.deepEqual(cleared, []);
  for (const wt of [cwdIn, locked, fresh]) assert.ok(fs.existsSync(path.join(wt, 'desktop', 'target')), wt);
  assert.ok(fs.existsSync(path.join(kept, 'app', 'target')));
  assert.ok(fs.existsSync(path.join(trackedWt, 'tracked', 'cache')));
});

test('a process list that cannot be read stops the worktree part', async () => {
  const { slot } = repo();
  const spare = slot(1, 'spare');
  target(path.join(spare, 'desktop', 'target'));
  const { main } = { main: path.join(path.dirname(path.dirname(spare)), 'proj') };
  const rec = record('x', main, path.join(path.dirname(spare), 'none'), 'thread/eeee5555', { archivedAt: new Date().toISOString() });
  assert.deepEqual(await cleaner([rec], { cwds: async () => undefined }).sweep('hourly'), []);
  assert.ok(fs.existsSync(path.join(spare, 'desktop', 'target')));
});

test('build caches go after a week unused, or at once when the disk is low, but not under a live update build or a held build lock', async () => {
  const mk = (age: number) => {
    const root = tmpDir('tb-disk-cache-');
    target(path.join(root, 'check-desktop-target'), age);
    target(path.join(root, 'update-desktop', 'target'), age);
    fs.mkdirSync(path.join(root, 'update-desktop', 'src'));
    fs.mkdirSync(path.join(root, 'ios-builds', 'dd-device', 'Build'), { recursive: true });
    const t = new Date(Date.now() - age);
    for (const p of ['ios-builds/dd-device/Build', 'ios-builds/dd-device']) fs.utimesSync(path.join(root, p), t, t);
    fs.writeFileSync(path.join(root, 'build.lock'), '');
    return root;
  };
  // Two days unused: stays.
  const recent = mk(2 * DAY);
  assert.deepEqual(await cleaner([], { cacheRoot: recent }).sweep('hourly'), []);
  // Eight days: goes, src stays.
  const stale = mk(8 * DAY);
  const cleared = await cleaner([], { cacheRoot: stale }).sweep('hourly');
  assert.deepEqual(cleared.map((c) => path.relative(stale, c.path)).sort(), ['check-desktop-target', 'ios-builds/dd-device', 'update-desktop/target']);
  assert.ok(fs.existsSync(path.join(stale, 'update-desktop', 'src')));
  assert.ok(!fs.existsSync(path.join(stale, 'update-desktop', 'lock')));
  // Low disk: two days old goes too, but a live update build's lock and the
  // build lock keep theirs.
  const busy = mk(2 * DAY);
  fs.mkdirSync(path.join(busy, 'update-desktop', 'lock'));
  fs.writeFileSync(path.join(busy, 'update-desktop', 'lock', 'pid'), `${process.pid}\n`);
  const low = await cleaner([], { cacheRoot: busy, freeBytes: () => LOW_FREE_BYTES - 1, lockHeld: async (f) => f.endsWith('build.lock') }).sweep('low disk');
  assert.deepEqual(low.map((c) => path.relative(busy, c.path)), ['check-desktop-target']);
  assert.ok(fs.existsSync(path.join(busy, 'update-desktop', 'target')));
  assert.ok(fs.existsSync(path.join(busy, 'ios-builds', 'dd-device')));
});

test('off, or not the real data dir: nothing happens', async () => {
  const { slot } = repo();
  const spare = slot(1, 'spare');
  target(path.join(spare, 'desktop', 'target'));
  const main = path.join(path.dirname(path.dirname(spare)), 'proj');
  const rec = record('x', main, path.join(path.dirname(spare), 'none'), 'thread/ffff6666', { archivedAt: new Date().toISOString() });
  assert.deepEqual(await cleaner([rec], { on: () => false }).sweep('hourly'), []);
  assert.deepEqual(await cleaner([rec], { enabled: false, freeBytes: () => 0 }).ifLow(), []);
  assert.ok(fs.existsSync(path.join(spare, 'desktop', 'target')));
});

nodeTest("the lock probe sees cargo's build lock held by another process, and free once it lets go", { skip: !fs.existsSync('/usr/bin/lockf') && !fs.existsSync('/usr/bin/flock') && 'no lockf or flock' }, async () => {
  const file = path.join(tmpDir('tb-disk-lock-'), '.cargo-lock');
  fs.writeFileSync(file, '');
  assert.equal(await lockHeldByOther(file), false);
  const holder = fs.existsSync('/usr/bin/lockf') ? spawn('/usr/bin/lockf', ['-k', file, 'sleep', '30']) : spawn('flock', [file, 'sleep', '30']);
  try {
    let held: boolean | undefined = false;
    for (let i = 0; i < 50 && !held; i++) {
      await new Promise((r) => setTimeout(r, 100));
      held = await lockHeldByOther(file);
    }
    assert.equal(held, true);
  } finally {
    holder.kill('SIGKILL');
  }
  // A file that isn't there is never made, and isn't held.
  assert.equal(await lockHeldByOther(path.join(path.dirname(file), 'none')), false);
  assert.ok(!fs.existsSync(path.join(path.dirname(file), 'none')));
});
