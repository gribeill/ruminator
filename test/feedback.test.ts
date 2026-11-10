import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FEEDBACK_CONFIG, feedbackScore, type FeedbackExample } from '../src/feedback.ts';

function example(id: number, value: -1 | 1, vector: number[]): FeedbackExample {
  return { eventId: id, value, vector, createdAt: '2026-11-10T00:00:00Z', paper: {
    id: `2611.${String(id).padStart(5, '0')}`, version: 1, title: 'Voted paper', abstract: 'Text.', categories: ['quant-ph'],
  } };
}
const config = DEFAULT_FEEDBACK_CONFIG;

test('feedback is neutral without nearby evidence, conservative for single votes, and symmetric', () => {
  assert.equal(feedbackScore([1, 0], [], config), 0.5);
  assert.equal(feedbackScore([1, 0], [example(1, 1, [0, 1])], config), 0.5);
  assert.equal(feedbackScore([1, 0], [example(1, 1, [0.90, Math.sqrt(1 - 0.9 ** 2)])], config), 0.5);
  assert.equal(feedbackScore([1, 0], [example(1, 1, [1, 0])], config), 0.75);
  assert.equal(feedbackScore([1, 0], [example(1, -1, [1, 0])], config), 0.25);
  const v = [0.92, Math.sqrt(1 - 0.92 ** 2)];
  assert.ok(feedbackScore([1, 0], [example(1, 1, v)], config) > 0.5);
  assert.equal(feedbackScore([1, 0], [example(1, 1, v)], { ...config, min_similarity: 0.94 }), 0.5);
});

test('near-duplicate examples do not multiply evidence; the latest conflicting vote wins', () => {
  const up = example(1, 1, [1, 0]);
  const alsoUp = example(2, 1, [1, 0]);
  assert.equal(feedbackScore([1, 0], [up, alsoUp], config), 0.75);
  const down = { ...alsoUp, value: -1 as const };
  assert.equal(feedbackScore([1, 0], [up, down], config), 0.25);
  assert.equal(feedbackScore([1, 0], [down, up], config), 0.25);
  const left = example(3, 1, [Math.cos(0.2), Math.sin(0.2)]);
  const right = example(4, -1, [Math.cos(0.2), -Math.sin(0.2)]);
  assert.equal(feedbackScore([1, 0], [left, right], config), 0.5);
  const sameId = { ...right, paper: { ...left.paper, version: 2 } };
  assert.ok(feedbackScore([1, 0], [left, sameId], config) < 0.5);
  assert.throws(() => feedbackScore([1, 0], [example(1, 1, [1, 0, 0])], config), /compatible/);
  assert.throws(() => feedbackScore([1, 0], [example(1, 1, [2, 0])], config), /normalized/);
});
