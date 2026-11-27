import { createHash } from 'node:crypto';

import { AidlcReleaseError } from './aidlc-release.js';
import { canonicalJson } from './workflow-checkpoint.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// The source digest of an official release identifies the exact `core/` tree
// its compatibility evidence was certified from: the SHA-256 of the canonical
// map from every `core/` path to the SHA-256 of that file's text, as
// `fetchCoreFiles` returns it. The compatibility fixture stores the same map as
// `originalFileHashes`, so the digest can be checked offline, and any change to
// what `fetchCoreFiles` returns (prefix, decoding) changes every digest.
const sourceFileHashes = (files) =>
  Object.fromEntries([...files].map(([path, content]) => [path, sha256(content)]));

const sourceDigestOfHashes = (fileHashes) => sha256(canonicalJson(fileHashes));

const sourceDigestOf = (files) => sourceDigestOfHashes(sourceFileHashes(files));

const shortDigest = (digest) => String(digest).slice(0, 12);

// Refuses to load an official release whose fetched `core/` tree is not the one
// its profile was certified from, before anything is built or written. A custom
// fork has no certified source and is not checked. The error names only the
// version, commit and digest prefixes, never file content.
const assertOfficialSource = ({ profile, files }) => {
  if (profile?.custom === true) return null;
  const actual = sourceDigestOf(files);
  if (actual === profile?.sourceDigest) return actual;
  throw new AidlcReleaseError(
    'release_source_mismatch',
    `release_source_mismatch: AI-DLC ${profile?.upstreamVersion} at ${String(profile?.upstreamRef).slice(0, 12)} ` +
      `fetched ${files.size} core/ files whose source digest ${shortDigest(actual)} is not the certified ` +
      `${profile?.sourceDigest ? shortDigest(profile.sourceDigest) : '(none recorded)'}`,
  );
};

export { assertOfficialSource, sourceDigestOf, sourceDigestOfHashes, sourceFileHashes };
