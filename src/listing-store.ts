import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import type { Digest } from './digest.ts';
import type { EmbeddingInput } from './embeddings.ts';
import type { Profile } from './profiles.ts';
import type { FeedbackInput } from './feedback.ts';
import { captureFeedback, readDigest } from './store.ts';

export interface Publication { generationId: string; digest: Digest }
export interface GenerationInputs { config: Config; profiles: Profile[] }
export interface WorkingListing extends Publication { inputs?: GenerationInputs }

export function sameBatch(a: Digest, b: Digest): boolean {
  return a.date === b.date && JSON.stringify([...a.categories].sort()) === JSON.stringify([...b.categories].sort());
}

export function readPublication(db: DatabaseSync): Publication | undefined {
  const row = db.prepare('SELECT generation_id, digest_json FROM publication WHERE singleton = 1').get() as
    { generation_id: string; digest_json: string } | undefined;
  return row && { generationId: row.generation_id, digest: JSON.parse(row.digest_json) };
}

export function readWorkingListing(db: DatabaseSync): WorkingListing | undefined {
  const row = db.prepare('SELECT * FROM working_listing WHERE singleton = 1').get() as
    { generation_id: string; announcement_date: string; categories_json: string; inputs_json: string | null } | undefined;
  if (!row) return undefined;
  const digest = readDigest(db, row.announcement_date, JSON.parse(row.categories_json));
  if (!digest || digest.date !== row.announcement_date) throw new Error('Working listing is incomplete; use generate --clear');
  return { generationId: row.generation_id, digest, inputs: row.inputs_json ? JSON.parse(row.inputs_json) : undefined };
}

/** Source fetching must finish before replacing staging. Publication is deliberately separate. */
export function selectWorkingListing(db: DatabaseSync, digest: Digest, clear = false): void {
  const previous = readWorkingListing(db);
  if (!clear && previous && sameBatch(previous.digest, digest)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['digests', 'semantic_scores', 'rankings', 'feedback_snapshots', 'digest_summaries', 'summary_runs']) {
      if (clear) db.exec(`DELETE FROM ${table}`);
      else db.prepare(`DELETE FROM ${table} WHERE announcement_date != ? OR categories_json != ?`)
        .run(digest.date, JSON.stringify([...digest.categories].sort()));
    }
    db.exec('DELETE FROM summary_cache');
    // A clear starts with the newly fetched source, not the old ranked workspace.
    if (clear) db.prepare(`INSERT INTO digests (announcement_date, categories_json, papers_json, featured_ids_json)
      VALUES (?, ?, ?, ?)`).run(digest.date, JSON.stringify([...digest.categories].sort()), JSON.stringify(digest.papers), JSON.stringify(digest.featuredIds));
    db.prepare(`INSERT INTO working_listing (singleton, generation_id, announcement_date, categories_json, inputs_json)
      VALUES (1, ?, ?, ?, NULL) ON CONFLICT (singleton) DO UPDATE SET generation_id = excluded.generation_id,
      announcement_date = excluded.announcement_date, categories_json = excluded.categories_json, inputs_json = NULL`)
      .run(randomUUID(), digest.date, JSON.stringify([...digest.categories].sort()));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Freeze ranking inputs before any model initialization; summary settings remain explicit per invocation. */
export function freezeGenerationInputs(db: DatabaseSync, inputs: GenerationInputs): GenerationInputs {
  const working = readWorkingListing(db);
  if (!working) throw new Error('No working listing; run fetch or generate first');
  if (working.inputs) return working.inputs;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE working_listing SET inputs_json = ? WHERE singleton = 1').run(JSON.stringify(inputs));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  captureFeedback(db, working.digest, inputs.config.feedback);
  return inputs;
}

/** One transaction switches readers to the complete artifact. Cleanup happens afterward. */
export function publishListing(db: DatabaseSync, digest: Digest): void {
  if (!digest.ranking) throw new Error('Cannot publish an unranked listing');
  const working = readWorkingListing(db);
  if (!working || !sameBatch(working.digest, digest)) throw new Error('Publication must match the working listing');
  db.prepare(`INSERT INTO publication (singleton, generation_id, digest_json) VALUES (1, ?, ?)
    ON CONFLICT (singleton) DO UPDATE SET generation_id = excluded.generation_id, digest_json = excluded.digest_json`)
    .run(working.generationId, JSON.stringify(digest));
}

/** Compact changes to the latest active vote and expire FIFO by last explicit change, never use. */
export function pruneVotes(db: DatabaseSync, now = new Date()): void {
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM vote_events WHERE event_id NOT IN (SELECT MAX(event_id) FROM vote_events GROUP BY arxiv_id)');
    db.prepare('DELETE FROM vote_events WHERE value = 0 OR created_at < ?').run(cutoff);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Retain only current/staging inputs and active voted examples, not a shadow literature archive.
 * Separate transactions make cleanup restartable if a process dies after publication.
 */
export function pruneListingData(app: DatabaseSync, papers: DatabaseSync, now = new Date()): void {
  pruneVotes(app, now);
  const cutoff = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString();
  // Expired example metadata must not survive inside JSON provenance either.
  // Scores/order stay fixed; a very old interrupted run resumes without expired votes.
  const expire = (snapshot: FeedbackInput & { examples?: { createdAt: string }[] }) => {
    snapshot.votes = snapshot.votes.filter(vote => vote.createdAt >= cutoff);
    if (snapshot.examples) snapshot.examples = snapshot.examples.filter(example => example.createdAt >= cutoff);
  };
  app.exec('BEGIN IMMEDIATE');
  try {
    for (const row of app.prepare('SELECT rowid, snapshot_json FROM feedback_snapshots').all()) {
      const snapshot = JSON.parse(row.snapshot_json as string);
      expire(snapshot);
      app.prepare('UPDATE feedback_snapshots SET snapshot_json = ? WHERE rowid = ?').run(JSON.stringify(snapshot), row.rowid);
    }
    for (const row of app.prepare('SELECT rowid, ranking_json FROM rankings').all()) {
      const ranking = JSON.parse(row.ranking_json as string);
      if (ranking.feedbackSnapshot) expire(ranking.feedbackSnapshot);
      app.prepare('UPDATE rankings SET ranking_json = ? WHERE rowid = ?').run(JSON.stringify(ranking), row.rowid);
    }
    const publication = readPublication(app);
    if (publication?.digest.ranking?.feedbackSnapshot) {
      expire(publication.digest.ranking.feedbackSnapshot);
      app.prepare('UPDATE publication SET digest_json = ? WHERE singleton = 1').run(JSON.stringify(publication.digest));
    }
    app.exec('COMMIT');
  } catch (error) { app.exec('ROLLBACK'); throw error; }
  const working = readWorkingListing(app);
  const published = readPublication(app);
  const digests = [working?.digest, published?.digest].filter((d): d is Digest => !!d);
  const hashes = new Set<string>();
  const keepInput = (input: EmbeddingInput) => hashes.add(createHash('sha256').update(JSON.stringify(input)).digest('hex'));
  const keepPaper = (paper: Digest['papers'][number]) => keepInput({ kind: 'paper', title: paper.title, text: paper.abstract });
  for (const digest of digests) {
    digest.papers.forEach(keepPaper);
    for (const profile of digest.semantic?.profiles ?? []) keepInput({ kind: 'profile', title: profile.title, text: profile.subjects.join('\n') });
  }
  for (const profile of working?.inputs?.profiles ?? []) keepInput({ kind: 'profile', title: profile.title, text: profile.subjects.join('\n') });
  for (const row of app.prepare('SELECT paper_json FROM vote_events').all()) keepPaper(JSON.parse(row.paper_json as string));
  // Frozen feedback is needed only for an unfinished ranking, not as permanent vote history.
  if (working && !working.digest.ranking) {
    for (const row of app.prepare('SELECT snapshot_json FROM feedback_snapshots').all()) {
      const snapshot: FeedbackInput = JSON.parse(row.snapshot_json as string);
      snapshot.votes.forEach(vote => keepPaper(vote.paper));
    }
  }
  app.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['digests', 'semantic_scores', 'rankings', 'feedback_snapshots', 'digest_summaries', 'summary_runs']) {
      if (!working) app.exec(`DELETE FROM ${table}`);
      else app.prepare(`DELETE FROM ${table} WHERE announcement_date != ? OR categories_json != ?`)
        .run(working.digest.date, JSON.stringify([...working.digest.categories].sort()));
    }
    for (const row of app.prepare('SELECT fingerprint, content_hash FROM embeddings').all()) {
      if (!hashes.has(row.content_hash as string)) app.prepare('DELETE FROM embeddings WHERE fingerprint = ? AND content_hash = ?')
        .run(row.fingerprint, row.content_hash);
    }
    app.exec('DELETE FROM summary_cache WHERE cache_key NOT IN (SELECT json_extract(result_json, \'$.cacheKey\') FROM digest_summaries WHERE json_extract(result_json, \'$.cacheKey\') IS NOT NULL)');
    app.exec('COMMIT');
  } catch (error) { app.exec('ROLLBACK'); throw error; }

  const ids = new Set(digests.flatMap(d => d.papers.map(p => `${p.id}v${p.version}`)));
  const categories = new Set(digests.flatMap(d => d.categories));
  const batches = new Set(digests.flatMap(d => d.categories.map(c => `${c}:${d.date}`)));
  papers.exec('BEGIN IMMEDIATE');
  try {
    for (const row of papers.prepare('SELECT category, batch_json FROM feed_downloads').all()) {
      if (!categories.has(row.category as string)) papers.prepare('DELETE FROM feed_downloads WHERE category = ?').run(row.category);
      else batches.add(`${row.category}:${JSON.parse(row.batch_json as string).date}`);
    }
    for (const row of papers.prepare('SELECT category, announcement_date FROM batches').all()) {
      if (!batches.has(`${row.category}:${row.announcement_date}`)) papers.prepare('DELETE FROM batches WHERE category = ? AND announcement_date = ?').run(row.category, row.announcement_date);
    }
    for (const table of ['paper_texts', 'paper_authors']) {
      for (const row of papers.prepare(`SELECT arxiv_id, version FROM ${table}`).all()) {
        if (!ids.has(`${row.arxiv_id}v${row.version}`)) papers.prepare(`DELETE FROM ${table} WHERE arxiv_id = ? AND version = ?`).run(row.arxiv_id, row.version);
      }
    }
    papers.exec('COMMIT');
  } catch (error) { papers.exec('ROLLBACK'); throw error; }
}

/** Local process lock, not a hosted scheduler. Dead owners can be resumed after interruption. */
export function acquireGenerationLock(db: DatabaseSync): () => void {
  const token = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT owner_pid FROM generation_lock WHERE singleton = 1').get() as { owner_pid: number } | undefined;
    if (row) {
      let alive = true;
      try { process.kill(row.owner_pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
      if (alive) throw new Error('Another listing-generation command is running');
    }
    db.prepare('INSERT OR REPLACE INTO generation_lock (singleton, owner_pid, token) VALUES (1, ?, ?)').run(process.pid, token);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return () => { db.prepare('DELETE FROM generation_lock WHERE token = ?').run(token); };
}
