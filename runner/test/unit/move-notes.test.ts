// The Mac draws a move between the inbox, hibernating and the archive as a
// divider with an icon and the time, and a turn the runner's own message
// started with "14 h later · The connection came back". The phones drew the
// move as a plain note and the turn with no divider at all: the mirror kept
// neither the note's `move` nor the message's `wakeReason` (Ville, 23 Nov
// 2026). From backend API 99 both go up and come down to the phone and
// another Mac. These play that through the backend's own functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { relayEvents, type RelayRow } from '../../src/relay.ts';

const OWNER = 'owner-key';
const TOKEN = 'phone-token';
const DAY = 24 * 60 * 60_000;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');

test("a move's note and the runner's reason reach the phone's page", async () => {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  const now = Date.now();
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: now + 100 * DAY, createdAt: now });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07' });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07-done' });
  await call(b.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId: 'A', runnerId: 'laptop000001', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  await call(b.ctx, sync.appendMessages, {
    key: OWNER,
    messages: [
      { threadId: 'A', seq: 1, role: 'assistant', text: 'Done for now.', turn: 'aaaa1111', at: '2026-11-22T20:00:00.000Z' },
      { threadId: 'A', seq: 2, role: 'note', text: 'Hibernated by you.', move: { from: 'inbox', to: 'hibernating', by: 'mike' }, at: '2026-11-22T20:01:00.000Z' },
      { threadId: 'A', seq: 3, role: 'user', text: 'Carry on.', origin: 'runner', wakeReason: 'The connection came back', turn: 'bbbb2222', at: '2026-11-23T10:00:00.000Z' },
      { threadId: 'A', seq: 4, role: 'assistant', text: 'Back.', turn: 'bbbb2222', at: '2026-11-23T10:00:05.000Z' },
    ],
  });
  const rows = (await call(b.ctx, phone.messages, { token: TOKEN, threadId: 'A', tools: true, notes: true })).messages as Record<string, unknown>[];
  assert.deepEqual(rows.find((r) => r.seq === 2)?.move, { from: 'inbox', to: 'hibernating', by: 'mike' });
  assert.equal(rows.find((r) => r.seq === 3)?.wakeReason, 'The connection came back');
  assert.equal(rows.find((r) => r.seq === 4)?.wakeReason, undefined);
});

test('another Mac plays a move row as the move note it was, and keeps why the runner sent its message', () => {
  const at = (s: number) => new Date(Date.parse('2026-11-23T10:00:00Z') + s * 1000).toISOString();
  const rows: RelayRow[] = [
    { seq: 1, role: 'assistant', text: 'Done.', turn: 'aaaa1111', at: at(0) },
    { seq: 2, role: 'note', text: 'Hibernated by you.', move: { from: 'inbox', to: 'hibernating', by: 'mike' }, at: at(1) },
    { seq: 3, role: 'note', text: 'Woke up.', move: { from: 'hibernating', to: 'somewhere', by: 'mike' }, at: at(2) },
    { seq: 4, role: 'user', text: 'Carry on.', origin: 'runner', wakeReason: 'The connection came back', turn: 'bbbb2222', at: at(3) },
  ];
  const ev = relayEvents('t', rows, { runnerId: 'phone', status: 'idle' }, [], false, 'Phone') as Record<string, any>[];
  const notes = ev.filter((e) => e.type === 'system.note');
  assert.deepEqual(notes[0]!.move, { from: 'inbox', to: 'hibernating', by: 'mike' });
  assert.equal(notes[0]!.login, undefined);
  // A place it doesn't know is played as a plain note.
  assert.equal(notes[1]!.move, undefined);
  assert.equal(ev.find((e) => e.type === 'user.message')?.wakeReason, 'The connection came back');
});
