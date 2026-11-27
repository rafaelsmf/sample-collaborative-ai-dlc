import { createHash } from 'node:crypto';

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

export { sourceDigestOf, sourceDigestOfHashes, sourceFileHashes };
