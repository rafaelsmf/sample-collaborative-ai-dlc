// Qualifies a verified upstream release in memory, the way an import of it
// would run, and compares it with the newest supported profile. Nothing is
// published: the importer and the analyzer are pure over the fetched files.
import { analyzeAidlcCompatibility } from '../../lambda/shared/aidlc-compatibility.js';
import { buildReleaseBundle } from '../../lambda/shared/aidlc-release.js';
import { NATIVE_DISTRIBUTION_HARNESSES } from '../../lambda/shared/release-distributions.js';
import { sourceDigestOf, sourceFileHashes } from '../../lambda/shared/aidlc-source-integrity.js';
import { safePath } from './report.mjs';

const MAX_LIST = 40;
const INVOKE = '{{INVOKE}} engine';

// Where a changed file matters: runtime files are code and protocols the agent
// runtime executes once a release is approved, so a reviewer reads them first.
const AREAS = [
  [
    'runtime (tools, hooks, protocols, conductor)',
    (path) =>
      (path.startsWith('core/tools/') && !path.startsWith('core/tools/data/')) ||
      path.startsWith('core/hooks/') ||
      path.startsWith('core/aidlc-common/protocols/') ||
      path === 'core/aidlc-common/conductor.md',
  ],
  ['stages', (path) => path.startsWith('core/aidlc-common/stages/')],
  ['agents', (path) => path.startsWith('core/agents/')],
  ['scopes', (path) => path.startsWith('core/scopes/')],
  ['sensors', (path) => path.startsWith('core/sensors/')],
  ['skills', (path) => path.startsWith('core/skills/')],
  ['other', () => true],
];

const textFiles = (files) =>
  new Map([...files].map(([path, content]) => [path, Buffer.from(content).toString('utf8')]));

// The profile entry a maintainer would commit for this release: the newest
// supported profile's dialect, never a baseline. Per-version import
// normalizations are keyed by profile id, so this entry gets none of them.
const candidateProfile = ({ version, sha, newest }) => ({
  id: `v${version}`,
  releaseId: `aidlc:${sha}`,
  label: `AI-DLC ${version}`,
  upstreamVersion: version,
  upstreamRef: sha,
  upstreamChannel: 'stable',
  compatibilityStatus: 'candidate',
  frontmatterDialect: newest.frontmatterDialect,
  trustTier: 'T1',
  currentPlatformBaseline: false,
});

const invokeLines = (files) =>
  new Set(
    [...files.values()].flatMap((content) =>
      content
        .split('\n')
        .filter((line) => line.includes(INVOKE))
        .map((line) => line.trim()),
    ),
  );

// `engine graph ars --iae <s>` → `engine graph ars`: the command words before
// the first option or placeholder.
const commandFamily = (line) => {
  const words = line.slice(line.indexOf(INVOKE) + '{{INVOKE}} '.length).split(/\s+/);
  const family = [];
  for (const word of words) {
    if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
    family.push(word);
  }
  return family.join(' ');
};

const setDiff = (next, previous) => ({
  added: [...next].filter((item) => !previous.has(item)).toSorted(),
  removed: [...previous].filter((item) => !next.has(item)).toSorted(),
});

const fileDiff = (next, previous) => {
  const changes = [];
  for (const [path, hash] of Object.entries(next)) {
    if (!Object.hasOwn(previous, path)) changes.push({ path, change: 'added' });
    else if (previous[path] !== hash) changes.push({ path, change: 'changed' });
  }
  for (const path of Object.keys(previous)) {
    if (!Object.hasOwn(next, path)) changes.push({ path, change: 'removed' });
  }
  const areaOf = (path) => AREAS.find(([, matches]) => matches(path))[0];
  return AREAS.map(([area]) => [area, changes.filter(({ path }) => areaOf(path) === area)]).filter(
    ([, items]) => items.length > 0,
  );
};

const gapKey = ({ kind, blockType, field, value }) =>
  [kind, blockType, field, value == null ? '' : String(value)].join(' ').trim();

const tryBundle = (input) => {
  try {
    const { manifest, objects } = buildReleaseBundle(input);
    return { ok: true, objectCount: objects.length, closureDigest: manifest.closureDigest };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? error.name,
      message: String(error.message).slice(0, 300),
    };
  }
};

// `baselineFiles` is the newest supported version's real core/ tree, already
// checked against its certified source digest by the caller.
const qualifyRelease = ({ result, newest, baselineFiles, distribution = null }) => {
  const files = textFiles(result.files);
  const newestFiles = textFiles(baselineFiles);
  const profile = candidateProfile({ version: result.version, sha: result.sha, newest });
  const analysis = analyzeAidlcCompatibility({ profile, files });
  const bundle = tryBundle({ profile, files });
  // Whether the release imports once its id joins the per-version
  // normalizations the newest version gets, as a hint for the maintainer.
  const inherited = analysis.importable
    ? null
    : analyzeAidlcCompatibility({ profile: { ...profile, baseProfileId: newest.id }, files });
  const newestAnalysis = analyzeAidlcCompatibility({ profileId: newest.id, files: newestFiles });
  const newestInvoke = invokeLines(newestFiles);
  const nextInvoke = invokeLines(files);
  const families = (lines) => new Set([...lines].map(commandFamily).filter(Boolean));
  const knownGaps = new Set((newestAnalysis.certificationGaps ?? []).map(gapKey));
  const newGaps = (analysis.certificationGaps ?? [])
    .map(gapKey)
    .filter((item) => !knownGaps.has(item));

  // Gaps the newest supported version already has were accepted when it was
  // onboarded; only new ones, a diagnostic or a refused bundle hold this back.
  const ready = analysis.importable && bundle.ok && newGaps.length === 0;
  return {
    verdict: ready ? 'ready' : 'needs-work',
    newestVersion: newest.upstreamVersion,
    profile: { ...profile, sourceDigest: sourceDigestOf(files) },
    analysis: {
      importable: analysis.importable,
      structurallyValid: analysis.structurallyValid,
      dependencyClosureComplete: analysis.dependencyClosureComplete,
      sensorCommandsCompatible: analysis.sensorCommandsCompatible,
      readyForCertification: analysis.readyForCertification,
      diagnostics: (analysis.diagnostics ?? []).map(({ code, path, message }) => ({
        code,
        path,
        message,
      })),
      certificationGaps: (analysis.certificationGaps ?? []).length,
      newGaps,
      blockCounts: analysis.blockCounts ?? {},
      newestBlockCounts: newestAnalysis.blockCounts ?? {},
      normalizations: (analysis.normalizations ?? []).length,
      importableWithNewestNormalizations: inherited?.importable === true,
    },
    bundle,
    files: fileDiff(sourceFileHashes(files), sourceFileHashes(newestFiles)),
    commands: setDiff(families(nextInvoke), families(newestInvoke)),
    invokeLines: setDiff(nextInvoke, newestInvoke),
    distribution,
  };
};

// The fence is longer than any backtick run in the text, so upstream lines
// cannot close it; control and format characters (bidi, zero-width) are
// dropped and each line is capped.
const codeBlock = (lines) => {
  const clean = lines.map((line) =>
    [...String(line)]
      .filter((char) => char === '\t' || !/[\p{Cc}\p{Cf}]/u.test(char))
      .join('')
      .slice(0, 300),
  );
  const longest = Math.max(
    2,
    ...clean.map((line) => Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length))),
  );
  const fence = '`'.repeat(longest + 1);
  return [`${fence}text`, ...clean, fence];
};

const capped = (items) =>
  items.length > MAX_LIST
    ? [...items.slice(0, MAX_LIST), `… and ${items.length - MAX_LIST} more`]
    : items;

const details = (summary, lines) => [
  '',
  `<details><summary>${summary}</summary>`,
  '',
  ...lines,
  '',
  '</details>',
];

const yesNo = (value) => (value ? 'yes' : '**no**');

const qualificationSections = (qualification) => {
  const {
    analysis,
    bundle,
    files,
    commands,
    invokeLines: lines,
    profile,
    distribution,
  } = qualification;
  const counts = Object.keys({ ...analysis.blockCounts, ...analysis.newestBlockCounts })
    .toSorted()
    .map(
      (type) =>
        `| ${type} | ${analysis.newestBlockCounts[type] ?? 0} | ${analysis.blockCounts[type] ?? 0} |`,
    );
  const qualificationLines = [
    '### Qualification against this build',
    '',
    `Imported in memory as the profile entry below, in the ${profile.frontmatterDialect} dialect of ${qualification.newestVersion}; nothing was published. \`ready\` means no import diagnostic, a release bundle that builds and no certification gap ${qualification.newestVersion} does not already have. It does not review what the release's runtime files do.`,
    '',
    `- Importable: ${yesNo(analysis.importable)}; structurally valid: ${yesNo(analysis.structurallyValid)}; dependency closure complete: ${yesNo(analysis.dependencyClosureComplete)}; sensor commands compatible: ${yesNo(analysis.sensorCommandsCompatible)}`,
    ...(!analysis.importable && analysis.importableWithNewestNormalizations
      ? [
          `- Imports once \`${profile.id}\` joins the per-version import normalizations ${qualification.newestVersion} gets (for example \`REQUIREMENTS_OUTPUTS_PROFILES\` in \`lambda/shared/aidlc-compatibility.js\`).`,
        ]
      : []),
    `- Ready for certification: ${yesNo(analysis.readyForCertification)} (${analysis.certificationGaps} gaps, ${analysis.newGaps.length} not in ${qualification.newestVersion}); release bundle: ${bundle.ok ? `built (${bundle.objectCount} objects)` : `**refused** (\`${safePath(bundle.code)}\`)`}`,
    ...(analysis.diagnostics.length
      ? details(
          `${analysis.diagnostics.length} diagnostics`,
          codeBlock(
            capped(analysis.diagnostics.map(({ code, path }) => `${code} ${path ?? ''}`.trim())),
          ),
        )
      : []),
    ...(analysis.newGaps.length
      ? details(
          `${analysis.newGaps.length} certification gaps not in ${qualification.newestVersion}`,
          codeBlock(capped(analysis.newGaps)),
        )
      : []),
    '',
    `| Blocks | ${qualification.newestVersion ?? 'newest supported'} | this release |`,
    '| --- | --- | --- |',
    ...counts,
  ];
  const changeLines = [
    '### Changes since the newest supported version',
    '',
    ...(files.length === 0 ? ['No core/ file changed.'] : []),
    ...files.flatMap(([area, items]) =>
      details(
        `${area}: ${items.length} files`,
        codeBlock(capped(items.map(({ path, change }) => `${change.padEnd(8)}${safePath(path)}`))),
      ),
    ),
    '',
    `Engine command families added: ${commands.added.length ? commands.added.map((item) => `\`${item}\``).join(', ') : 'none'}; removed: ${commands.removed.length ? commands.removed.map((item) => `\`${item}\``).join(', ') : 'none'}.`,
    ...(lines.added.length || lines.removed.length
      ? details(
          `${lines.added.length} engine command lines added, ${lines.removed.length} removed`,
          codeBlock(
            capped([
              ...lines.added.map((line) => `+ ${line}`),
              ...lines.removed.map((line) => `- ${line}`),
            ]),
          ),
        )
      : []),
  ];
  const runtimeAsset = distribution?.assets.find(
    (name) => name === `aidlc-runtime-${profile.upstreamVersion}.tar.gz`,
  );
  const exportLines = distribution
    ? [
        '### Native export',
        '',
        runtimeAsset
          ? `The commit has no \`dist/<harness>/\` for the harnesses marked below; the native export reads them from the \`${runtimeAsset}\` release asset once the profile names \`runtimeReleaseTag\` (and refuses an asset built from another commit):`
          : 'The native export of an official release reads `dist/<harness>/` from its commit, or the `aidlc-runtime-<version>.tar.gz` asset of the release its profile names:',
        '',
        ...NATIVE_DISTRIBUTION_HARNESSES.map((harness) => {
          if (distribution.harnesses.includes(harness))
            return `- ${harness}: yes, \`dist/${harness}/\``;
          return runtimeAsset
            ? `- ${harness}: through the runtime asset`
            : `- ${harness}: **no**, neither \`dist/${harness}/\` nor a runtime asset`;
        }),
        '',
        `- Release assets: ${distribution.assets.length ? distribution.assets.map((name) => `\`${safePath(name)}\``).join(', ') : 'none'}`,
      ]
    : [];
  const profileLines = [
    '### Onboarding checklist',
    '',
    'The profile entry an import of this commit would use (`fixtureDigest` comes from the snapshot script):',
    '',
    '```js',
    `  '${profile.id}': Object.freeze({`,
    `    id: '${profile.id}',`,
    `    releaseId: '${profile.releaseId}',`,
    "    fixtureDigest: '<printed by the snapshot script>',",
    `    sourceDigest: '${profile.sourceDigest}',`,
    `    label: '${profile.label}',`,
    `    upstreamVersion: '${profile.upstreamVersion}',`,
    `    upstreamRef: '${profile.upstreamRef}',`,
    "    upstreamChannel: 'stable',",
    "    compatibilityStatus: 'candidate',",
    `    frontmatterDialect: '${profile.frontmatterDialect}',`,
    ...(runtimeAsset ? [`    runtimeReleaseTag: 'v${profile.upstreamVersion}',`] : []),
    "    trustTier: 'T1',",
    '    currentPlatformBaseline: false,',
    '  }),',
    '```',
    '',
    `- [ ] Add the profile, then \`node scripts/snapshot-aidlc-compatibility.mjs ${profile.id}\` and record the fixture digest it prints`,
    '- [ ] Add the release to `aidlc-release-source-info.js`, its catalog golden and its `aidlc-release-invoke-lines.json` entry',
    '- [ ] Extend any per-version import normalization the release still needs, and the version counts in the release tests',
    '- [ ] Review every runtime file change above: that code runs in the agent runtime once an administrator approves the version',
    '- [ ] Document the version in `docs/concepts/aidlc-release-compatibility.md`; registration stays hidden until an administrator approves it',
  ];
  return [qualificationLines, changeLines, exportLines, profileLines].filter(
    (section) => section.length,
  );
};

export { candidateProfile, commandFamily, qualificationSections, qualifyRelease };
