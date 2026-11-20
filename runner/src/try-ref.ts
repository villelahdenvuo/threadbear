// `tb try`: a thread's branch in the running runner and app before it lands.
// Ville, 20 Nov 2026: a change to Threadbear should be in his app for him to
// try within a couple of minutes, and its checks run only once he has seen
// it and said land it. A landing's check takes 15 to 30 minutes, and the
// runner and the app only ever followed main.
//
// The try is one ref in the repo, refs/threadbear/try, which every worktree
// shares. While it's set and main doesn't have its commit, the runner's
// updater (update.ts) builds it in place of main, leaving the checks out, and
// the app (desktop/gpui/src/app_update.rs) builds its desktop/ at normal
// priority with no ten-minute wait. Beside it in the git folder,
// threadbear-try.json says which branch it came from, so the landing of that
// branch ends the try (worktrees.ts), as does main getting its commit. Then
// both follow main again.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const TRY_REF = 'refs/threadbear/try';
export const TRY_FILE = 'threadbear-try.json';

export type TryInfo = { commit: string; branch?: string; thread?: string; at?: string };

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (e, stdout, stderr) => resolve({ ok: !e, out: String(stdout).trim(), err: String(stderr).trim() }));
  });
}

async function commonDir(checkout: string): Promise<string | undefined> {
  const r = await git(checkout, ['rev-parse', '--git-common-dir']);
  return r.ok ? path.resolve(checkout, r.out) : undefined;
}

/** The try as it's set, whether main has it yet or not. */
export async function readTry(checkout: string): Promise<TryInfo | undefined> {
  const r = await git(checkout, ['rev-parse', '--verify', '-q', `${TRY_REF}^{commit}`]);
  if (!r.ok || !r.out) return undefined;
  const common = await commonDir(checkout);
  let note: Partial<TryInfo> = {};
  try {
    if (common) note = JSON.parse(fs.readFileSync(path.join(common, TRY_FILE), 'utf8')) as Partial<TryInfo>;
  } catch {
    // no note: a try set by hand with git update-ref
  }
  return { ...note, commit: r.out };
}

/** The try to build in place of main, or none. One main already has
 *  (it landed as it was) is ended here. */
export async function activeTry(checkout: string, main = 'refs/heads/main'): Promise<TryInfo | undefined> {
  const t = await readTry(checkout);
  if (!t) return undefined;
  if ((await git(checkout, ['merge-base', '--is-ancestor', t.commit, main])).ok) {
    await endTry(checkout);
    return undefined;
  }
  return t;
}

/** Sets the try to `commit` (from `branch`, for `thread`). */
export async function setTry(checkout: string, commit: string, note: Omit<TryInfo, 'commit'>): Promise<void> {
  const r = await git(checkout, ['update-ref', '-m', `tb try${note.branch ? ` ${note.branch}` : ''}`, TRY_REF, commit]);
  if (!r.ok) throw new Error(r.err || 'git update-ref failed');
  const common = await commonDir(checkout);
  if (common) fs.writeFileSync(path.join(common, TRY_FILE), JSON.stringify({ commit, ...note }, null, 1) + '\n');
}

/** Ends the try, or only one from `branch` when it's given. True if one ended. */
export async function endTry(checkout: string, branch?: string): Promise<boolean> {
  const t = await readTry(checkout);
  if (!t || (branch !== undefined && t.branch !== branch)) return false;
  await git(checkout, ['update-ref', '-d', TRY_REF]);
  const common = await commonDir(checkout);
  if (common) fs.rmSync(path.join(common, TRY_FILE), { force: true });
  return true;
}
