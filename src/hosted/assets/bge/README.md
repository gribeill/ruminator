# Packaged hosted BGE tokenizer

These are tokenizer metadata only, not model weights. They are imported into the
hosted ranking bundle; runtime operation never downloads them or uses a local
ONNX installation.

Source: [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5/tree/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a),
revision `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`.

| File | SHA-256 |
| --- | --- |
| `tokenizer.json` | `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66` |
| `tokenizer_config.json` | `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3` |

The ordinary test suite verifies both exact file hashes offline. The adapter uses
standalone `@huggingface/tokenizers` 0.2.0. Replacing these files or changing
preprocessing requires updating the full hosted fingerprint/invalidation epoch;
never treat local ONNX and hosted vectors as interchangeable.

The pinned model card declares MIT licensing and links to FlagEmbedding's
[license](https://github.com/FlagOpen/FlagEmbedding/blob/master/LICENSE), included
here as `LICENSE`. Attribution belongs to the upstream authors. These metadata
hashes do not pin Workers AI's provider weights or prove that its deployed
internal tokenizer is identical to this upstream revision.
