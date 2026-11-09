export interface EmbeddingInput {
  kind: 'paper' | 'profile';
  title: string;
  text: string;
}

export interface EmbeddingProvider {
  fingerprint: string;
  dimensions: number;
  embed(input: EmbeddingInput): Promise<number[]>;
  dispose?(): Promise<void>;
}

export interface Tokenizer {
  encode(text: string): number[];
  decode(ids: number[]): string;
}

/** Keep whole sentences when possible; split long sentences without truncation. */
export function splitChunks(prefix: string, text: string, tokenizer: Tokenizer, limit = 512): string[] {
  const fits = (body: string) => tokenizer.encode(prefix + body).length + 2 <= limit; // BERT CLS + SEP.
  if (!fits('')) throw new Error('Embedding title/instruction exceeds the token budget');
  if (fits(text)) return [prefix + text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean)) {
    const combined = current ? `${current} ${sentence}` : sentence;
    if (fits(combined)) { current = combined; continue; }
    if (current) { chunks.push(prefix + current); current = ''; }
    if (fits(sentence)) { current = sentence; continue; }
    const tokens = tokenizer.encode(sentence);
    let offset = 0;
    const budget = limit - tokenizer.encode(prefix).length - 2;
    while (offset < tokens.length) {
      let end = Math.min(tokens.length, offset + budget);
      let part = tokenizer.decode(tokens.slice(offset, end));
      // Re-tokenizing decoded text can change token counts at boundaries.
      while (end > offset && !fits(part)) part = tokenizer.decode(tokens.slice(offset, --end));
      if (end === offset) throw new Error('Cannot fit an abstract token alongside its title');
      chunks.push(prefix + part);
      offset = end;
    }
  }
  if (current) chunks.push(prefix + current);
  return chunks;
}

export function normalize(vector: number[], dimensions = vector.length): number[] {
  if (vector.length !== dimensions || vector.some(v => !Number.isFinite(v))) throw new Error('Invalid embedding dimensions or values');
  const norm = Math.hypot(...vector);
  if (!norm) throw new Error('Embedding has zero length');
  return vector.map(v => v / norm);
}

/** Chunk vectors contribute equally; renormalize before cosine comparisons. */
export function averageVectors(vectors: number[][], dimensions: number): number[] {
  if (!vectors.length) throw new Error('No embedding chunks');
  const sum = Array<number>(dimensions).fill(0);
  for (const vector of vectors) {
    const normalized = normalize(vector, dimensions);
    normalized.forEach((v, i) => sum[i] += v / vectors.length);
  }
  return normalize(sum, dimensions);
}
