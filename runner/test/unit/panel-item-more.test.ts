import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MORE_ITEMS_KEPT, panelItem } from '../../src/patches.ts';

// A list row's folded rows (docs/protocol.md, PanelItem's `more`): the PRs
// panel folds the other threads that mention a PR under its row.
test("a list row keeps its folded rows, one level deep, without their sections", () => {
  const row = panelItem({
    title: 'ecom-api#4940',
    detail: 'CI pass',
    more: {
      label: '  Also in 2 other threads ',
      items: [
        { title: 'AT Desk', url: 'threadbear://thread/a', section: 'ignored', more: { label: 'x', items: [{ title: 'deeper' }] } },
        'PRs panel misses PRs',
        { detail: 'no title, dropped' },
      ],
    },
  });
  assert.deepEqual(row, {
    title: 'ecom-api#4940',
    detail: 'CI pass',
    more: { label: 'Also in 2 other threads', items: [{ title: 'AT Desk', url: 'threadbear://thread/a' }, { title: 'PRs panel misses PRs' }] },
  });
});

test('a `more` with no label or no rows left is dropped, and at most 50 rows are kept', () => {
  assert.deepEqual(panelItem({ title: 'a', more: { label: ' ', items: [{ title: 'b' }] } }), { title: 'a' });
  assert.deepEqual(panelItem({ title: 'a', more: { label: 'More', items: [{ detail: 'x' }] } }), { title: 'a' });
  assert.deepEqual(panelItem({ title: 'a', more: 'nope' }), { title: 'a' });
  const many = panelItem({ title: 'a', more: { label: 'More', items: Array.from({ length: 80 }, (_, i) => ({ title: `r${i}` })) } });
  assert.equal(many?.more?.items.length, MORE_ITEMS_KEPT);
});

test('a list row keeps the ready and blocked tones, and drops one it does not know', () => {
  assert.equal(panelItem({ title: 'a', tone: 'ready' })?.tone, 'ready');
  assert.equal(panelItem({ title: 'a', tone: 'blocked' })?.tone, 'blocked');
  assert.equal(panelItem({ title: 'a', tone: 'loud' })?.tone, undefined);
});
