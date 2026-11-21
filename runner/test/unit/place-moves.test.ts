// A thread moving between the inbox, hibernating and the archive leaves one
// line in its transcript saying who moved it (docs/protocol/threads.md, "Moves in
// the transcript").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { messageMoveText, updateMoveText } from '../../src/place-moves.ts';

const DAY = 86_400_000;

function idle() {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Measure', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.result();
  return { h, thread, s };
}

const moves = (h: ReturnType<typeof makeHarness>, id: string) =>
  h.events(id).filter((e) => e.type === 'system.note' && e.move).map((e) => ({ text: String(e.text), move: e.move }));

test('hibernating, waking, archiving and unarchiving by hand each leave one line', async () => {
  const { h, thread } = idle();
  await tick(4);
  const until = new Date(h.clock.now() + DAY).toISOString();
  h.runner.update({ threadId: thread.id, snoozedUntil: until });
  h.clock.advance(2 * 3_600_000);
  h.runner.update({ threadId: thread.id, snoozedUntil: null });
  h.runner.update({ threadId: thread.id, archived: true });
  h.runner.update({ threadId: thread.id, archived: false });
  const got = moves(h, thread.id);
  assert.deepEqual(got.map((m) => m.move), [
    { from: 'inbox', to: 'hibernating', by: 'mike', until },
    { from: 'hibernating', to: 'inbox', by: 'mike' },
    { from: 'inbox', to: 'archived', by: 'mike' },
    { from: 'archived', to: 'inbox', by: 'mike' },
  ]);
  assert.match(got[0].text, /^Hibernated by you until .+\.$/);
  assert.equal(got[1].text, 'Woken by you after 2 hours.');
  assert.equal(got[2].text, 'Archived by you.');
  assert.equal(got[3].text, 'Unarchived by you.');
});

test('an update that changes nothing about where it is leaves no line', async () => {
  const { h, thread } = idle();
  await tick(4);
  h.runner.update({ threadId: thread.id, archived: false });
  h.runner.update({ threadId: thread.id, snoozedUntil: null });
  h.runner.update({ threadId: thread.id, title: 'Renamed' });
  h.runner.update({ threadId: thread.id, archived: true });
  h.runner.update({ threadId: thread.id, archived: true });
  assert.equal(moves(h, thread.id).length, 1);
});

test('a new wake time says so, and an agent archiving says it was an agent', async () => {
  const { h, thread } = idle();
  await tick(4);
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + DAY).toISOString() });
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + 2 * DAY).toISOString(), byAgent: true });
  h.runner.update({ threadId: thread.id, archived: true, archivedBy: 'agent', byAgent: true });
  const got = moves(h, thread.id);
  assert.match(got[1].text, /^Wake time changed by an agent to .+\.$/);
  assert.deepEqual(got[1].move, { from: 'hibernating', to: 'hibernating', by: 'agent', until: new Date(h.clock.now() + 2 * DAY).toISOString() });
  assert.equal(got[2].text, 'Archived by an agent.');
  assert.equal(got[2].move?.from, 'hibernating');
});

test('an archive with a verdict says it once, as the move', async () => {
  const { h, thread } = idle();
  await tick(4);
  h.runner.update({ threadId: thread.id, archived: true, verdict: 'worked' });
  const notes = h.events(thread.id).filter((e) => e.type === 'system.note').map((e) => String(e.text));
  assert.deepEqual(notes.filter((t) => t.startsWith('Archived')), ['Archived by you: it worked.']);
  assert.equal(moves(h, thread.id)[0].text, 'Archived by you: it worked.');
});

test('waking at its time is a move by Threadbear, with how long it was away', async () => {
  const { h, thread } = idle();
  await tick(4);
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + 3 * DAY).toISOString() });
  h.clock.advance(3 * DAY + 1000);
  await tick(4);
  const got = moves(h, thread.id);
  assert.equal(got.length, 2);
  assert.equal(got[1].text, 'Woke up after hibernating for 3 days.');
  assert.deepEqual(got[1].move, { from: 'hibernating', to: 'inbox', by: 'threadbear' });
});

test('a message brings it back with a line naming who sent it, before the message', async () => {
  const { h, thread } = idle();
  await tick(4);
  h.runner.update({ threadId: thread.id, archived: true });
  h.runner.sendScheduled(thread.id, 'Check the nightly run', 'schedule-1', 'slot');
  const evs = h.events(thread.id);
  const note = evs.findIndex((e) => e.type === 'system.note' && e.move?.from === 'archived' && e.move.to === 'inbox');
  assert.ok(note >= 0);
  assert.equal(evs[note].text, 'Back from the archive for a scheduled message.');
  assert.equal(evs[note].move?.by, 'schedule');
  const msg = evs.findIndex((e) => e.type === 'user.message' && /nightly run/.test(String(e.text)));
  assert.ok(msg > note, 'the line comes before the message');
});

test("the agent's end_turn snooze is one line, the agent's own", async () => {
  const { h, thread, s } = idle();
  await tick(4);
  h.runner.send(thread.id, 'go');
  await tick(4);
  const until = new Date(h.clock.now() + DAY).toISOString();
  h.runner.snoozeAfterTurn(h.runner.mustGet(thread.id), until);
  s.result();
  await tick(4);
  const got = moves(h, thread.id).filter((m) => m.move?.to === 'hibernating');
  assert.equal(got.length, 1);
  assert.match(got[0].text, /as the agent was asked to\.$/);
  assert.equal(got[0].move?.by, 'agent');
});

test('the texts', () => {
  const tz = 'Europe/Helsinki';
  assert.equal(updateMoveText({ from: 'inbox', to: 'hibernating', by: 'mike', until: 'restart' }, tz), 'Hibernated by you until the runner next starts.');
  assert.equal(updateMoveText({ from: 'inbox', to: 'archived', by: 'threadbear' }, tz), 'Archived by Threadbear.');
  assert.equal(updateMoveText({ from: 'hibernating', to: 'inbox', by: 'mike', awayMs: 30_000 }, tz), 'Woken by you.');
  assert.equal(messageMoveText('hibernating', 'mike', 'phone', 2 * DAY), 'Woke up after 2 days for your message from the phone.');
  assert.equal(messageMoveText('hibernating', 'thread', undefined, undefined), 'Woke up for a message from another thread.');
});
