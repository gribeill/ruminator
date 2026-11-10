import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { averageVectors, splitChunks, type EmbeddingProvider } from './embeddings.ts';

const MODEL = 'Xenova/bge-small-en-v1.5';
const REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const BGE_CONFIG = { model: MODEL, revision: REVISION, dtype: 'q8', pooling: 'cls' } as const;
const QUERY = 'Represent this sentence for searching relevant passages: ';

export const BGE_FINGERPRINT = JSON.stringify({
  model: MODEL, revision: REVISION, backend: 'transformers.js-4.3.2/onnx-cpu',
  dtype: 'q8', pooling: 'cls', normalize: true, query: QUERY,
  preprocessing: 'title-sentence-chunks-512-v1', aggregation: 'normalized-chunk-mean',
});

/** Lazy initialization keeps cached viewing independent of the model runtime. */
export async function createBgeProvider({ offline = false, cacheDir = 'data/models' } = {}): Promise<EmbeddingProvider> {
  const cachedPath = resolve(cacheDir, MODEL, REVISION);
  const cached = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']
    .every(file => existsSync(resolve(cachedPath, file)));
  if (offline && !cached) throw new Error('BGE model assets are not cached. Run npm run score once without --offline.');
  const { env, AutoModel, AutoTokenizer, FeatureExtractionPipeline } = await import('@huggingface/transformers');
  env.cacheDir = resolve(cacheDir);
  env.allowLocalModels = true;
  env.localModelPath = resolve(cacheDir, 'local');
  // v4's tokenizer discovery ignores revision/local_files_only for metadata.
  // Loading the pinned cache directory directly avoids those remote probes.
  const source = cached ? cachedPath : MODEL;
  const options = { revision: REVISION, local_files_only: cached || offline };
  const loadedTokenizer = await AutoTokenizer.from_pretrained(source, options);
  const model = await AutoModel.from_pretrained(source, {
    ...options, dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  });
  const extractor = new FeatureExtractionPipeline({ task: 'feature-extraction', model, tokenizer: loadedTokenizer });
  const tokenizer = {
    encode: (text: string) => extractor.tokenizer.encode(text, { add_special_tokens: false }),
    decode: (ids: number[]) => extractor.tokenizer.decode(ids, { skip_special_tokens: false }),
  };
  return {
    fingerprint: BGE_FINGERPRINT,
    dimensions: 384,
    async embed(input) {
      const prefix = `${input.kind === 'profile' ? QUERY : ''}${input.title}\n\n`;
      const chunks = splitChunks(prefix, input.text, tokenizer);
      const vectors: number[][] = [];
      for (const chunk of chunks) {
        const result = await extractor(chunk, { pooling: 'cls', normalize: true });
        vectors.push(Array.from(result.data as Float32Array));
      }
      return averageVectors(vectors, 384);
    },
    async dispose() { await extractor.dispose(); },
  };
}
