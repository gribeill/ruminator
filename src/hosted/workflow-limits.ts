// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

// A callback may finish ranking and enter summaries. Four 60-second embedding
// attempts + six 30-second HTML attempts + one 120-second summary = nine minutes.
// Leave at least a minute for SQL/CPU/persistence within the ten-minute step.
// This is an IO allowance, not a guarantee about deployed CPU/memory behavior.
export const WORKFLOW_EMBEDDING_REQUESTS = 4;
export const WORKFLOW_SUMMARY_REQUESTS = 1;
export const WORKFLOW_STEP_MINUTES = 10;
