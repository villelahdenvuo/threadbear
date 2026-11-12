import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelLabel } from '../../../web/src/format.ts';

test("the website's model names: a dated id shows its version, not the date", () => {
  assert.equal(modelLabel('claude', 'claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(modelLabel('claude', 'claude-haiku-5-5[1m]'), 'Claude Haiku 5.5');
  assert.equal(modelLabel('claude', 'opus'), 'Claude Opus');
  assert.equal(modelLabel('claude', 'claude-sonnet-4-20250514'), 'Claude Sonnet 4');
  assert.equal(modelLabel('claude', 'claude-opus-4-1-20250805'), 'Claude Opus 4.1');
  assert.equal(modelLabel('codex', 'gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(modelLabel('codex'), 'Codex');
});
