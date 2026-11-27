#!/usr/bin/env node

// Detects AI-DLC releases newer than every supported profile and checks each
// one's source before anyone onboards it. The result is a report for a
// maintainer: this script never changes code, the release registry or a
// deployment, and onboarding stays a reviewed pull request.
//
//   node scripts/aidlc-release-watch/check.mjs [--tag vX.Y.Z] [--out <dir>]
//
// GITHUB_TOKEN, when set, raises the GitHub API rate limit; it needs no scope.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AIDLC_COMPATIBILITY_PROFILES } from '../../lambda/shared/aidlc-compatibility-profiles.js';
import { sourceDigestOf } from '../../lambda/shared/aidlc-source-integrity.js';
import { fetchRepoFiles } from '../../lambda/shared/repo-fetch.js';
import { qualificationSections, qualifyRelease } from './qualify.mjs';
import { renderReport } from './report.mjs';
import {
  WatchInfraError,
  changedCoreFiles,
  compareTreeWithArchive,
  coreTreeSha,
  distHarnesses,
  githubClient,
  listNewReleases,
  newestProfile,
  peelTag,
  readCoreTree,
  readRelease,
  versionOfTag,
} from './source.mjs';

const OUTPUT_FILE = 'aidlc-release-watch.json';

// A codeload answer other than the archive (outage, rate limit, a refusal
// for a commit the tree API lists) or no answer at all says nothing about the
// release; an archive that cannot be extracted does.
const isTransientFetchError = (error) =>
  error?.message === 'fetch failed' ||
  error?.name === 'TimeoutError' ||
  / returned \d{3}\b/.test(String(error?.message));

const check = (id, ok, detail, paths = []) => ({ id, ok, detail, paths });

const checkRelease = async ({ github, fetchFiles, profiles, release }) => {
  const result = {
    tag: release.tag,
    version: release.tag.slice(1),
    publishedAt: release.publishedAt,
    immutable: release.immutable,
    sha: null,
    supportedProfileId: null,
    checks: [],
    files: null,
  };
  const finish = () => ({
    ...result,
    verdict: result.checks.every(({ ok }) => ok)
      ? result.supportedProfileId
        ? 'already-supported'
        : 'verified'
      : 'integrity-failed',
  });

  result.sha = await peelTag({ github, tag: release.tag });
  result.checks.push(
    check(
      'tag',
      Boolean(result.sha),
      result.sha ? `names commit ${result.sha}` : 'does not name a commit',
    ),
  );
  if (!result.sha) return finish();
  result.supportedProfileId =
    profiles.find((profile) => profile.upstreamRef === result.sha)?.id ?? null;

  let files;
  try {
    files = await fetchFiles(result.sha);
  } catch (error) {
    if (isTransientFetchError(error)) {
      throw new WatchInfraError(
        `the ${release.tag} archive could not be downloaded: ${error.message}`,
      );
    }
    result.checks.push(check('archive', false, `could not be read: ${error.message}`));
    return finish();
  }
  result.checks.push(check('archive', true, `holds ${files.size} core/ files at the commit`));

  const tree = await readCoreTree({ github, sha: result.sha });
  if (tree.error) {
    result.checks.push(check('tree', false, tree.error));
    return finish();
  }
  const { changed, missing, extra } = compareTreeWithArchive({ blobs: tree.blobs, files });
  const mismatched = [...changed, ...missing, ...extra];
  result.checks.push(
    check(
      'tree',
      mismatched.length === 0,
      mismatched.length === 0
        ? `every archive file is the git blob the commit's tree names (${tree.blobs.size} files${tree.skipped ? `, ${tree.skipped} links not compared` : ''})`
        : `${changed.length} changed, ${missing.length} missing and ${extra.length} unexpected files against the commit's tree`,
      mismatched,
    ),
  );

  // The pin is the commit; a tag that moved while this ran makes the report
  // describe a commit the tag no longer names.
  const again = await peelTag({ github, tag: release.tag });
  result.checks.push(
    check(
      'tag-stable',
      again === result.sha,
      again === result.sha
        ? 'named the same commit at the end of the check'
        : 'moved during the check',
    ),
  );
  if (mismatched.length === 0 && again === result.sha) result.files = files;
  return finish();
};

// A supported version's tag should still name the commit its profile pins, or
// at least one with the same core/ tree (2.11.3 pins the preview commit its tag
// was promoted from, which changed only release metadata). Reported, never
// enforced: the profile pin is what installations load.
const checkDrift = async ({ github, profiles }) => {
  const drift = [];
  for (const profile of profiles) {
    if (profile.upstreamChannel === 'commit' || !versionOfTag(`v${profile.upstreamVersion}`)) {
      continue;
    }
    const sha = await peelTag({ github, tag: `v${profile.upstreamVersion}` });
    if (sha === profile.upstreamRef) continue;
    const pinnedCore = await coreTreeSha({ github, sha: profile.upstreamRef });
    if (sha && pinnedCore && (await coreTreeSha({ github, sha })) === pinnedCore) continue;
    drift.push({
      profileId: profile.id,
      version: profile.upstreamVersion,
      tagSha: sha,
      changed: sha ? await changedCoreFiles({ github, base: profile.upstreamRef, head: sha }) : [],
    });
  }
  return drift;
};

// The newest supported version's real tree, the baseline a release is
// qualified against. It must still be the source its profile certified.
const readBaseline = async ({ fetchFiles, newest }) => {
  let files;
  try {
    files = await fetchFiles(newest.upstreamRef);
  } catch (error) {
    if (isTransientFetchError(error)) {
      throw new WatchInfraError(
        `the ${newest.upstreamVersion} archive could not be downloaded: ${error.message}`,
      );
    }
    throw error;
  }
  const digest = sourceDigestOf(
    new Map([...files].map(([name, content]) => [name, Buffer.from(content).toString('utf8')])),
  );
  const ok = digest === newest.sourceDigest;
  return {
    files: ok ? files : null,
    check: check(
      'baseline',
      ok,
      ok
        ? `${newest.upstreamVersion}, the version this release is compared with, is still its certified source`
        : `${newest.upstreamVersion}, the version this release is compared with, is no longer its certified source`,
    ),
  };
};

const watchReleases = async ({
  github,
  fetchFiles,
  profiles = Object.values(AIDLC_COMPATIBILITY_PROFILES),
  tag = null,
}) => {
  let releases;
  if (tag) {
    const release = await readRelease({ github, tag });
    releases = [release ?? { tag, immutable: false, publishedAt: null, missing: true }];
  } else {
    releases = await listNewReleases({ github, profiles });
  }
  if (releases.length === 0)
    return { newest: newestProfile(profiles).upstreamVersion, reports: [] };
  const drift = await checkDrift({ github, profiles });
  const reports = [];
  let baseline = null;
  for (const release of releases) {
    const result = release.missing
      ? {
          tag,
          version: tag.slice(1),
          sha: null,
          supportedProfileId: null,
          checks: [check('release', false, 'has no published release')],
          verdict: 'integrity-failed',
        }
      : await checkRelease({ github, fetchFiles, profiles, release });
    let sections = [];
    if (result.verdict === 'verified') {
      baseline ??= await readBaseline({ fetchFiles, newest: newestProfile(profiles) });
      result.checks.push(baseline.check);
    }
    if (result.verdict === 'verified' && baseline.check.ok) {
      const qualification = qualifyRelease({
        result,
        newest: newestProfile(profiles),
        baselineFiles: baseline.files,
        distribution: {
          harnesses: await distHarnesses({ github, sha: result.sha }),
          assets: release.assets ?? [],
        },
      });
      result.verdict = qualification.verdict;
      result.qualification = qualification;
      sections = qualificationSections(qualification);
    } else if (result.verdict === 'verified') {
      result.verdict = 'integrity-failed';
    }
    reports.push({ ...result, ...renderReport({ result, drift, sections }) });
  }
  return { newest: newestProfile(profiles).upstreamVersion, reports };
};

const parseArgs = (argv) => {
  const options = { tag: null, out: '.' };
  for (let index = 0; index < argv.length; index += 1) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (name === '--tag' && versionOfTag(value)) options.tag = value;
    else if (name === '--out' && value) options.out = value;
    else throw new Error(`usage: check.mjs [--tag vX.Y.Z] [--out <dir>] (unexpected ${name})`);
    index += 1;
  }
  return options;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const { newest, reports } = await watchReleases({
    github: githubClient({ token: process.env.GITHUB_TOKEN || null }),
    fetchFiles: (sha) => fetchRepoFiles(sha, { prefixes: ['core/'] }),
    tag: options.tag,
  });
  await mkdir(options.out, { recursive: true });
  const output = reports.map(({ tag, sha, verdict, title, body }) => ({
    tag,
    sha,
    verdict,
    title,
    body,
  }));
  await writeFile(
    path.join(options.out, OUTPUT_FILE),
    `${JSON.stringify({ reports: output }, null, 2)}\n`,
  );
  if (reports.length === 0) console.log(`No AI-DLC release newer than ${newest}.`);
  for (const { tag, sha, verdict } of reports) {
    console.log(`AI-DLC ${tag} at ${sha ?? 'no commit'}: ${verdict}`);
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { OUTPUT_FILE, checkRelease, parseArgs, watchReleases };
