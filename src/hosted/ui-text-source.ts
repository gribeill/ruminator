// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// @ts-expect-error Wrangler bundles this as a Text module, not a filesystem read.
import source from '../../ui_text.toml';
export default source as string;
