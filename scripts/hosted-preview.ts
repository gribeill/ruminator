// Copyright 2026 Guilhem Ribeill
// SPDX-License-Identifier: Apache-2.0

import { startHostedFixture } from './hosted-fixtures.ts';

// This is an ephemeral local fixture, not a cloud deployment or a synchronized account.
const fixture = await startHostedFixture();
try {
  console.log(`Browse ${fixture.origin}/`);
  console.log('Local signed-login fixture: owner@example.test (admin), friend@example.test, new@example.test (onboarding).');
  console.log('No email, model calls, or cloud resources. Votes/accounts reset when stopped; your data/ databases are untouched.');
  console.log('Ctrl-C to stop.');
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
} finally {
  await fixture.close();
}
