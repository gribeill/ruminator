// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// Shared by local retrieval and hosted persistence without filesystem/SQLite imports.
export const HTML_EXTRACTOR = 'arxiv-html-v2';
export const MAX_HTML_BYTES = 16 * 1024 * 1024;

export interface PaperText {
  paperId: string;
  version: number;
  status: 'available' | 'unavailable';
  sourceUrl: string;
  checkedAt: string;
  extractor: string;
  text?: string;
  contentHash?: string;
  reason?: string;
}

export interface CachedPaperText {
  html: string | null;
  result: PaperText;
}
