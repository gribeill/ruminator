// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';

// Node resolves this loader; Wrangler's workerd condition bundles the same TOML.
export default readFileSync(new URL('../ui_text.toml', import.meta.url), 'utf8');
