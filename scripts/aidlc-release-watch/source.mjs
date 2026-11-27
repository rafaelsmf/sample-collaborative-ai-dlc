// Reads AI-DLC releases from GitHub and checks that the core/ tree a release
// tag names is the one codeload serves. Everything upstream returns is
// untrusted data: it is validated, hashed and compared, never executed.
import { createHash } from 'node:crypto';

const REPOSITORY = 'awslabs/aidlc-workflows';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
// Regular and executable files; a symlink or submodule entry has no file
// content in the archive to compare.
const FILE_MODES = new Set(['100644', '100755']);

// GitHub could not be read (rate limit, outage, permission). Nothing is
// reported for the run: a missing answer is not evidence about a release.
class WatchInfraError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WatchInfraError';
  }
}

const versionOfTag = (tag) => {
  const match = TAG_RE.exec(String(tag));
  return match ? match.slice(1).map(Number) : null;
};

const compareVersions = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index] - right[index];
    if (delta !== 0) return delta;
  }
  return 0;
};

const versionOfProfile = (profile) => versionOfTag(`v${profile.upstreamVersion}`);

const newestProfile = (profiles) =>
  profiles
    .filter((profile) => versionOfProfile(profile))
    .toSorted((left, right) => compareVersions(versionOfProfile(left), versionOfProfile(right)))
    .at(-1);

const githubClient = ({ fetchImpl = fetch, token = null, timeoutMs = 30_000 } = {}) => {
  const request = async (path) => {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'collaborative-ai-dlc',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (error) {
      throw new WatchInfraError(`GitHub API ${path} could not be reached: ${error.message}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new WatchInfraError(`GitHub API ${path} answered ${response.status}`);
    }
    return response.json();
  };
  return { request };
};

// Published, non-prerelease releases whose tag is a plain version newer than
// every supported profile. A skipped older version (2.10.0) is never reported.
const listNewReleases = async ({ github, profiles }) => {
  const releases = await github.request('/releases?per_page=100');
  if (!Array.isArray(releases)) throw new WatchInfraError('GitHub API /releases is not a list');
  const newest = versionOfProfile(newestProfile(profiles));
  return releases
    .filter(
      (release) =>
        release?.draft === false &&
        release?.prerelease === false &&
        versionOfTag(release.tag_name) &&
        compareVersions(versionOfTag(release.tag_name), newest) > 0,
    )
    .map(releaseSummary)
    .toSorted((left, right) => compareVersions(versionOfTag(left.tag), versionOfTag(right.tag)));
};

const releaseSummary = (release) => ({
  tag: release.tag_name,
  immutable: release.immutable === true,
  publishedAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(release.published_at ?? '')
    ? release.published_at
    : null,
});

const readRelease = async ({ github, tag }) => {
  const release = await github.request(`/releases/tags/${tag}`);
  return release && release.draft === false ? releaseSummary(release) : null;
};

// A lightweight tag names the commit; an annotated tag names a tag object
// that names it. Anything else is not a release commit.
const peelTag = async ({ github, tag }) => {
  const ref = await github.request(`/git/ref/tags/${tag}`);
  let object = ref?.object;
  if (object?.type === 'tag' && SHA_RE.test(object.sha ?? '')) {
    object = (await github.request(`/git/tags/${object.sha}`))?.object;
  }
  return object?.type === 'commit' && SHA_RE.test(object.sha ?? '') ? object.sha : null;
};

const gitBlobSha = (content) =>
  createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');

// The git tree of the commit's core/ directory, from the API: a channel
// independent of the codeload archive the import downloads.
const coreTreeSha = async ({ github, sha }) => {
  const root = await github.request(`/git/trees/${sha}`);
  const core = root?.tree?.find((entry) => entry.path === 'core' && entry.type === 'tree');
  return SHA_RE.test(core?.sha ?? '') ? core.sha : null;
};

// The core/ files that differ between two commits, from the compare API.
const changedCoreFiles = async ({ github, base, head }) => {
  const comparison = await github.request(`/compare/${base}...${head}`);
  return (comparison?.files ?? [])
    .map((file) => file?.filename)
    .filter((name) => typeof name === 'string' && name.startsWith('core/'))
    .toSorted();
};

const readCoreTree = async ({ github, sha }) => {
  const coreSha = await coreTreeSha({ github, sha });
  if (!coreSha) return { error: 'the commit has no core/ tree' };
  const tree = await github.request(`/git/trees/${coreSha}?recursive=1`);
  if (!tree || !Array.isArray(tree.tree)) return { error: 'the core/ tree could not be read' };
  if (tree.truncated) return { error: 'the core/ tree is too large to list in one answer' };
  const blobs = new Map();
  let skipped = 0;
  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    if (!FILE_MODES.has(entry.mode)) {
      skipped += 1;
      continue;
    }
    blobs.set(`core/${entry.path}`, entry.sha);
  }
  return { blobs, skipped };
};

// Every core/ file the archive holds must be a blob of the commit's tree with
// the same git object id, and every tree blob must be in the archive.
const compareTreeWithArchive = ({ blobs, files }) => {
  const changed = [];
  const missing = [];
  const extra = [];
  for (const [path, sha] of blobs) {
    if (!files.has(path)) missing.push(path);
    else if (gitBlobSha(files.get(path)) !== sha) changed.push(path);
  }
  for (const path of files.keys()) if (!blobs.has(path)) extra.push(path);
  return { changed, missing, extra };
};

export {
  REPOSITORY,
  SHA_RE,
  WatchInfraError,
  changedCoreFiles,
  compareTreeWithArchive,
  compareVersions,
  coreTreeSha,
  gitBlobSha,
  githubClient,
  listNewReleases,
  newestProfile,
  peelTag,
  readCoreTree,
  readRelease,
  versionOfTag,
};
