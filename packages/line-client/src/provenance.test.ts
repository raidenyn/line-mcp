import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Verifies the two vendored LTSM assets on disk still match the exact
// size/hash facts recorded in provenance.json. If this ever fails, the
// assets have drifted from what was legally reviewed/recorded — that's a
// provenance blocker, not something to silently accept (see
// assets/ltsm/provenance.json and ../THIRD_PARTY_NOTICES.md).

const ASSETS_DIR = path.resolve(__dirname, '..', 'assets', 'ltsm');
const PROVENANCE_PATH = path.join(ASSETS_DIR, 'provenance.json');

interface ProvenanceAssetRecord {
  sizeBytes: number;
  sha256: string;
}

interface ProvenanceFile {
  source: {
    extensionId: string;
    sourceVersion: string;
  };
  approvedDistributionForms: {
    publicNpmPublish: string;
  };
  assets: Record<string, ProvenanceAssetRecord>;
}

function readProvenance(): ProvenanceFile {
  return JSON.parse(fs.readFileSync(PROVENANCE_PATH, 'utf8')) as ProvenanceFile;
}

function hashFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('LTSM asset provenance', () => {
  const provenance = readProvenance();

  it('records the LINE Chrome extension id and source version', () => {
    expect(provenance.source.extensionId).toBe('ophjlpahpchlmihnnnihgmmeilfjmjjc');
    expect(provenance.source.sourceVersion).toBe('3.7.2');
  });

  it('explicitly blocks public npm publish', () => {
    expect(provenance.approvedDistributionForms.publicNpmPublish.toLowerCase()).toContain('not approved');
  });

  it.each(['ltsm.wasm', 'ltsmSandbox.js'] as const)(
    '%s on disk matches the recorded size and SHA-256 in provenance.json',
    (name) => {
      const record = provenance.assets[name];
      expect(record, `provenance.json is missing an entry for ${name}`).toBeTruthy();

      const filePath = path.join(ASSETS_DIR, name);
      const stat = fs.statSync(filePath);
      expect(stat.size).toBe(record.sizeBytes);
      expect(hashFile(filePath)).toBe(record.sha256);
    },
  );

  // Pin the exact facts from the task brief so a corrupted/incomplete
  // provenance.json can't silently drift and still pass the two checks above.
  it('matches the exact byte-for-byte facts recorded in the task brief', () => {
    expect(provenance.assets['ltsm.wasm']).toEqual({
      sizeBytes: 2254973,
      sha256: '58bb4e189ab9bbd7d72ed415258da36afd50e306cb019bab75329d4f5f1b65b3',
    });
    expect(provenance.assets['ltsmSandbox.js']).toEqual({
      sizeBytes: 5028088,
      sha256: 'bdc9398d348ec8a0e8cf76479df82a638c1078c92fcb73f89e0db2eadda0c5b6',
    });
  });
});
