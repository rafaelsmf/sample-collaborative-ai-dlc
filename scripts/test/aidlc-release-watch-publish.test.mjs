import assert from 'node:assert/strict';
import { mkdtemp, readFileSync, writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import yaml from 'js-yaml';

import { markerFor, publishReleaseReports } from '../aidlc-release-watch/publish.mjs';
import { renderReport } from '../aidlc-release-watch/report.mjs';

const SHA = 'a'.repeat(40);
const report = (over = {}) => {
  const base = {
    tag: 'v2.12.0',
    sha: SHA,
    verdict: 'ready',
    title: 'AI-DLC 2.12.0: release qualification report',
  };
  const merged = { ...base, ...over };
  return { body: `${markerFor(merged)}\nreport body`, ...merged };
};

const writeReports = async (reports) => {
  const dir = await promisify(mkdtemp)(path.join(tmpdir(), 'release-watch-'));
  const file = path.join(dir, 'aidlc-release-watch.json');
  await promisify(writeFile)(file, JSON.stringify({ reports }));
  return file;
};

const fakeGithub = ({ issues = [], typeRejected = false } = {}) => {
  const calls = { created: [], updated: [], listed: [] };
  let next = 100;
  return {
    calls,
    paginate: async (method, params) => method(params),
    rest: {
      issues: {
        listForRepo: (params) => {
          calls.listed.push(params);
          return issues;
        },
        create: async (params) => {
          if (typeRejected && params.type) throw Object.assign(new Error('type'), { status: 422 });
          calls.created.push(params);
          return { data: { number: (next += 1) } };
        },
        update: async (params) => {
          calls.updated.push(params);
          return { data: {} };
        },
      },
    },
  };
};

const context = { repo: { owner: 'aws-samples', repo: 'sample-collaborative-ai-dlc' } };
const publish = async (github, reports) =>
  publishReleaseReports({ github, context, reportFile: await writeReports(reports) });

test('opens one labelled Task issue for a new release and finds it by its marker', async () => {
  const github = fakeGithub();
  const outcomes = await publish(github, [report()]);
  assert.deepEqual(outcomes, [{ tag: 'v2.12.0', action: 'opened', number: 101 }]);
  assert.deepEqual(github.calls.listed[0], {
    ...context.repo,
    creator: 'github-actions[bot]',
    state: 'all',
    per_page: 100,
  });
  assert.equal(github.calls.created[0].type, 'Task');
  assert.deepEqual(github.calls.created[0].labels, [
    'area/ci',
    'topic/workflows',
    'status/needs-triage',
  ]);
  assert.equal(github.calls.created[0].title, 'AI-DLC 2.12.0: release qualification report');
});

test('labels a failed integrity check for security, and still opens without an issue type', async () => {
  const github = fakeGithub({ typeRejected: true });
  await publish(github, [report({ verdict: 'integrity-failed' })]);
  assert.equal(github.calls.created[0].type, undefined);
  assert.ok(github.calls.created[0].labels.includes('nfr/security'));
});

test('updates an open report, keeps a current or closed one, and skips a supported commit', async () => {
  const fresh = report();
  const github = fakeGithub({
    issues: [
      { number: 7, state: 'open', body: `${markerFor(fresh)}\nolder body` },
      { number: 8, state: 'closed', body: `${markerFor({ tag: 'v2.13.0', sha: SHA })}\nold` },
      { number: 9, state: 'open', body: `${markerFor(fresh)}\nolder body`, pull_request: {} },
    ],
  });
  const outcomes = await publish(github, [
    fresh,
    report({ tag: 'v2.13.0', title: 'AI-DLC 2.13.0: release qualification report' }),
    report({ tag: 'v2.11.5', verdict: 'already-supported' }),
  ]);
  assert.deepEqual(outcomes, [
    { tag: 'v2.12.0', action: 'updated', number: 7 },
    { tag: 'v2.13.0', action: 'kept', number: 8 },
    { tag: 'v2.11.5', action: 'none' },
  ]);
  assert.deepEqual(github.calls.updated, [
    { ...context.repo, issue_number: 7, title: fresh.title, body: fresh.body },
  ]);
  assert.equal(github.calls.created.length, 0);
});

test('a moved tag is a new commit and gets its own report', async () => {
  const github = fakeGithub({
    issues: [{ number: 7, state: 'open', body: `${markerFor(report())}\nbody` }],
  });
  await publish(github, [report({ sha: 'b'.repeat(40) })]);
  assert.equal(github.calls.created.length, 1);
});

test('reopens a closed report only when integrity newly fails for the same commit', async () => {
  const closed = (body) => [
    { number: 7, state: 'closed', body: `${markerFor(report())}\n${body}` },
  ];
  const failed = report({ verdict: 'integrity-failed' });
  failed.body = `${markerFor(failed)}\n**Verdict: \`integrity-failed\`.** tree changed`;

  const reopened = fakeGithub({ issues: closed('**Verdict: `ready`.**') });
  assert.deepEqual(await publish(reopened, [failed]), [
    { tag: 'v2.12.0', action: 'reopened', number: 7 },
  ]);
  assert.equal(reopened.calls.updated[0].state, 'open');

  const already = fakeGithub({ issues: closed('**Verdict: `integrity-failed`.** before') });
  assert.deepEqual(await publish(already, [failed]), [
    { tag: 'v2.12.0', action: 'kept', number: 7 },
  ]);
});

test('publishes the report the check renders, with its own title', async () => {
  const rendered = renderReport({
    result: {
      tag: 'v2.12.0',
      version: '2.12.0',
      sha: SHA,
      verdict: 'needs-work',
      immutable: false,
      checks: [{ id: 'tag', ok: true, detail: 'names a commit', paths: [] }],
    },
  });
  const github = fakeGithub();
  await publish(github, [
    { tag: 'v2.12.0', sha: SHA, verdict: 'needs-work', ...rendered, title: '@everyone' },
  ]);
  assert.equal(github.calls.created[0].body, rendered.body);
  assert.equal(github.calls.created[0].title, 'AI-DLC 2.12.0: release qualification report');
});

test('refuses a report whose marker or fields were not produced by the check', async () => {
  for (const bad of [
    { ...report(), body: '<!-- aidlc-release-watch:v9.9.9@none -->\nhijack' },
    report({ tag: 'main' }),
    report({ verdict: 'promoted' }),
    report({ sha: 'not-a-sha' }),
    { ...report(), body: `${markerFor(report())}\n${'x'.repeat(65_001)}` },
  ]) {
    const github = fakeGithub();
    await assert.rejects(publish(github, [bad]), /not valid/);
    assert.equal(github.calls.created.length + github.calls.updated.length, 0);
  }
});

const workflow = yaml.load(
  readFileSync(new URL('../../.github/workflows/aidlc-release-watch.yml', import.meta.url), 'utf8'),
);

test('the watch runs weekly or on demand, only in the upstream repository', () => {
  assert.deepEqual(Object.keys(workflow.on).toSorted(), ['schedule', 'workflow_dispatch']);
  assert.equal(workflow.on.schedule.length, 1);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.if, "github.repository == 'aws-samples/sample-collaborative-ai-dlc'");
    assert.ok(job['timeout-minutes'] > 0);
  }
  assert.equal(workflow.jobs.publish.needs, 'check');
});

test('only the job that reads no upstream data can write issues', () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.check.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: 'read', issues: 'write' });
  const publishRuns = workflow.jobs.publish.steps.map((step) => step.run ?? '').join('');
  assert.equal(publishRuns, '', 'publish runs no shell and installs nothing');
});

test('every action is pinned to a commit and no credential is kept or secret read', () => {
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  for (const step of steps.filter((item) => item.uses)) {
    assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  }
  for (const step of steps.filter((item) => item.uses?.startsWith('actions/checkout@'))) {
    assert.equal(step.with['persist-credentials'], false);
  }
  const text = JSON.stringify(workflow);
  assert.doesNotMatch(text, /secrets\./);
  const runs = steps.map((step) => step.run ?? '').join('\n');
  assert.match(runs, /npm ci --ignore-scripts/);
  assert.doesNotMatch(runs, /\$\{\{/, 'inputs reach the shell only through env');
});
