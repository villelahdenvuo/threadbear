import fs from 'node:fs';
import path from 'node:path';
import { processInfo } from './proc.ts';

// One runner per data dir. A second one (`npm start` while the LaunchAgent
// runs, say) would sweep the first one's CLIs as orphans and append to the
// same event logs, so it has to stop before it touches anything.
// run/runner.pid holds the owner's pid and start time; a lock whose owner
// is gone, or whose pid now belongs to another process, is taken over.
//
// The file is written whole beside it and linked into place, so it's never
// seen empty: a runner that read it between the create and the write took
// that for "no holder", deleted it and took the lock too. A file that still
// can't be read (an older runner's, mid-write) is waited on for a moment.
export type Lock = { release(): void };

const UNREADABLE_GRACE_MS = 2000;

export function acquireLock(runDir: string): Lock | { heldBy: number } {
  const file = path.join(runDir, 'runner.pid');
  const me = { pid: process.pid, lstart: processInfo(process.pid)?.lstart ?? '' };
  fs.mkdirSync(runDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(me) + '\n', { mode: 0o644 });
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        fs.linkSync(tmp, file);
        return {
          release() {
            try {
              if (readHolder(file)?.pid === process.pid) fs.unlinkSync(file);
            } catch {
              // already gone
            }
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const raw = readRaw(file);
      if (raw === undefined) continue; // gone since: try again
      const holder = parseHolder(raw);
      if (holder && holder.pid !== process.pid && holderAlive(holder)) return { heldBy: holder.pid };
      if (!holder && young(file)) {
        sleep(50);
        continue;
      }
      // Stale: take it away only if it's still the one just read, so a
      // lock another runner took over meanwhile isn't removed.
      if (readRaw(file) === raw) fs.rmSync(file, { force: true });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  throw new Error(`Couldn't take the runner lock at ${file}`);
}

function readRaw(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readHolder(file: string): { pid: number; lstart?: string } | null {
  const raw = readRaw(file);
  return raw === undefined ? null : parseHolder(raw);
}

function parseHolder(text: string): { pid: number; lstart?: string } | null {
  try {
    const raw = text.trim();
    // Older runners wrote just the pid.
    if (/^\d+$/.test(raw)) return { pid: Number(raw) };
    const j = JSON.parse(raw) as { pid?: unknown; lstart?: unknown };
    return typeof j.pid === 'number' ? { pid: j.pid, lstart: typeof j.lstart === 'string' ? j.lstart : undefined } : null;
  } catch {
    return null;
  }
}

function young(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < UNREADABLE_GRACE_MS;
  } catch {
    return false;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function holderAlive(h: { pid: number; lstart?: string }): boolean {
  const info = processInfo(h.pid);
  if (!info) return false;
  if (h.lstart) return info.lstart === h.lstart;
  // A runner under launch.mjs (a release) shows as launch.mjs, not main.ts.
  return /main\.ts|launch\.mjs/.test(info.command);
}
