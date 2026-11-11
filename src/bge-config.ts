// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

/** Local model identity is configuration data, independent of the ONNX loader. */
export const BGE_CONFIG = {
  model: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  dtype: 'q8',
  pooling: 'cls',
} as const;
