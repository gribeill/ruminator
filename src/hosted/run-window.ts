// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

/** Internal SQL expression only. Unmanaged fixture/local generations have no
 * daily row. Managed work must not dispatch or publish after its cutoff, even
 * if no subsequent scheduler invocation has yet cleared the working slot.
 */
export function withinRunWindow(generation: string): string {
  return `NOT EXISTS (SELECT 1 FROM generation_runs daily WHERE daily.generation_id = ${generation}
    AND (daily.deadline <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      OR daily.failure_reason IN ('preparation', 'launch')))
    AND NOT EXISTS (SELECT 1 FROM generation_inputs controlled JOIN users actor ON actor.id = controlled.user_id
      WHERE controlled.id = ${generation} AND controlled.action != 'daily'
        AND (actor.role != 'admin' OR NOT EXISTS (SELECT 1 FROM current_readings original
          WHERE original.user_id = actor.id AND original.listing_id = controlled.base_publication)))`;
}
