/**
 * Copyright 2026 Guilhem Ribeill
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Batch } from './arxiv.ts';
import type { Config } from './config.ts';
import { createDigest, type Digest } from './digest.ts';
import type { EmbeddingProvider } from './embeddings.ts';
import type { Profile } from './profiles.ts';
import { retrieveFeaturedText } from './fulltext.ts';
import { loadDailyBatches } from './load.ts';
import { cachedDownload, saveDigest } from './store.ts';
import { scoreDigest } from './scoring.ts';
import { summarizeFeatured, type SummaryConfig, type SummaryProvider } from './summaries.ts';
import { freezeGenerationInputs, pruneListingData, publishListing, readPublication,
  readWorkingListing, sameBatch, selectWorkingListing } from './listing-store.ts';

export interface GenerateOptions {
  categories: string[];
  config: Config;
  profiles: Profile[];
  createEmbeddingProvider: () => Promise<EmbeddingProvider>;
  createSummaryProvider?: (config: SummaryConfig) => SummaryProvider;
  summarize?: boolean;
  clear?: boolean;
  offline?: boolean;
  refresh?: boolean;
  now?: Date;
  download?: (category: string) => Promise<Batch>;
  textOptions?: Parameters<typeof retrieveFeaturedText>[2];
  log?: (message: string) => void;
}

/** A complete matching batch is required before retiring any working state.
 * Offline means the current per-category download cache, never historical backfill.
 * The caller must hold the local generation lock for all writing operations.
 */
export async function prepareListing(app: DatabaseSync, papers: DatabaseSync, options: Pick<GenerateOptions,
  'categories' | 'clear' | 'offline' | 'refresh' | 'now' | 'download' | 'log'>): Promise<{ digest: Digest; unchanged: boolean }> {
  // Expiry must not depend on the network being available. Also clean up partial
  // downloads after failures, retaining only the latest feeds needed for a retry.
  pruneListingData(app, papers, options.now, options.categories);
  try {
    let batches: Batch[];
    if (options.offline) {
      batches = options.categories.map(category => {
        const cached = cachedDownload(papers, category);
        if (!cached) throw new Error(`No current cached feed for ${category}; run generate online first`);
        return cached.batch;
      });
    } else {
      batches = await loadDailyBatches(papers, options.categories, options);
      if (options.clear) batches = options.categories.map(category => cachedDownload(papers, category)!.batch);
    }
    const candidate = createDigest(batches);
    const published = readPublication(app);
    const working = readWorkingListing(app);
    if (published && candidate.date < published.digest.date) throw new Error('Feed is older than the current listing; refusing to go back in time');
    const resuming = working && sameBatch(working.digest, candidate) && working.generationId !== published?.generationId;
    if (!options.clear && published && sameBatch(published.digest, candidate) && !resuming) {
      pruneListingData(app, papers, options.now);
      options.log?.(`Listing ${candidate.date} is already published; no generation or paid requests.`);
      return { digest: readPublication(app)!.digest, unchanged: true };
    }
    // Clear source text first: a crash must not resume a reset workspace with old HTML.
    // The old publication is self-contained and remains readable without its source cache.
    if (options.clear) papers.exec('DELETE FROM paper_texts');
    saveDigest(app, batches);
    selectWorkingListing(app, candidate, options.clear);
    pruneListingData(app, papers, options.now);
    return { digest: readWorkingListing(app)!.digest, unchanged: false };
  } catch (error) {
    try { pruneListingData(app, papers, options.now, options.categories); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Listing preparation and cleanup both failed', { cause: error }); }
    throw error;
  }
}

/** Manual finite pipeline: publication is the final step, never an intermediate preview. */
export async function generateListing(app: DatabaseSync, papers: DatabaseSync, options: GenerateOptions): Promise<Digest> {
  if (options.summarize && options.offline) throw new Error('--summarize cannot be combined with --offline');
  if (options.summarize && !options.createSummaryProvider) throw new Error('Summary provider required');
  const prepared = await prepareListing(app, papers, options);
  if (prepared.unchanged) return prepared.digest;
  const inputs = freezeGenerationInputs(app, { config: options.config, profiles: options.profiles });
  let digest = await scoreDigest(app, prepared.digest, inputs.profiles, options.createEmbeddingProvider,
    options.log, inputs.config.scoring.weights, inputs.config.feedback);
  if (options.summarize) {
    await retrieveFeaturedText(papers, digest, { ...options.textOptions, log: options.log });
    digest = await summarizeFeatured(app, papers, digest, options.config, options.createSummaryProvider!, options.log);
  }
  publishListing(app, digest);
  pruneListingData(app, papers, options.now);
  options.log?.(`Published ${digest.date}: ${digest.papers.length} papers.`);
  return digest;
}
