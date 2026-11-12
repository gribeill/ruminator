// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

/** Keep CLI/library diagnostics intact while pages choose their own wording.
 * Codes and values describe validation failures; they contain no HTML/UI logic. */
export class DocumentError extends Error {
  readonly code: string;
  readonly values: Record<string, string | number>;
  constructor(code: string, message: string, values: Record<string, string | number> = {}) {
    super(message);
    this.code = code;
    this.values = values;
  }
}
