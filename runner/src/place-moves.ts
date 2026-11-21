// The line a thread's transcript gets when it moves between the inbox,
// hibernating and the archive, so it's clear when that happened and who
// did it (docs/protocol/threads.md, "Moves in the transcript"). Ville asked for it
// on 20 Nov 2026: a thread back in the inbox said nothing about having
// been away, or why it came back.

import type { MessageOrigin, MoveBy, ThreadPlace } from './protocol.ts';
import { sentByAgent } from './protocol.ts';
import { awayFor, localWhen } from './wake-when.ts';

// snoozedUntil as threads.update takes it: an ISO time, 'restart' or 'release'.
function untilWords(until: string, timeZone: string): string {
  if (until === 'restart') return 'the runner next starts';
  if (until === 'release') return 'the runner starts on a new release';
  return localWhen(Date.parse(until), timeZone);
}

function whoBy(by: MoveBy): string {
  return by === 'mike' ? 'you' : by === 'agent' ? 'an agent' : by === 'schedule' ? 'a schedule' : by === 'thread' ? 'another thread' : 'Threadbear';
}

// threads.update putting it away or bringing it back. `awayMs`: how long
// it hibernated, for a wake.
export function updateMoveText(m: { from: ThreadPlace; to: ThreadPlace; by: MoveBy; until?: string; awayMs?: number }, timeZone: string): string {
  const who = whoBy(m.by);
  if (m.to === 'hibernating') {
    const until = m.until ? ` until ${untilWords(m.until, timeZone)}` : '';
    return m.from === 'hibernating' ? `Wake time changed by ${who}${m.until ? ` to ${untilWords(m.until, timeZone)}` : ''}.` : `Hibernated by ${who}${until}.`;
  }
  if (m.to === 'archived') return `Archived by ${who}.`;
  if (m.from === 'archived') return `Unarchived by ${who}.`;
  const away = m.awayMs && m.awayMs >= 60_000 ? ` after ${awayFor(m.awayMs)}` : '';
  return `Woken by ${who}${away}.`;
}

// Who a message is from, as a move's `by`.
export function messageBy(text: string, origin: MessageOrigin | undefined): MoveBy {
  if (origin === 'schedule') return 'schedule';
  if (origin === 'runner') return 'threadbear';
  return sentByAgent(text) ? 'thread' : 'mike';
}

// A message bringing a hibernating or archived thread back (threads.send).
export function messageMoveText(from: ThreadPlace, by: MoveBy, origin: MessageOrigin | undefined, awayMs: number | undefined): string {
  const what = by === 'schedule' ? 'a scheduled message' : by === 'thread' ? 'a message from another thread' : by === 'threadbear' ? 'a message from Threadbear' : origin === 'phone' ? 'your message from the phone' : 'your message';
  if (from === 'archived') return `Back from the archive for ${what}.`;
  const away = awayMs && awayMs >= 60_000 ? ` after ${awayFor(awayMs)}` : '';
  return `Woke up${away} for ${what}.`;
}
