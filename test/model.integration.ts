import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBgeProvider } from '../src/bge.ts';

// Explicit opt-in: the first run downloads model assets, never arXiv data.
test('real BGE: local inference, domain relevance, long abstracts, and offline reload', async () => {
  const provider = await createBgeProvider({ offline: process.env.MODEL_OFFLINE === '1' });
  const query = { kind: 'profile' as const, title: 'Superconducting quantum computing', text: 'Superconducting qubit gates, tunable couplers, and decoherence.' };
  const matching = { kind: 'paper' as const, title: 'Tunable couplers for superconducting qubits', text: 'We demonstrate high-fidelity two-qubit gates in superconducting circuits using a tunable coupler.' };
  const unrelated = { kind: 'paper' as const, title: 'Seasonal migration of seabirds', text: 'We track seabird populations across ocean habitats and study seasonal feeding patterns.' };
  let reference: number[];
  try {
    const q = await provider.embed(query);
    reference = await provider.embed(matching);
    const other = await provider.embed(unrelated);
    assert.equal(reference.length, 384);
    assert.ok(Math.abs(Math.hypot(...reference) - 1) < 1e-6);
    const dot = (v: number[]) => q.reduce((sum, x, i) => sum + x * v[i], 0);
    assert.ok(dot(reference) > dot(other), 'An obvious hardware match should beat an unrelated paper');
    console.log(`Match cosine: ${dot(reference).toFixed(3)}; unrelated: ${dot(other).toFixed(3)}`);
    const long = await provider.embed({ ...matching, text: matching.text.repeat(100) });
    assert.equal(long.length, 384);
    assert.ok(long.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...long) - 1) < 1e-6);
    const mixed = await provider.embed({ ...matching, text: matching.text.repeat(100) + unrelated.text.repeat(100) });
    assert.ok(long.reduce((sum, v, i) => sum + v * mixed[i], 0) < 0.999,
      'Content well beyond the first context window must affect the embedding');
  } finally { await provider.dispose?.(); }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Offline inference must not make HTTP requests'); };
  try {
    const offline = await createBgeProvider({ offline: true });
    try {
      const repeated = await offline.embed(matching);
      assert.ok(repeated.every((v, i) => Math.abs(v - reference[i]) < 1e-6));
    } finally { await offline.dispose?.(); }
  } finally { globalThis.fetch = originalFetch; }
});
