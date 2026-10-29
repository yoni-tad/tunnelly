import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay } from '../src/utils/backoff.js';

const noJitter = { baseMs: 1000, maxMs: 30_000, jitter: 0 };

test('backoff doubles: 1s, 2s, 4s, 8s, 16s', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((a) => backoffDelay(a, noJitter)), [1000, 2000, 4000, 8000, 16000]);
});

test('backoff is capped at the maximum', () => {
  assert.equal(backoffDelay(5, noJitter), 30_000);
  assert.equal(backoffDelay(100, noJitter), 30_000);
});

test('jitter stays within ±20% and never exceeds the cap', () => {
  const opts = { baseMs: 1000, maxMs: 30_000, jitter: 0.2 };
  assert.equal(backoffDelay(2, opts, () => 0), 3200);
  assert.equal(backoffDelay(2, opts, () => 1), 4800);
  assert.equal(backoffDelay(10, opts, () => 1), 30_000);
});
