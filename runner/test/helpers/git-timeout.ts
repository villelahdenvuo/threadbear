// Loaded before every unit test file, through clean-env.ts. A git run with
// execFileSync, spawnSync or execSync blocks the test's whole process, so
// --test-timeout's timer never fires while it waits: one stuck git held a
// landing's check for half an hour at 0% CPU (11 Nov 2026). Here a sync git
// run with no timeout of its own gets GIT_TIMEOUT_MS, so it is killed and
// the test fails instead. That covers the code under test as well as the
// tests' own helpers. Real runs of the runner are not touched.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// TB_TEST_GIT_TIMEOUT_MS is for git-timeout.test.ts.
export const GIT_TIMEOUT_MS = Number(process.env.TB_TEST_GIT_TIMEOUT_MS) || 60_000;

type Options = { timeout?: number } & Record<string, unknown>;

function isGit(file: unknown): boolean {
  return typeof file === 'string' && (file === 'git' || file.endsWith('/git'));
}

function withTimeout(options: unknown): Options {
  const o = (options && typeof options === 'object' ? options : {}) as Options;
  return o.timeout ? o : { ...o, timeout: GIT_TIMEOUT_MS };
}

// (file, args?, options?): options move up a place when args are left out.
function wrapFileCall<F extends (...a: any[]) => any>(real: F): F {
  return function (this: unknown, file: unknown, ...rest: unknown[]) {
    if (!isGit(file)) return real.call(this, file, ...rest);
    if (Array.isArray(rest[0]) || (rest[0] == null && rest.length > 1)) return real.call(this, file, rest[0] ?? [], withTimeout(rest[1]));
    return real.call(this, file, withTimeout(rest[0]));
  } as F;
}

const realExecSync = childProcess.execSync;
childProcess.execFileSync = wrapFileCall(childProcess.execFileSync);
childProcess.spawnSync = wrapFileCall(childProcess.spawnSync);
childProcess.execSync = function (command: string, options?: Options) {
  return /^\s*git\s/.test(command) ? realExecSync(command, withTimeout(options) as never) : realExecSync(command, options as never);
} as typeof childProcess.execSync;
// `import { execFileSync } from 'node:child_process'` reads these bindings.
syncBuiltinESMExports();
