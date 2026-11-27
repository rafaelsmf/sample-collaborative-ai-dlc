// Opens or refreshes one issue per checked release, from the report the check
// job wrote. Runs in actions/github-script with an issues-only token; it
// fetches nothing from upstream, rebuilds the title and marker from the
// validated tag and commit, and never touches code.
import { readFile } from 'node:fs/promises';

const BOT_LOGIN = 'github-actions[bot]';
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const LABELS = ['area/ci', 'topic/workflows', 'status/needs-triage'];
// GitHub refuses an issue body over 65,536 characters.
const MAX_BODY = 65_000;
const VERDICTS = new Set([
  'integrity-failed',
  'ready',
  'needs-work',
  'already-supported',
  'verified',
]);

// The marker is rebuilt from the validated tag and commit, never read from
// report text, so upstream content cannot point the report at another issue.
const markerFor = ({ tag, sha }) =>
  `<!-- aidlc-release-watch:${tag}@${SHA_RE.test(sha ?? '') ? sha : 'none'} -->`;

const validReport = (report) =>
  TAG_RE.test(report?.tag ?? '') &&
  (report.sha === null || SHA_RE.test(report.sha ?? '')) &&
  VERDICTS.has(report.verdict) &&
  typeof report.body === 'string' &&
  report.body.length <= MAX_BODY &&
  report.body.startsWith(`${markerFor(report)}\n`);

const titleFor = ({ tag }) => `AI-DLC ${tag.slice(1)}: release qualification report`;
const verdictLine = (verdict) => `**Verdict: \`${verdict}\`.**`;

const labelsFor = (verdict) =>
  verdict === 'integrity-failed' ? [...LABELS, 'nfr/security'] : LABELS;

const findIssue = async ({ github, repo, marker }) => {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    creator: BOT_LOGIN,
    state: 'all',
    per_page: 100,
  });
  return issues.find((issue) => !issue.pull_request && issue.body?.startsWith(`${marker}\n`));
};

// The Task issue type exists only where the organization defines it; an
// issue without a type is still the report.
const createIssue = async ({ github, repo, report }) => {
  const request = {
    ...repo,
    title: titleFor(report),
    body: report.body,
    labels: labelsFor(report.verdict),
  };
  try {
    return await github.rest.issues.create({ ...request, type: 'Task' });
  } catch (error) {
    if (error?.status !== 422) throw error;
    return github.rest.issues.create(request);
  }
};

const publishReleaseReports = async ({ github, context, reportFile, info = () => {} }) => {
  const { reports } = JSON.parse(await readFile(reportFile, 'utf8'));
  if (!Array.isArray(reports)) throw new Error('release watch report has no reports list');
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const outcomes = [];
  for (const report of reports) {
    if (!validReport(report)) throw new Error('release watch report entry is not valid');
    // A supported commit needs nothing from a maintainer.
    if (report.verdict === 'already-supported') {
      outcomes.push({ tag: report.tag, action: 'none' });
      continue;
    }
    const existing = await findIssue({ github, repo, marker: markerFor(report) });
    if (!existing) {
      const { data } = await createIssue({ github, repo, report });
      outcomes.push({ tag: report.tag, action: 'opened', number: data.number });
    } else if (existing.body === report.body) {
      outcomes.push({ tag: report.tag, action: 'kept', number: existing.number });
    } else if (
      existing.state === 'closed' &&
      !(
        report.verdict === 'integrity-failed' &&
        !existing.body.includes(verdictLine('integrity-failed'))
      )
    ) {
      // A maintainer handled this report; only a newly failed integrity check
      // for the same commit reopens it.
      outcomes.push({ tag: report.tag, action: 'kept', number: existing.number });
    } else {
      await github.rest.issues.update({
        ...repo,
        issue_number: existing.number,
        title: titleFor(report),
        body: report.body,
        ...(existing.state === 'closed' ? { state: 'open' } : {}),
      });
      outcomes.push({
        tag: report.tag,
        action: existing.state === 'closed' ? 'reopened' : 'updated',
        number: existing.number,
      });
    }
    const last = outcomes.at(-1);
    info(`AI-DLC ${report.tag}: ${report.verdict}, issue ${last.number ?? '-'} ${last.action}`);
  }
  return outcomes;
};

export { LABELS, markerFor, publishReleaseReports };
