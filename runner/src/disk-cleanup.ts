// Frees the disk Threadbear's own build output takes, before a full disk
// breaks things (the diskCleanup experiment). On 25 Nov 2026 Ville's Mac got
// down to 564 MB free and the runner's update to main failed twice, its unit
// tests dying partway. Most of the disk was his, but about 13 GB was
// desktop/target in thread worktrees no thread was using, and 8 GB more was
// in ~/Library/Caches/Threadbear (update-desktop, check-desktop-target,
// ios-builds). Another thread cleared them by hand, and deleted slot-1's
// target while a `tb land` ran there: a worktree can look idle and still be
// in use. So every folder here is cleared only when nothing uses it.
//
// What it clears, and only that:
// - In each worktree slot (<repo>-threads/slot-<n>), a build folder at most
//   two levels down that cargo marked as a cache (CACHEDIR.TAG) and git
//   ignores, never one the patch's `keep` names: in a spare at once (the
//   next thread to claim it would wipe it anyway, worktrees.ts reuse), in
//   an archived thread's kept worktree once quiet, and in an open thread's
//   once it's been idle OPEN_IDLE_MS (OPEN_IDLE_LOW_MS when the disk is
//   low). Never in a borrow, a folder switched by hand, or the main checkout.
// - In the cache folder, update-desktop/target, check-desktop-target and
//   ios-builds/<each>, and check.sh's shared-<n> folders in
//   ~/.cache/threadbear-check/local-builds (sharedBuilds): once untouched
//   for CACHE_AGE_MS, or at once when the disk is low.
//
// Nothing is cleared while a process has its current folder in the
// worktree, cargo holds the target's build lock, a build holds Threadbear's
// build lock (ios-builds), an update build holds its lock (update-desktop),
// or anything in it was written in the last QUIET_MS. Each folder is
// checked, then renamed aside at once, then deleted, as clearBuildCaches
// does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { processCwds, pidAlive } from './borrows.ts';
import { claimsOf, readSlots, type ReadSlot } from './slot.ts';
import { git, realpath, SPARE, type WorktreeRecord } from './worktrees.ts';
import type { Logger } from './log.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GB = 2 ** 30;

// Under this much free on the home folder's disk, everything not in use goes.
export const LOW_FREE_BYTES = 10 * GB;
// A low-disk cleanup stops once this much is free again.
export const ENOUGH_FREE_BYTES = 20 * GB;
export const CACHE_AGE_MS = 7 * DAY;
export const OPEN_IDLE_MS = 2 * DAY;
export const OPEN_IDLE_LOW_MS = 2 * HOUR;
export const QUIET_MS = 30 * MINUTE;
const LOW_CHECK_MS = 10 * MINUTE;

// cargo's, and every CACHEDIR.TAG's (bford.info/cachedir).
const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';
export const CLEARING = '.threadbear-clearing-';

export type ThreadLike = {
  id: string;
  archivedAt?: string;
  status?: string;
  lastActivityAt?: string;
  worktree?: WorktreeRecord;
};

export type Why = 'hourly' | 'low disk' | 'before a build';

export type CleanerDeps = {
  home: string;
  log: Logger;
  // Only the runner on this Mac's real data dir cleans; a dev runner's
  // threads aren't the ones that built.
  enabled: boolean;
  // experimentOn(home, 'diskCleanup'), read each time.
  on: () => boolean;
  records: () => ThreadLike[];
  // Replaced in tests.
  cacheRoot?: string;
  sharedBuildsRoot?: string;
  now?: () => number;
  freeBytes?: () => number | undefined;
  cwds?: () => Promise<string[] | undefined>;
  // Whether another process holds a lock file (flock); undefined when it
  // can't be told, which counts as held.
  lockHeld?: (file: string) => Promise<boolean | undefined>;
  // Renames from to to while holding the lock file, without waiting; false
  // when the lock is taken or the rename fails.
  underLock?: (lock: string, from: string, to: string) => Promise<boolean>;
};

export type Cleared = { path: string; why: string };

export function defaultCacheRoot(): string {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'Threadbear')
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'threadbear');
}

// check.sh's shared cargo folders on a Mac with no check host
// (desktop/scripts/shared-cargo/cargo): shared-<n>/ (src and target), each
// held by an flock on shared-<n>.lock for the whole build.
export function defaultSharedBuildsRoot(): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'threadbear-check', 'local-builds');
}

function statfsFree(dir: string): number | undefined {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}

// flock-style, as cargo (.cargo-lock) and one-build.sh take them: a try
// with no wait. -k keeps the file, which lockf would otherwise unlink.
export function lockHeldByOther(file: string): Promise<boolean | undefined> {
  if (!fs.existsSync(file)) return Promise.resolve(false);
  const probe: [string, string[]] | undefined =
    process.platform === 'darwin' ? ['/usr/bin/lockf', ['-k', '-s', '-t', '0', file, 'true']]
    : process.platform === 'linux' ? ['flock', ['-n', file, 'true']]
    : undefined;
  if (!probe) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(probe[0], probe[1], { timeout: 10_000 }, (err) => {
      if (!err) return resolve(false);
      const code = (err as { code?: unknown }).code;
      // lockf: 75 (EX_TEMPFAIL); flock -n: 1. A missing tool can't tell.
      resolve(code === 'ENOENT' ? undefined : true);
    });
  });
}

// A rename under the lock, as lockHeldByOther probes it.
export function moveUnderLock(lock: string, from: string, to: string): Promise<boolean> {
  const run: [string, string[]] | undefined =
    process.platform === 'darwin' ? ['/usr/bin/lockf', ['-k', '-s', '-t', '0', lock, '/bin/mv', from, to]]
    : process.platform === 'linux' ? ['flock', ['-n', lock, 'mv', from, to]]
    : undefined;
  if (!run) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(run[0], run[1], { timeout: 60_000 }, (err) => resolve(!err && !fs.existsSync(from)));
  });
}

function isRealDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory() && realpath(p) === path.resolve(p);
  } catch {
    return false;
  }
}

function mtime(p: string): number {
  try {
    return fs.lstatSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// The newest change to the folder, its entries and theirs (cargo adds files
// under debug/deps, debug/.fingerprint and the like as it builds). Two
// levels only: a target holds hundreds of thousands of files.
export function lastWritten(dir: string): number {
  let last = mtime(dir);
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n);
      last = Math.max(last, mtime(p));
      if (depth < 2 && isRealDir(p)) walk(p, depth + 1);
    }
  };
  walk(dir, 1);
  return last;
}

function isCacheDir(dir: string): boolean {
  try {
    const fd = fs.openSync(path.join(dir, 'CACHEDIR.TAG'), 'r');
    try {
      const buf = Buffer.alloc(CACHEDIR_SIGNATURE.length);
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8') === CACHEDIR_SIGNATURE;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

const SKIP = new Set(['node_modules', '.git']);

function topFolders(wt: string): string[] {
  try {
    return fs.readdirSync(wt).filter((n) => !SKIP.has(n) && !n.startsWith('.') && isRealDir(path.join(wt, n)));
  } catch {
    return [];
  }
}

// Cargo-made build folders in a worktree, one or two levels down
// (`target`, `desktop/target`), relative to it.
export function findBuildFolders(wt: string): string[] {
  const out: string[] = [];
  for (const a of topFolders(wt)) {
    const pa = path.join(wt, a);
    if (isCacheDir(pa)) {
      out.push(a);
      continue;
    }
    for (const b of topFolders(pa)) {
      if (isCacheDir(path.join(pa, b))) out.push(`${a}/${b}`);
    }
  }
  return out;
}

function holds(folders: Iterable<string>, dir: string): boolean {
  for (const f of folders) if (f === dir || f.startsWith(dir + path.sep)) return true;
  return false;
}

export class DiskCleaner {
  private running: Promise<Cleared[]> | undefined;
  private readonly cacheRoot: string;
  private readonly sharedBuildsRoot: string;
  private readonly deps: CleanerDeps;

  constructor(deps: CleanerDeps) {
    this.deps = deps;
    this.cacheRoot = deps.cacheRoot ?? defaultCacheRoot();
    this.sharedBuildsRoot = deps.sharedBuildsRoot ?? defaultSharedBuildsRoot();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private free(): number | undefined {
    return (this.deps.freeBytes ?? (() => statfsFree(this.deps.home)))();
  }

  private lockHeld(file: string): Promise<boolean | undefined> {
    return (this.deps.lockHeld ?? lockHeldByOther)(file);
  }

  // Cleans if the disk is low; the update calls it before every build.
  async ifLow(why: Why = 'low disk'): Promise<Cleared[]> {
    if (!this.deps.enabled || !this.deps.on()) return [];
    const free = this.free();
    if (free === undefined || free >= LOW_FREE_BYTES) return [];
    return this.sweep(why);
  }

  // One cleanup; a second asked for meanwhile waits for it.
  sweep(why: Why): Promise<Cleared[]> {
    if (!this.deps.enabled || !this.deps.on()) return Promise.resolve([]);
    if (this.running) return this.running;
    const run = this.sweepNow(why).finally(() => {
      if (this.running === run) this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async sweepNow(why: Why): Promise<Cleared[]> {
    const before = this.free();
    const low = before !== undefined && before < LOW_FREE_BYTES;
    const cleared: Cleared[] = [];
    const enough = () => low && (this.free() ?? 0) >= ENOUGH_FREE_BYTES;
    // Cheapest to lose first: what nobody will use again, then what costs
    // one rebuild, then what every landing's check builds on.
    const steps: (() => Promise<void>)[] = [
      () => this.worktrees(low, cleared, 'idle'),
      () => this.caches(low, cleared, ['ios-builds', 'update-desktop']),
      () => this.worktrees(low, cleared, 'open'),
      () => this.caches(low, cleared, ['check-desktop-target']),
      () => this.sharedBuilds(low, cleared),
    ];
    for (const step of steps) {
      if (enough()) break;
      try {
        await step();
      } catch (e) {
        this.deps.log.warn('disk cleanup step failed', { error: String(e) });
      }
    }
    const after = this.free();
    if (cleared.length) this.deps.log.info('cleared build output to free disk', { why, low, freeBefore: before, freeAfter: after, cleared });
    else if (low) this.deps.log.warn('disk is low and no build output could be cleared', { why, free: before });
    return cleared;
  }

  // Renamed aside right after `stillOk`, nothing awaited between, then deleted.
  private async clear(dir: string, stillOk: () => boolean, why: string, cleared: Cleared[]): Promise<void> {
    if (!isRealDir(dir) || !stillOk()) return;
    const aside = path.join(path.dirname(dir), `${CLEARING}${path.basename(dir)}-${this.now()}`);
    try {
      fs.renameSync(dir, aside);
    } catch {
      return;
    }
    cleared.push({ path: dir, why });
    await fs.promises.rm(aside, { recursive: true, force: true }).catch(() => undefined);
  }

  // What a cargo target needs to be left alone: its build lock taken, or
  // written lately.
  private async targetBusy(dir: string): Promise<boolean> {
    if (this.now() - lastWritten(dir) < QUIET_MS) return true;
    let profiles: string[] = [];
    try {
      profiles = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, '.cargo-lock')));
    } catch {
      return true;
    }
    for (const p of profiles) if ((await this.lockHeld(path.join(dir, p, '.cargo-lock'))) !== false) return true;
    return false;
  }

  // Leftovers of a cleanup the runner stopped partway.
  private async leftovers(dir: string): Promise<void> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.startsWith(CLEARING));
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      if (isRealDir(p) && this.now() - mtime(p) > HOUR) await fs.promises.rm(p, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // 'idle': spares and archived threads' kept worktrees. 'open': open
  // threads' worktrees, idle long enough.
  private async worktrees(low: boolean, cleared: Cleared[], which: 'idle' | 'open'): Promise<void> {
    const records = this.deps.records();
    const byId = new Map(records.map((r) => [r.id, r]));
    const mains = new Set<string>();
    const keeps = new Map<string, Set<string>>();
    for (const r of records) {
      const w = r.worktree;
      if (!w?.mainCheckout) continue;
      mains.add(w.mainCheckout);
      const k = keeps.get(w.mainCheckout) ?? new Set<string>();
      for (const x of w.keep ?? []) k.add(x.replace(/^\/+|\/+$/g, ''));
      keeps.set(w.mainCheckout, k);
    }
    const claims = claimsOf(records);
    let cwds: string[] | undefined;
    for (const main of mains) {
      const slots = await readSlots(main, claims).catch(() => undefined);
      if (!slots) continue;
      for (const s of slots) {
        const ok = this.eligible(s, which, low, byId);
        if (!ok || !s.admin) continue;
        const wt = realpath(s.checkout.path);
        const found = findBuildFolders(wt).filter((rel) => !keeps.get(main)?.has(rel));
        await this.leftovers(wt);
        for (const sub of topFolders(wt)) await this.leftovers(path.join(wt, sub));
        if (!found.length) continue;
        cwds ??= (await (this.deps.cwds ?? processCwds)())?.map((c) => realpath(c));
        // A list that can't be read in full may miss the very process at work.
        if (!cwds) return;
        if (holds(cwds, wt)) continue;
        for (const rel of found) {
          const dir = path.join(wt, rel);
          // Only what git ignores: never a tracked folder that happens to
          // look like a cache.
          if (!(await git(wt, ['check-ignore', '-q', '--', rel])).ok) continue;
          if (await this.targetBusy(dir)) continue;
          const admin = s.admin;
          await this.clear(dir, () => ok.still(admin), ok.why, cleared);
        }
      }
    }
  }

  // Whether a slot's build output may go, with the check made again right
  // before each folder goes.
  private eligible(s: ReadSlot, which: 'idle' | 'open', low: boolean, byId: Map<string, ThreadLike>):
    { why: string; still: (admin: string) => boolean } | undefined {
    const is = s.is;
    if (which === 'idle' && is.kind === 'spare') {
      return { why: 'a spare worktree', still: (admin) => readText(path.join(admin, 'locked'))?.trim() === SPARE };
    }
    if (is.kind !== 'held') return undefined;
    const branch = s.snapshot.branch;
    const onBranch = (admin: string) => readText(path.join(admin, 'HEAD'))?.trim() === `ref: refs/heads/${branch}`;
    if (which === 'idle' && is.archived) {
      return { why: 'an archived thread’s worktree', still: (admin) => onBranch(admin) && Boolean(this.deps.records().find((r) => r.id === is.thread)?.archivedAt) };
    }
    if (which === 'open' && !is.archived) {
      const idleFor = low ? OPEN_IDLE_LOW_MS : OPEN_IDLE_MS;
      const idle = (r: ThreadLike | undefined) =>
        Boolean(r) && !r!.archivedAt && r!.status !== 'running' && r!.status !== 'starting' &&
        this.now() - Date.parse(r!.lastActivityAt ?? '') >= idleFor;
      if (!idle(byId.get(is.thread))) return undefined;
      return { why: `an open thread idle over ${Math.round(idleFor / HOUR)} hours`, still: (admin) => onBranch(admin) && idle(this.deps.records().find((r) => r.id === is.thread)) };
    }
    return undefined;
  }

  private async caches(low: boolean, cleared: Cleared[], which: string[]): Promise<void> {
    const root = this.cacheRoot;
    if (!isRealDir(root)) return;
    await this.leftovers(root);
    const old = (dir: string) => low || this.now() - lastWritten(dir) >= CACHE_AGE_MS;
    const why = low ? 'the disk was low' : `unused for ${Math.round(CACHE_AGE_MS / DAY)} days`;
    for (const name of which) {
      if (name === 'check-desktop-target') {
        const dir = path.join(root, name);
        if (isRealDir(dir) && isCacheDir(dir) && old(dir) && !(await this.targetBusy(dir))) await this.clear(dir, () => true, why, cleared);
      } else if (name === 'update-desktop') {
        await this.updateDesktop(path.join(root, name), old, why, cleared);
      } else if (name === 'ios-builds') {
        const dir = path.join(root, name);
        if (!isRealDir(dir)) continue;
        // sim.sh, install-phone.sh and the nightly build hold it (one-build.sh).
        if ((await this.lockHeld(path.join(root, 'build.lock'))) !== false) continue;
        await this.leftovers(dir);
        let names: string[] = [];
        try {
          names = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'appstore');
        } catch {
          continue;
        }
        for (const n of names) {
          const d = path.join(dir, n);
          if (isRealDir(d) && old(d) && this.now() - lastWritten(d) >= QUIET_MS) await this.clear(d, () => true, why, cleared);
        }
      }
    }
  }

  // Each shared-<n> folder check.sh builds in, while its lock is free: the
  // lock is held for a whole build, so a free one is a folder nobody builds
  // in. The next check copies its src again and builds from cold.
  private async sharedBuilds(low: boolean, cleared: Cleared[]): Promise<void> {
    const root = this.sharedBuildsRoot;
    if (!isRealDir(root)) return;
    await this.leftovers(root);
    const why = low ? 'the disk was low' : `unused for ${Math.round(CACHE_AGE_MS / DAY)} days`;
    let names: string[] = [];
    try {
      names = fs.readdirSync(root).filter((n) => /^shared-\d+$/.test(n));
    } catch {
      return;
    }
    for (const n of names) {
      const dir = path.join(root, n);
      if (!isRealDir(dir)) continue;
      const age = this.now() - lastWritten(dir);
      if (!(low || age >= CACHE_AGE_MS) || age < QUIET_MS) continue;
      if ((await this.lockHeld(`${dir}.lock`)) !== false) continue;
      // Moved aside holding its lock, so no build can take it in between.
      const aside = path.join(root, `${CLEARING}${n}-${this.now()}`);
      if (!(await (this.deps.underLock ?? moveUnderLock)(`${dir}.lock`, dir, aside))) continue;
      cleared.push({ path: dir, why });
      await fs.promises.rm(aside, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // stage-update.sh's target, under its own lock (a folder with the pid of
  // the run that has it), so no update build starts while it's moved aside.
  private async updateDesktop(cache: string, old: (dir: string) => boolean, why: string, cleared: Cleared[]): Promise<void> {
    const target = path.join(cache, 'target');
    if (!isRealDir(target) || !isCacheDir(target) || !old(target) || (await this.targetBusy(target))) return;
    const lock = path.join(cache, 'lock');
    const holder = Number(readText(path.join(lock, 'pid'))?.trim());
    if (fs.existsSync(lock) && Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return;
    if (fs.existsSync(lock) && !(Number.isInteger(holder) && holder > 0)) {
      // A lock just made, its pid not written yet: a build is starting.
      if (this.now() - mtime(lock) < MINUTE) return;
    }
    fs.rmSync(lock, { recursive: true, force: true });
    try {
      fs.mkdirSync(lock);
    } catch {
      return;
    }
    let moved: string | undefined;
    try {
      fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
      if (isRealDir(target)) {
        moved = path.join(cache, `${CLEARING}target-${this.now()}`);
        fs.renameSync(target, moved);
      }
    } catch {
      moved = undefined;
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    if (!moved) return;
    cleared.push({ path: target, why });
    await fs.promises.rm(moved, { recursive: true, force: true }).catch(() => undefined);
  }

  // Five minutes after start, then hourly; a look at free disk every ten.
  start(): () => void {
    const run = (why: Why) => void (why === 'hourly' ? this.sweep(why) : this.ifLow(why)).catch((e: unknown) => this.deps.log.warn('disk cleanup failed', { error: String(e) }));
    const first = setTimeout(() => run('hourly'), 5 * MINUTE);
    const hourly = setInterval(() => run('hourly'), HOUR);
    const low = setInterval(() => run('low disk'), LOW_CHECK_MS);
    for (const t of [first, hourly, low]) t.unref();
    return () => {
      clearTimeout(first);
      clearInterval(hourly);
      clearInterval(low);
    };
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
