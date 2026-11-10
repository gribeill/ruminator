import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Digest } from './digest.ts';
import { normalize, type EmbeddingInput, type EmbeddingProvider } from './embeddings.ts';
import type { Profile } from './profiles.ts';
import { captureFeedback, readRanking, readSemanticScores, saveRanking, saveSemanticScores } from './store.ts';
import { DEFAULT_FEEDBACK_CONFIG, validateFeedbackConfig, type FeedbackConfig, type FeedbackSnapshot } from './feedback.ts';
import { rankPapers, DEFAULT_WEIGHTS, type ScoreWeights } from './ranking.ts';

export interface PaperScore {
  score: number;
  cosine: number;
  profileId: string;
  similarities: Record<string, number>;
}

export interface SemanticScores {
  fingerprint: string;
  normalization: 'cosine-affine-v1';
  profiles: Profile[];
  papers: Record<string, PaperScore>;
}

/** Fixed scale, not daily min-max scaling or a calibrated probability. */
export function visibleScore(cosine: number): number {
  if (!Number.isFinite(cosine)) throw new Error('Non-finite cosine similarity');
  return (Math.max(-1, Math.min(1, cosine)) + 1) / 2;
}

export async function cachedEmbedding(db: DatabaseSync, provider: EmbeddingProvider, input: EmbeddingInput): Promise<number[]> {
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const cached = db.prepare('SELECT vector_json FROM embeddings WHERE fingerprint = ? AND content_hash = ?')
    .get(provider.fingerprint, hash) as { vector_json: string } | undefined;
  if (cached) return normalize(JSON.parse(cached.vector_json), provider.dimensions);
  const vector = normalize(await provider.embed(input), provider.dimensions);
  db.prepare('INSERT INTO embeddings (fingerprint, content_hash, vector_json) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
    .run(provider.fingerprint, hash, JSON.stringify(vector));
  return vector;
}

/** Persist a complete score snapshot only after all papers succeed; vectors resume independently. */
export async function scoreDigest(
  db: DatabaseSync, digest: Digest, profiles: Profile[], createProvider: () => Promise<EmbeddingProvider>,
  log: (message: string) => void = console.log,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  feedbackConfig: FeedbackConfig = DEFAULT_FEEDBACK_CONFIG,
): Promise<Digest> {
  const existing = readSemanticScores(db, digest);
  const ranking = readRanking(db, digest);
  if (existing && ranking) return { ...digest, semantic: existing, ranking };
  // Freeze semantic inputs independently of the explicit lexical vocabulary.
  const embeddingProfiles = existing?.profiles ?? profiles;
  if (!embeddingProfiles.length) throw new Error('At least one research profile is required');
  validateFeedbackConfig(feedbackConfig);
  const feedbackInput = captureFeedback(db, digest, feedbackConfig);
  const provider = await createProvider();
  try {
    if (existing && existing.fingerprint !== provider.fingerprint) {
      throw new Error('Embedding model changed; reset the application DB before ranking');
    }
    const feedback: FeedbackSnapshot = { ...feedbackInput, fingerprint: provider.fingerprint, examples: [] };
    for (const vote of feedbackInput.votes) {
      // Always use the current embedding space, reusing compatible cached inputs.
      const vector = await cachedEmbedding(db, provider, { kind: 'paper', title: vote.paper.title, text: vote.paper.abstract });
      feedback.examples.push({ ...vote, vector });
    }
    const queries: number[][] = [];
    if (!existing) {
      for (const profile of embeddingProfiles) {
        queries.push(await cachedEmbedding(db, provider, { kind: 'profile', title: profile.title, text: profile.subjects.join('\n') }));
      }
    }
    const papers: Record<string, PaperScore> = {};
    const vectors: Record<string, number[]> = {};
    for (const [index, paper] of digest.papers.entries()) {
      log(`Scoring ${index + 1}/${digest.papers.length}: ${paper.id}`);
      const vector = await cachedEmbedding(db, provider, { kind: 'paper', title: paper.title, text: paper.abstract });
      vectors[paper.id] = vector;
      if (existing) continue;
      const similarities = queries.map(query => Math.max(-1, Math.min(1, query.reduce((sum, v, i) => sum + v * vector[i], 0))));
      const best = similarities.indexOf(Math.max(...similarities));
      papers[paper.id] = {
        score: visibleScore(similarities[best]), cosine: similarities[best], profileId: embeddingProfiles[best].id,
        similarities: Object.fromEntries(embeddingProfiles.map((profile, i) => [profile.id, similarities[i]])),
      };
    }
    const semantic = existing ?? saveSemanticScores(db, digest, {
      fingerprint: provider.fingerprint, normalization: 'cosine-affine-v1', profiles: embeddingProfiles, papers,
    });
    const keywordProfiles = semantic.profiles.map(profile => ({
      ...profile, keywords: profiles.find(p => p.id === profile.id)?.keywords ?? [],
    }));
    const ranked = saveRanking(db, digest, rankPapers(digest, semantic, vectors, keywordProfiles, weights, feedback));
    return { ...digest, semantic, ranking: ranked };
  } finally { await provider.dispose?.(); }
}
