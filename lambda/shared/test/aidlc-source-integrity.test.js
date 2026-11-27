import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIDLC_COMPATIBILITY_PROFILES } from '../aidlc-compatibility-profiles.js';
import {
  assertOfficialSource,
  sourceDigestOf,
  sourceDigestOfHashes,
  sourceFileHashes,
} from '../aidlc-source-integrity.js';
import { fetchCoreFiles } from '../repo-fetch.js';
import { canonicalJson } from '../workflow-checkpoint.js';

const fixtureFor = (profileId) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
      'utf8',
    ),
  );

const PROFILES = Object.values(AIDLC_COMPATIBILITY_PROFILES);

// The fields of an official profile that reach release ids, manifests, registry
// decisions or the certified source. An existing profile keeps them forever; a
// newer AI-DLC version is added as a new profile instead.
const IDENTITY_FIELDS = [
  'id',
  'releaseId',
  'upstreamRef',
  'upstreamVersion',
  'upstreamChannel',
  'compatibilityStatus',
  'frontmatterDialect',
  'trustTier',
  'currentPlatformBaseline',
  'sourceDigest',
];
const identityDigest = (profile) =>
  createHash('sha256')
    .update(canonicalJson(Object.fromEntries(IDENTITY_FIELDS.map((key) => [key, profile[key]]))))
    .digest('hex');

// Only ever add a line here, in the PR that adds the profile.
const PUBLISHED_PROFILE_IDENTITIES = {
  'current-stable': 'e24d9b00b255e86de92d6cbbe08eef265cc5a3442e8060ea3a059de0cfb10194',
  'v2.6.18': 'ac6032f46ba4bc1fee638120e09e030b5cbb876b68400d57dc15ed38b0bb17f0',
  'v2.7.0': '912000a5890671158a64cff6de9250a312f58ce1d62c7ab374751bf304589fab',
  'v2.8.2': 'aeabbc09b13a51bba3364c0ddaeac617b7e82960f68b8387a985d2c4e6f67474',
  'v2.9.0': 'ab9d30c59407147c01459b41163e532c8d0c6a0354e71a438090be72dbe129eb',
  'v2.11.0': '663a4a1da932ad2f57c019e9699a99af6d6a844622efd7baa23cbfd4ab3ff96b',
  'v2.11.1': '0c108b13254de616a0f62204b8d4d63cd357da1a9fdbc83d59e30fd6aae68214',
  'v2.11.3': '986270071e5f7cc5249fb1a9be4f61ac1a371300ade50ff6d9cbeebafa8e259b',
  'v2.11.4': 'c71cac3708ce13777b459b9a9d004d950329d6d4128178abe2d30965474550f1',
  'v2.11.5': 'c402ad58921d445c19959e4f202b3a0494b40ae6a7aafc1f1ae96074ba5ab131',
};

describe('official source digest', () => {
  it.each(PROFILES.map((profile) => [profile.id, profile]))(
    '%s names the core/ tree its fixture was certified from',
    (profileId, profile) => {
      expect(profile.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(sourceDigestOfHashes(fixtureFor(profileId).originalFileHashes)).toBe(
        profile.sourceDigest,
      );
    },
  );

  it('hashes each file the way the fixture records it, in any order', () => {
    const files = new Map([
      ['core/b.md', 'second\n'],
      ['core/a.md', 'first\n'],
    ]);
    const hashes = sourceFileHashes(files);
    expect(hashes['core/a.md']).toBe(createHash('sha256').update('first\n').digest('hex'));
    expect(sourceDigestOf(new Map([...files].toReversed()))).toBe(sourceDigestOf(files));
    expect(sourceDigestOf(files)).toBe(sourceDigestOfHashes(hashes));
  });

  it('changes when a file changes, appears or disappears', () => {
    const files = new Map([['core/a.md', 'first\n']]);
    const digest = sourceDigestOf(files);
    expect(sourceDigestOf(new Map([['core/a.md', 'first \n']]))).not.toBe(digest);
    expect(sourceDigestOf(new Map([...files, ['core/b.md', '']]))).not.toBe(digest);
    expect(sourceDigestOf(new Map())).not.toBe(digest);
  });
});

describe('official profile allowlist', () => {
  it.each(Object.entries(PUBLISHED_PROFILE_IDENTITIES))(
    'keeps the published identity of %s',
    (profileId, identity) => {
      const profile = AIDLC_COMPATIBILITY_PROFILES[profileId];
      expect(profile, `${profileId} was removed`).toBeDefined();
      expect(identityDigest(profile), `${profileId} changed a published field`).toBe(identity);
    },
  );

  it('admits a newer version only as a candidate beside the single baseline', () => {
    expect(PROFILES.filter((profile) => profile.currentPlatformBaseline)).toEqual([
      AIDLC_COMPATIBILITY_PROFILES['current-stable'],
    ]);
    for (const profile of PROFILES.filter(
      ({ id }) => !Object.hasOwn(PUBLISHED_PROFILE_IDENTITIES, id),
    )) {
      expect(profile).toMatchObject({
        compatibilityStatus: 'candidate',
        trustTier: 'T1',
        currentPlatformBaseline: false,
      });
    }
  });
});

describe('assertOfficialSource', () => {
  const files = new Map([['core/aidlc-common/stages/a.md', 'secret body text\n']]);
  const official = (over = {}) => ({
    id: 'v9.9.9',
    upstreamVersion: '9.9.9',
    upstreamRef: 'f'.repeat(40),
    sourceDigest: sourceDigestOf(files),
    ...over,
  });

  it('accepts the certified tree and returns its digest', () => {
    expect(assertOfficialSource({ profile: official(), files })).toBe(sourceDigestOf(files));
  });

  it('refuses any other tree, naming the version and digests but no content', () => {
    const changed = new Map([['core/aidlc-common/stages/a.md', 'secret body text!\n']]);
    let error;
    try {
      assertOfficialSource({ profile: official(), files: changed });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ name: 'AidlcReleaseError', code: 'release_source_mismatch' });
    expect(error.message).toBe(
      `release_source_mismatch: AI-DLC 9.9.9 at ffffffffffff fetched 1 core/ files whose source digest ${sourceDigestOf(changed).slice(0, 12)} is not the certified ${sourceDigestOf(files).slice(0, 12)}`,
    );
    expect(error.message).not.toContain('secret');
  });

  it('fails closed for an official profile that records no source digest', () => {
    expect(() =>
      assertOfficialSource({ profile: official({ sourceDigest: undefined }), files }),
    ).toThrow(/is not the certified \(none recorded\)$/);
  });

  it('does not check a custom fork, which has no certified source', () => {
    expect(
      assertOfficialSource({ profile: official({ custom: true, sourceDigest: undefined }), files }),
    ).toBeNull();
  });
});

describe('source digest of what the import fetches', () => {
  const tarball = async (files) => {
    const pack = tar.pack();
    for (const [name, content] of Object.entries(files)) {
      pack.entry({ name: `aidlc-workflows-${'a'.repeat(40)}/${name}` }, content);
    }
    pack.finalize();
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    return gzipSync(Buffer.concat(chunks));
  };

  afterEach(() => vi.unstubAllGlobals());

  // Every official sourceDigest was recorded from fetchCoreFiles output. If the
  // fetch changes which files it keeps or how it decodes them, every digest
  // changes and every deployment would refuse every release: this pins it.
  it('is stable for the files fetchCoreFiles returns', async () => {
    const archive = await tarball({
      'core/aidlc-common/stages/a.md': 'café\r\nline\n',
      'core/tools/b.ts': 'export const b = 1;\n',
      'README.md': 'not core\n',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => archive,
      })),
    );
    const files = await fetchCoreFiles('a'.repeat(40));
    expect([...files.keys()]).toEqual(['core/aidlc-common/stages/a.md', 'core/tools/b.ts']);
    expect(sourceDigestOf(files)).toBe(
      'e488ab9b09d6d513e45138d145257b303486522a0510c34647076d0f4c728610',
    );
  });
});
