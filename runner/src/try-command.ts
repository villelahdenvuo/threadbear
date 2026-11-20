// `tb try [off|status]`, in a thread's worktree of Threadbear (try-ref.ts):
// puts the branch's last commit in the running runner and app in place of
// main, before it lands, so Ville can see it in a couple of minutes. By git
// alone: the runner and the app watch the ref.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { endTry, readTry, setTry } from './try-ref.ts';
import { landTargetFromGit } from './worktrees.ts';

export async function tryCommand(args: string[], cwd = process.cwd(), threadId = process.env.THREADBEAR_THREAD_ID): Promise<number> {
  const what = args[0] ?? 'on';
  if (!['on', 'off', 'status'].includes(what) || args.length > 1) {
    console.error('Usage: tb try [off|status]');
    return 2;
  }
  const found = await landTargetFromGit(cwd, threadId);
  if (!found.target) {
    console.error((found.reason ?? '').replace(/tb land/g, 'tb try'));
    return 1;
  }
  const { mainCheckout, branch, path: top } = found.target;
  if (!fs.existsSync(path.join(mainCheckout, 'runner', 'scripts', 'deploy.mjs'))) {
    console.error(`${mainCheckout} isn't Threadbear's checkout: tb try only puts Threadbear's own changes in the running app.`);
    return 1;
  }
  const now = await readTry(mainCheckout);
  if (what === 'status') {
    console.log(now ? `Trying ${now.commit.slice(0, 9)}${now.branch ? ` of ${now.branch}` : ''}${now.at ? ` since ${now.at}` : ''}.` : 'Nothing is being tried: the runner and the app follow main.');
    return 0;
  }
  if (what === 'off') {
    const ended = await endTry(mainCheckout);
    console.log(ended ? 'Ended the try: the runner and the app go back to main.' : 'Nothing was being tried.');
    return 0;
  }
  const commit = execFileSync('git', ['-C', top, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', top, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (now && now.branch && now.branch !== branch) console.log(`(This replaces the try of ${now.branch}.)`);
  await setTry(mainCheckout, commit, { branch, ...(threadId ? { thread: threadId } : {}), at: new Date().toISOString() });
  console.log([
    `Trying ${commit.slice(0, 9)} of ${branch} in place of main.${dirty ? ' Only what is committed goes in: commit the rest and run tb try again.' : ''}`,
    'The runner builds it without its checks (about a minute) and restarts once no thread is busy.',
    'If desktop/ changed, the app builds it at full speed (about 90 seconds) and swaps it in when nobody is typing, or at Restart to Update.',
    'When Ville approves, run tb land: landing this branch ends the try, and its checks run then.',
    'tb try off goes back to main; tb try status says what is being tried.',
  ].join('\n'));
  return 0;
}
