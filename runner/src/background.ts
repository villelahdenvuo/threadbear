import fs from 'node:fs';
import { defaultHome, peekRunnerJson } from './config.ts';

// Builds and tests Threadbear starts itself (the land's check, a new
// worktree's setup, turn hooks like the runner typecheck, the release
// builds) run at macOS's background priority, as Mike asks of everything
// heavy on his M5 ("Heavy compute" in his CLAUDE.md): `taskpolicy -b`
// throttles CPU and disk and keeps it off the cores he's using, and every
// process it starts inherits that. The agent-side hook only adds it to
// commands an agent runs itself, not to what the runner or `tb land`
// spawns, and a land's check once held the load above 24 for ten minutes
// (6 Nov). Elsewhere (Linux, no taskpolicy) the command runs as it is.
//
// runner.json's `"heavyWorkPriority": "low"` runs it under `nice -n 10`
// instead: still behind what you're using, but on every core. A Mac with no
// check host runs each land's check itself, and in the background lane that
// took 45 minutes on a busy Mac (11 Nov).
export const TASKPOLICY = '/usr/sbin/taskpolicy';
export const NICE = '/usr/bin/nice';

export type HeavyWorkPriority = 'background' | 'low';

export function heavyWorkPriority(home = process.env.THREADBEAR_HOME || defaultHome()): HeavyWorkPriority {
  return peekRunnerJson(home).heavyWorkPriority === 'low' ? 'low' : 'background';
}

export function inBackground(
  bin: string,
  args: string[],
  opts: { platform?: NodeJS.Platform; exists?: (p: string) => boolean; priority?: HeavyWorkPriority } = {},
): [string, string[]] {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? fs.existsSync;
  if (platform !== 'darwin') return [bin, args];
  if ((opts.priority ?? heavyWorkPriority()) === 'low') return exists(NICE) ? [NICE, ['-n', '10', bin, ...args]] : [bin, args];
  if (!exists(TASKPOLICY)) return [bin, args];
  return [TASKPOLICY, ['-b', bin, ...args]];
}
