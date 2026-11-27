import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';

import { filesFromCompatibilityFixture } from '../../lambda/shared/aidlc-compatibility.js';
import { AIDLC_COMPATIBILITY_PROFILES } from '../../lambda/shared/aidlc-compatibility-profiles.js';
import { sourceDigestOf } from '../../lambda/shared/aidlc-source-integrity.js';
import { parseArgs, watchReleases } from '../aidlc-release-watch/check.mjs';
import {
  commandFamily,
  qualificationSections,
  qualifyRelease,
} from '../aidlc-release-watch/qualify.mjs';
import { safePath } from '../aidlc-release-watch/report.mjs';
import { WatchInfraError, gitBlobSha, githubClient } from '../aidlc-release-watch/source.mjs';

const sha = (char) => char.repeat(40);
const text = (map) => new Map([...map].map(([path, content]) => [path, content.toString()]));
// The newest supported version, certified as whatever tree a test serves for
// its commit (the real digest names the unredacted upstream tree).
const newestCertifiedAs = (files) => ({
  ...AIDLC_COMPATIBILITY_PROFILES['v2.11.5'],
  sourceDigest: sourceDigestOf(text(files)),
});
const NEW_SHA = sha('a');

// A two-file tree for the source checks, which never get to import it.
const coreFiles = () =>
  new Map([
    ['core/aidlc-common/stages/inception/a.md', Buffer.from('---\nslug: a\n---\nbody\n')],
    ['core/tools/run.sh', Buffer.from('#!/bin/sh\necho hi\n')],
  ]);

// The 2.11.5 tree as its fixture records it, which this build imports.
const releaseFiles = () =>
  new Map(
    [
      ...filesFromCompatibilityFixture({
        profileId: 'v2.11.5',
        fixture: JSON.parse(
          readFileSync(
            new URL(
              '../../lambda/shared/test/fixtures/aidlc-compatibility/v2.11.5.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      }),
    ].map(([path, content]) => [path, Buffer.from(content)]),
  );

const SUPPORTED = newestCertifiedAs(coreFiles());
const PROFILES = [SUPPORTED];

// A fake upstream: releases, tags, and for each commit its core/ tree and the
// archive codeload serves. `routes` overrides any API answer.
const upstream = ({
  releases = [
    { tag_name: 'v2.12.0', draft: false, prerelease: false, published_at: '2026-12-01T00:00:00Z' },
  ],
  tags = {
    'v2.12.0': { type: 'commit', sha: NEW_SHA },
    'v2.11.5': { type: 'commit', sha: SUPPORTED.upstreamRef },
  },
  trees = { [NEW_SHA]: coreFiles(), [SUPPORTED.upstreamRef]: coreFiles() },
  archives = trees,
  routes = {},
} = {}) => {
  const calls = [];
  const coreSha = (commit) => `c${commit.slice(1)}`;
  const answer = (path) => {
    if (Object.hasOwn(routes, path)) return routes[path]();
    if (path === '/releases?per_page=100') return releases;
    let match = /^\/releases\/tags\/(.+)$/.exec(path);
    if (match) return releases.find((release) => release.tag_name === match[1]) ?? null;
    match = /^\/git\/ref\/tags\/(.+)$/.exec(path);
    if (match) return tags[match[1]] ? { object: tags[match[1]] } : null;
    match = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path);
    if (match && trees[match[1]]) {
      return { tree: [{ path: 'core', type: 'tree', sha: coreSha(match[1]) }] };
    }
    match = /^\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path);
    const commit = match && Object.keys(trees).find((key) => coreSha(key) === match[1]);
    if (commit) {
      return {
        truncated: false,
        tree: [
          { path: 'aidlc-common', type: 'tree', mode: '040000', sha: sha('d') },
          ...[...trees[commit]].map(([file, content]) => ({
            path: file.slice('core/'.length),
            type: 'blob',
            mode: '100644',
            sha: gitBlobSha(content),
          })),
        ],
      };
    }
    return null;
  };
  const github = {
    calls,
    request: async (path) => {
      calls.push(path);
      return answer(path);
    },
  };
  const fetchFiles = async (commit) => {
    if (!archives[commit]) throw new Error(`repo-fetch: no files found for ref ${commit}`);
    return new Map(archives[commit]);
  };
  return { github, fetchFiles };
};

const run = (fake, options = {}) => watchReleases({ ...fake, profiles: PROFILES, ...options });

test('reports nothing when no published release is newer than every supported version', async () => {
  const fake = upstream({
    releases: [
      { tag_name: 'v2.11.5', draft: false, prerelease: false },
      { tag_name: 'v2.10.0', draft: false, prerelease: false },
      { tag_name: 'v2.13.0', draft: true, prerelease: false },
      { tag_name: 'v2.12.0', draft: false, prerelease: true },
      { tag_name: 'v2.12.0-rc.1', draft: false, prerelease: false },
    ],
  });
  assert.deepEqual(await run(fake), { newest: '2.11.5', reports: [] });
  assert.deepEqual(fake.github.calls, ['/releases?per_page=100']);
});

test('verifies a new release whose archive is the tree its tag names', async () => {
  const { reports } = await run(upstream());
  assert.equal(reports.length, 1);
  const [report] = reports;
  assert.ok(report.checks.every(({ ok }) => ok));
  assert.equal(report.verdict, 'needs-work', 'a two-file tree is not an importable release');
  assert.equal(report.sha, NEW_SHA);
  assert.equal(report.files.size, 2);
  assert.equal(report.title, 'AI-DLC 2.12.0: release qualification report');
  assert.ok(report.body.startsWith(`<!-- aidlc-release-watch:v2.12.0@${NEW_SHA} -->\n`));
  assert.match(
    report.body,
    /✅ \*\*tree\*\*: every archive file is the git blob the commit's tree names \(2 files\)/,
  );
  assert.match(report.body, /Verdict: `needs-work`/);
});

test('peels an annotated tag to its commit', async () => {
  const tagObject = sha('7');
  const { reports } = await run(
    upstream({
      tags: {
        'v2.12.0': { type: 'tag', sha: tagObject },
        'v2.11.5': { type: 'commit', sha: SUPPORTED.upstreamRef },
      },
      routes: { [`/git/tags/${tagObject}`]: () => ({ object: { type: 'commit', sha: NEW_SHA } }) },
    }),
  );
  assert.equal(reports[0].sha, NEW_SHA);
  assert.ok(reports[0].checks.every(({ ok }) => ok));
});

test('fails integrity when the archive holds other bytes, or files the tree does not', async () => {
  const tampered = coreFiles();
  tampered.set('core/tools/run.sh', Buffer.from('#!/bin/sh\ncurl evil\n'));
  tampered.set('core/tools/extra.sh', Buffer.from('x'));
  tampered.delete('core/aidlc-common/stages/inception/a.md');
  const { reports } = await run(upstream({ archives: { [NEW_SHA]: tampered } }));
  const tree = reports[0].checks.find(({ id }) => id === 'tree');
  assert.equal(reports[0].verdict, 'integrity-failed');
  assert.equal(reports[0].files, null);
  assert.equal(
    tree.detail,
    "1 changed, 1 missing and 1 unexpected files against the commit's tree",
  );
  assert.deepEqual(tree.paths, [
    'core/tools/run.sh',
    'core/aidlc-common/stages/inception/a.md',
    'core/tools/extra.sh',
  ]);
  assert.match(reports[0].body, /❌ \*\*tree\*\*/);
  assert.match(reports[0].body, /Do not onboard it/);
});

test('fails integrity on a truncated tree, a tag that moves, or an archive that cannot be read', async () => {
  const truncated = await run(
    upstream({
      routes: {
        [`/git/trees/c${NEW_SHA.slice(1)}?recursive=1`]: () => ({ truncated: true, tree: [] }),
      },
    }),
  );
  assert.equal(truncated.reports[0].verdict, 'integrity-failed');
  assert.match(truncated.reports[0].body, /too large to list in one answer/);

  let peels = 0;
  const moved = await run(
    upstream({
      routes: {
        '/git/ref/tags/v2.12.0': () => ({
          object: { type: 'commit', sha: (peels += 1) === 1 ? NEW_SHA : sha('b') },
        }),
      },
    }),
  );
  assert.equal(moved.reports[0].verdict, 'integrity-failed');
  assert.match(moved.reports[0].body, /❌ \*\*tag-stable\*\*: moved during the check/);

  const unreadable = await run(upstream({ archives: {} }));
  assert.equal(unreadable.reports[0].verdict, 'integrity-failed');
  assert.match(
    unreadable.reports[0].body,
    /❌ \*\*archive\*\*: could not be read: repo-fetch: no files found/,
  );
});

test('reports no verdict when GitHub or codeload are unavailable', async () => {
  await assert.rejects(
    run(
      upstream({
        routes: {
          '/releases?per_page=100': () => {
            throw new WatchInfraError('GitHub API /releases?per_page=100 answered 403');
          },
        },
      }),
    ),
    { name: 'WatchInfraError' },
  );
  for (const failure of [
    new Error('repo-fetch: https://codeload.github.com/x returned 503 Service Unavailable'),
    new Error('repo-fetch: https://codeload.github.com/x returned 404 Not Found'),
    new TypeError('fetch failed'),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  ]) {
    const fake = upstream();
    fake.fetchFiles = async () => {
      throw failure;
    };
    await assert.rejects(run(fake), /v2\.12\.0 archive could not be downloaded/);
  }
});

test('the GitHub client bounds each request', async () => {
  const github = githubClient({
    timeoutMs: 5,
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  await assert.rejects(github.request('/releases?per_page=100'), {
    name: 'WatchInfraError',
    message: /could not be reached/,
  });
});

test('the GitHub client treats 404 as absent and any other failure as unavailable', async () => {
  const answers = { 404: null, 403: 'throws' };
  for (const status of [404, 403]) {
    const github = githubClient({
      token: 't0k',
      fetchImpl: async (url, { headers }) => {
        assert.equal(headers.Authorization, 'Bearer t0k');
        assert.equal(
          url,
          'https://api.github.com/repos/awslabs/aidlc-workflows/releases?per_page=100',
        );
        return { status, ok: false, json: async () => ({}) };
      },
    });
    if (answers[status] === null)
      assert.equal(await github.request('/releases?per_page=100'), null);
    else
      await assert.rejects(github.request('/releases?per_page=100'), { name: 'WatchInfraError' });
  }
});

test('a requested tag that is already supported, or has no release, is reported as such', async () => {
  const fake = upstream({
    releases: [{ tag_name: 'v2.11.5', draft: false, prerelease: false }],
  });
  const { reports } = await run(fake, { tag: 'v2.11.5' });
  assert.equal(reports[0].verdict, 'already-supported');
  assert.match(reports[0].body, /\| Supported as \| `v2\.11\.5` \|/);

  const missing = await run(upstream({ releases: [] }), { tag: 'v2.12.0' });
  assert.equal(missing.reports[0].verdict, 'integrity-failed');
  assert.match(missing.reports[0].body, /❌ \*\*release\*\*: has no published release/);
});

test('reports a supported version whose tag now names other core/ content', async () => {
  const promoted = sha('6');
  const sameCore = await run(
    upstream({
      tags: {
        'v2.12.0': { type: 'commit', sha: NEW_SHA },
        'v2.11.5': { type: 'commit', sha: promoted },
      },
      routes: {
        [`/git/trees/${promoted}`]: () => ({
          tree: [{ path: 'core', type: 'tree', sha: `c${SUPPORTED.upstreamRef.slice(1)}` }],
        }),
      },
    }),
  );
  assert.doesNotMatch(sameCore.reports[0].body, /tag now names other core/);

  const otherCore = await run(
    upstream({
      tags: {
        'v2.12.0': { type: 'commit', sha: NEW_SHA },
        'v2.11.5': { type: 'commit', sha: promoted },
      },
      routes: {
        [`/git/trees/${promoted}`]: () => ({
          tree: [{ path: 'core', type: 'tree', sha: sha('e') }],
        }),
        [`/compare/${SUPPORTED.upstreamRef}...${promoted}`]: () => ({
          files: [{ filename: 'CHANGELOG.md' }, { filename: 'core/tools/aidlc-version.ts' }],
        }),
      },
    }),
  );
  assert.match(otherCore.reports[0].body, /tag now names other core\/ content/);
  assert.ok(
    otherCore.reports[0].body.includes(
      `- 2.11.5: the tag names \`${promoted}\`, which changes \`core/tools/aidlc-version.ts\``,
    ),
  );
});

test('hashes files as git blobs', () => {
  assert.equal(gitBlobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(gitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
});

test('an error message in a check detail cannot format the report', async () => {
  const fake = upstream();
  fake.fetchFiles = async () => {
    throw new Error('repo-fetch: bad `code` <img> [x](y) @user\u202e|*_');
  };
  const { reports } = await run(fake);
  assert.match(
    reports[0].body,
    /could not be read: repo-fetch: bad 'code' 'img' 'x'\(y\) 'user'''/,
  );
});

test('upstream file names cannot mention, link or format in the report', () => {
  assert.equal(
    safePath('core/`@user` [x](http://e)<!--\n.md'),
    'core/??user???x??http?//e???--?.md',
  );
});

test('accepts only a plain version tag and an output directory', () => {
  assert.deepEqual(parseArgs(['--tag', 'v2.12.0', '--out', '/tmp/x']), {
    tag: 'v2.12.0',
    out: '/tmp/x',
  });
  for (const argv of [['--tag', 'main'], ['--tag', 'v2.12.0;rm'], ['--other']]) {
    assert.throws(() => parseArgs(argv), /usage: check\.mjs/);
  }
});

// The 2.11.5 requirements-analysis `outputs` value is invalid YAML that only
// the per-version normalization repairs; a release that fixed it upstream.
const REQUIREMENTS = 'core/aidlc-common/stages/inception/requirements-analysis.md';
const quoteOutputs = (files) => {
  const source = files.get(REQUIREMENTS).toString();
  const fixed = source.replace(
    /^outputs: (.*)$/m,
    (_line, value) => `outputs: ${JSON.stringify(value)}`,
  );
  assert.notEqual(fixed, source);
  files.set(REQUIREMENTS, Buffer.from(fixed));
};

const qualified = async (mutate = quoteOutputs) => {
  const files = releaseFiles();
  mutate(files);
  const { reports } = await run(
    upstream({
      releases: [
        {
          tag_name: 'v2.12.0',
          draft: false,
          prerelease: false,
          assets: [{ name: 'aidlc-runtime-2.12.0.tar.gz' }, { name: '<b>evil</b>' }],
        },
      ],
      trees: { [NEW_SHA]: files, [SUPPORTED.upstreamRef]: releaseFiles() },
    }),
    { profiles: [newestCertifiedAs(releaseFiles())] },
  );
  return reports[0];
};

test('a release this build imports as committed, with no new gap, is ready', async () => {
  const report = await qualified();
  assert.equal(report.verdict, 'ready');
  assert.equal(report.qualification.profile.baseProfileId, undefined);
  assert.equal(report.qualification.profile.frontmatterDialect, SUPPORTED.frontmatterDialect);
  assert.match(report.body, /Verdict: `ready`/);
  assert.match(report.body, /✅ \*\*baseline\*\*/);
  assert.match(report.body, /Importable: yes/);
  assert.match(report.body, /0 not in 2\.11\.5/);
  assert.match(report.body, /<summary>stages: 1 files<\/summary>/);
  const files = releaseFiles();
  quoteOutputs(files);
  const digest = sourceDigestOf(text(files));
  assert.equal(report.qualification.profile.sourceDigest, digest);
  assert.ok(report.body.includes(`sourceDigest: '${digest}'`));
  assert.doesNotMatch(report.body, /baseProfileId/);
  assert.match(report.body, new RegExp(`releaseId: 'aidlc:${NEW_SHA}'`));
  assert.match(report.body, /Release assets: `aidlc-runtime-2\.12\.0\.tar\.gz`$/m);
  assert.match(report.body, /^- claude: through the runtime asset$/m);
  assert.match(
    report.body,
    /`aidlc-runtime-2\.12\.0\.tar\.gz` release asset once the profile names `runtimeReleaseTag`/,
  );
  assert.ok(report.body.includes("    runtimeReleaseTag: 'v2.12.0',"));
});

test('a release with neither dist/ nor a runtime asset has no native export', () => {
  const { body } = qualifyDirectly(() => {});
  assert.match(body, /^- claude: \*\*no\*\*, neither `dist\/claude\/` nor a runtime asset$/m);
  assert.doesNotMatch(body, /runtimeReleaseTag: '/);
});

test('a release that still needs a per-version normalization is not ready, and says which', async () => {
  const report = await qualified(() => {});
  assert.equal(report.verdict, 'needs-work');
  assert.match(report.body, /Importable: \*\*no\*\*/);
  assert.match(
    report.body,
    /Imports once `v2\.12\.0` joins the per-version import normalizations 2\.11\.5 gets/,
  );
});

test('a baseline that is no longer its certified source stops the qualification', async () => {
  const files = releaseFiles();
  quoteOutputs(files);
  const { reports } = await run(
    upstream({ trees: { [NEW_SHA]: files, [SUPPORTED.upstreamRef]: releaseFiles() } }),
    { profiles: [newestCertifiedAs(coreFiles())] },
  );
  assert.equal(reports[0].verdict, 'integrity-failed');
  assert.equal(reports[0].qualification, undefined);
  assert.match(
    reports[0].body,
    /❌ \*\*baseline\*\*: 2\.11\.5, the version this release is compared with, is no longer its certified source/,
  );
});

const qualifyDirectly = (mutate) => {
  const files = releaseFiles();
  quoteOutputs(files);
  mutate(files);
  const qualification = qualifyRelease({
    result: { version: '2.12.0', sha: NEW_SHA, files },
    newest: SUPPORTED,
    baselineFiles: releaseFiles(),
    distribution: { harnesses: [], assets: [] },
  });
  return { qualification, body: qualificationSections(qualification).flat().join('\n') };
};

test('a release whose stage no longer parses needs work and lists the change', () => {
  const stage = 'core/aidlc-common/stages/inception/requirements-analysis.md';
  const { qualification, body } = qualifyDirectly((files) => {
    assert.ok(files.has(stage));
    files.set(stage, Buffer.from('---\nslug: [broken\n---\n'));
  });
  assert.equal(qualification.verdict, 'needs-work');
  assert.match(body, /Importable: \*\*no\*\*/);
  assert.match(body, /diagnostics<\/summary>/);
  assert.match(body, /<summary>stages: 1 files<\/summary>/);
  assert.ok(body.includes(`changed ${stage}`));
});

test('a certification gap the newest version does not have holds a release back', () => {
  const { qualification, body } = qualifyDirectly((files) => {
    const stage = [...files.keys()].find((path) => path.startsWith('core/aidlc-common/stages/'));
    files.set(
      stage,
      Buffer.from(`${files.get(stage)}\nRun \`{{INVOKE}} engine brand-new-command --x\`.\n`),
    );
  });
  assert.equal(qualification.analysis.importable, true);
  assert.equal(qualification.bundle.ok, true);
  assert.equal(qualification.verdict, 'needs-work');
  assert.ok(qualification.analysis.newGaps.some((gap) => gap.includes('engine brand-new-command')));
  assert.match(body, /certification gaps not in 2\.11\.5<\/summary>/);
  assert.deepEqual(qualification.commands.added, ['engine brand-new-command']);
});

test('lists runtime file changes first, for review before approval', () => {
  const { body } = qualifyDirectly((files) => {
    const tool = [...files.keys()].find((path) => path.startsWith('core/tools/'));
    files.set(tool, Buffer.from(`${files.get(tool)}\n// changed\n`));
    files.set('core/hooks/new-hook.sh', Buffer.from('#!/bin/sh\n'));
    files.set('core/agents/new-agent.md', Buffer.from('x'));
  });
  const runtime = body.indexOf('<summary>runtime (tools, hooks, protocols, conductor): 2 files');
  assert.ok(runtime > 0);
  assert.ok(runtime < body.indexOf('<summary>agents: 1 files'));
  assert.ok(body.includes('added   core/hooks/new-hook.sh'));
});

test('names engine command families by their command words', () => {
  assert.equal(commandFamily('Run `{{INVOKE}} engine graph ars --iae <s>`'), 'engine graph ars');
  assert.equal(commandFamily('{{INVOKE}} engine intent add-repo <url>'), 'engine intent add-repo');
});

test('an upstream line cannot close the code block it is shown in', () => {
  const { qualification, body } = qualifyDirectly((files) => {
    files.set('core/agents/evil.md', Buffer.from('{{INVOKE}} engine evil ```` \u0007@user\n'));
  });
  assert.deepEqual(qualification.commands.added, ['engine evil']);
  const start = body.indexOf('`````text\n+ {{INVOKE}} engine evil ```` @user\n');
  assert.ok(
    start > 0,
    'shown in a fence longer than its backtick run, without the control character',
  );
  assert.ok(body.indexOf('\n`````\n', start) > start, 'the same fence closes the block');
});
