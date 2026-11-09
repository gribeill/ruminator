import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProfiles, parseProfiles } from '../src/profiles.ts';

const hardware = `## Hardware {#hardware}
### Subjects
- Gates
* Couplers
<!-- - Not a subject -->
### Keywords
- tunable coupler; tunable coupling
* RFSoC
<!-- - hidden keyword -->
- ; ;
### Positive examples
- Example paper
### Deprioritize
- Ignore this
### Negative examples
- Bad match
`;
const sensing = `## Sensing {#sensing}
### Subjects
- Spin defects
### Keywords
<!-- No explicit vocabulary yet. -->
`;

test('one document parses independent profiles without mixing subjects, keywords, or feedback', () => {
  const parsed = parseProfiles(`# Research interests\n${hardware}\n${sensing}`);
  assert.deepEqual(parsed, [
    { id: 'hardware', title: 'Hardware', subjects: ['Gates', 'Couplers'], keywords: ['tunable coupler; tunable coupling', 'RFSoC'] },
    { id: 'sensing', title: 'Sensing', subjects: ['Spin defects'], keywords: [] },
  ]);
  const commented = `<!--\n## Hidden {#hidden}\n### Subjects\n- Hidden interest\n-->\n${hardware}`;
  assert.equal(parseProfiles(commented).length, 1);
  assert.deepEqual(parseProfiles((hardware + sensing).replace(/\n/g, '\r\n')), parsed);
});

test('explicit IDs survive display renames and document reordering', () => {
  assert.deepEqual(parseProfiles(sensing + hardware), parseProfiles(hardware + sensing));
  const renamed = parseProfiles(hardware.replace('## Hardware ', '## Quantum Hardware '))[0];
  assert.equal(renamed.id, 'hardware');
  assert.equal(renamed.title, 'Quantum Hardware');
  assert.deepEqual(renamed.subjects, ['Gates', 'Couplers']);
});

test('missing keywords stay empty; malformed/duplicate IDs and missing subjects fail clearly', () => {
  assert.deepEqual(parseProfiles('## Test {#test}\n### Subjects\n- Qubits')[0].keywords, []);
  assert.throws(() => parseProfiles('# Empty document'), /No research profiles/);
  assert.throws(() => parseProfiles('## Missing ID\n### Subjects\n- Qubits'), /stable-id/);
  assert.throws(() => parseProfiles('## Invalid {#Not_An_Id}\n### Subjects\n- Qubits'), /stable-id/);
  assert.throws(() => parseProfiles(hardware + hardware), /Duplicate profile ID: hardware/);
  assert.throws(() => parseProfiles('## Empty {#empty}\n### Subjects\n<!-- placeholder -->'), /Subjects bullets/);
});

test('file loading uses a single configurable file and preserves all six research areas', () => {
  const profiles = loadProfiles();
  assert.deepEqual(profiles.map(p => p.id), [
    'cryogenic-engineering', 'emerging-computing', 'novel-qubits',
    'quantum-error-correction-and-scaling', 'quantum-sensing', 'superconducting-quantum-computing',
  ]);
  assert.ok(profiles.every(p => p.subjects.length && p.keywords?.length));
  mkdirSync('data', { recursive: true });
  const directory = mkdtempSync('data/profile-test-');
  try {
    const path = join(directory, 'custom-interests.md');
    writeFileSync(path, hardware + sensing);
    assert.deepEqual(loadProfiles(path), parseProfiles(hardware + sensing));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
