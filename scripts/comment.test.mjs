import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context, render, renderReport, publish, readReport, client } from './comment.mjs';
import { install, post } from './action.mjs';
import { mkdtemp, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'octo/bench', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com' };
const event = { repository: { id: 7, full_name: 'octo/bench' }, number: 8, pull_request: { number: 8, base: { repo: { id: 7, full_name: 'octo/bench' } }, head: { repo: { id: 7 } } } };
const run = () => context(env, event);
const report = () => ({ schema_version: '1', summary: { pass: 1, improved: 0, inconclusive: 0, over_budget: 0, regression: 0, metric_error: 0, error: 0, exit_code: 0 }, suites: [{ name: 'suite', benchmarks: [{ name: 'case', commands: [{ name: 'tool', result: 'pass', comparisons: { latency: { unit: 'ns', statistic: 'median', base: 1000000, head: 1100000, change_percent: 10, verdict: 'pass', reason: 'below tolerance' } } }] }] }] });

test('only same-repository pull requests have a destination', () => {
  assert.equal(run().pullRequest, 8);
  assert.equal(context({ ...env, GITHUB_ACTIONS: 'false' }, event), null);
  assert.equal(context({ ...env, GITHUB_EVENT_NAME: 'push' }, event), null);
  const fork = structuredClone(event);
  fork.pull_request.head.repo.id = 99;
  assert.equal(context(env, fork), null);
  assert.equal(context(env, {}), null);
  assert.equal(context({ ...env, GITHUB_REPOSITORY: 'other/repo' }, event), null);
  assert.equal(context({ ...env, GITHUB_RUN_ID: '1/../../issues' }, event), null);
});

test('passes are quiet and regressions use recorded comparisons', () => {
  const passing = render(report(), run());
  assert.match(passing, /No regressions/);
  assert.ok(!passing.includes('| Benchmark'));
  const rep = report();
  rep.suites[0].benchmarks[0].commands[0].comparisons.latency.verdict = 'regression';
  rep.suites[0].benchmarks[0].commands[0].comparisons.latency.gate = true;
  rep.suites[0].benchmarks[0].commands[0].comparisons.latency.max_percent = 5;
  const body = render(rep, run());
  assert.match(body, /1\.00ms/);
  assert.match(body, /1\.10ms/);
  assert.match(body, /\+10\.0%/);
  assert.match(body, /1 regression detected/);
  assert.ok(!body.includes('PASS'));
  assert.match(body, /run_id=123 run_attempt=2/);
});

test('escapes hostile text, caps output, and omits raw commands and samples', () => {
  const rep = report();
  rep.suites[0].name = '@team <script>|[x](javascript:x)\n# hi';
  const command = rep.suites[0].benchmarks[0].commands[0];
  command.name = rep.suites[0].name;
  command.result = 'error';
  command.command = 'SECRET COMMAND';
  command.samples = ['SECRET SAMPLE'];
  rep.suites[0].benchmarks[0].commands = Array.from({ length: 1000 }, () => command);
  const body = render(rep, run());
  assert.ok(Buffer.byteLength(body) < 60000);
  for (const unsafe of ['@team', '<script>', '[x](javascript:x)', 'SECRET COMMAND', 'SECRET SAMPLE']) assert.ok(!body.includes(unsafe), unsafe);
  assert.match(body, /Showing 10 of 1000 problems/);
});

test('does not fabricate missing, unsupported, or floor-limited measurements', () => {
  const rep = report();
  const command = rep.suites[0].benchmarks[0].commands[0];
  command.comparisons = {};
  command.head = { metrics: { latency: { status: 'unsupported', unit: 'ns', stats: null }, peak_rss: { status: 'measured', unit: 'bytes', floor: 1024, stats: { median: 512 } } } };
  command.budgets = [{ metric: 'peak_rss', aggregation: 'max', status: 'skipped', unit: 'bytes', actual: 512, limit: 256, operator: '<=', reason: 'at measurement floor' }];
  const body = render(rep, run());
  assert.match(body, /unsupported/);
  assert.match(body, /measurement floor/);
  assert.ok(!body.includes('0.00ms'));
});

test('rejects unsupported schema and malformed counts instead of showing a pass', () => {
  for (const bad of [null, {}, { ...report(), schema_version: '99' }, { ...report(), summary: {} }, { ...report(), suites: null }]) assert.throws(() => render(bad, run()));
});

test('missing or stale reports are skipped, malformed or oversized files fail', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-himorime-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.json');
  assert.equal(await readReport(path, 0), null);
  await writeFile(path, JSON.stringify(report()));
  assert.deepEqual(await readReport(path, 0), report());
  await writeFile(path, JSON.stringify(report()).replace('"schema_version":"1"', '"schema_version":"1","seed":18446744073709551615'));
  assert.equal((await readReport(path, 0)).seed, '18446744073709551615');
  await utimes(path, 1, 1);
  assert.equal(await readReport(path, Date.now()), null);
  await writeFile(path, '{');
  await assert.rejects(readReport(path, 0));
  await writeFile(path, ' '.repeat(16 * 1024 * 1024 + 1));
  await assert.rejects(readReport(path, 0), /size/);
});

const owned = (id, runID, attempt) => ({ id, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `<!-- himorime:benchmark-report:v3 run_id=${runID} run_attempt=${attempt} -->` });

test('posts once then removes only older owned comments across pages', async () => {
  const calls = [];
  const send = async (method, path, data) => {
    calls.push([method, path, data]);
    if (method === 'POST') return { id: 3 };
    if (path.endsWith('page=1')) return [...Array.from({ length: 99 }, (_, i) => ({ id: i + 10, user: { login: 'human', type: 'User' }, body: owned(1, 123, 1).body })), owned(1, 123, 1)];
    if (path.endsWith('page=2')) return [owned(3, 123, 2)];
    return null;
  };
  assert.equal(await publish(run(), render(report(), run()), send), 3);
  assert.deepEqual(calls.filter(([method]) => method === 'DELETE').map(([, path]) => path), ['/repos/octo/bench/issues/comments/1']);
  assert.equal(calls[0][0], 'POST');
});

test('an older run cannot replace a newer result, and same-run races converge', async () => {
  for (const winner of [owned(9, 124, 1), owned(9, 123, 3), owned(9, 123, 2)]) {
    const deleted = [];
    const send = async (method, path) => {
      if (method === 'POST') return { id: 3 };
      if (method === 'GET') return [owned(3, 123, 2), winner];
      deleted.push(path);
    };
    assert.equal(await publish(run(), render(report(), run()), send), 9);
    assert.deepEqual(deleted, ['/repos/octo/bench/issues/comments/3']);
  }
});

test('API failures are surfaced and never trigger deletion without a complete list', async () => {
  const calls = [];
  await assert.rejects(publish(run(), render(report(), run()), async method => {
    calls.push(method);
    if (method === 'POST') return { id: 3 };
    throw new Error('403: grant pull-requests: write');
  }), /pull-requests/);
  assert.deepEqual(calls, ['POST', 'GET']);
});

test('post uses the context captured before benchmark commands ran', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-himorime-post-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = { ...env, RUNNER_TEMP: dir, GITHUB_STATE: join(dir, 'state'), GITHUB_EVENT_PATH: join(dir, 'event'), 'INPUT_GITHUB-TOKEN': 'secret', 'INPUT_INSTALL-DIR': join(dir, 'bin with spaces'), 'INPUT_VERIFY-CHECKSUM': 'true' };
  await writeFile(settings.GITHUB_EVENT_PATH, JSON.stringify(event));
  await install(settings, (exe, args, options) => {
    assert.equal(exe, 'bash');
    assert.equal(args.length, 1);
    assert.equal(options.env.INPUT_GITHUB_TOKEN, 'secret');
    assert.equal(options.env.GH_TOKEN, 'secret');
    assert.equal(options.env.INPUT_INSTALL_DIR, settings['INPUT_INSTALL-DIR']);
    assert.equal(options.env.INPUT_VERIFY_CHECKSUM, 'true');
    return { status: 0 };
  });
  const state = (await readFile(settings.GITHUB_STATE, 'utf8')).trim().slice('publication='.length);
  const calls = [];
  let log = '';
  const output = { write: text => { log += text; } };
  const transport = (url, token) => {
    assert.equal(url, env.GITHUB_API_URL);
    assert.equal(token, 'secret');
    return async (method, path, data) => {
      calls.push({ method, path, data });
      if (method === 'POST') return { id: 1 };
      return [];
    };
  };
  await post({ ...settings, STATE_publication: state }, transport, output);
  assert.equal(calls.length, 0, 'no report means no API request');
  await writeFile(join(dir, 'himorime.json'), JSON.stringify(report()));
  const fresh = new Date(JSON.parse(state).started + 1000);
  await utimes(join(dir, 'himorime.json'), fresh, fresh);
  await post({ ...settings, GITHUB_REPOSITORY: 'hostile/repo', STATE_publication: state }, transport, output);
  assert.match(log, /stop-commands/);
  assert.match(log, /below tolerance/);
  assert.match(log, /\| pass \|/);
  assert.equal(calls[0].path, '/repos/octo/bench/issues/8/comments');
  assert.match(calls[0].data.body, /No regressions/);
  const fork = structuredClone(event);
  fork.pull_request.head.repo.id = 99;
  await writeFile(settings.GITHUB_EVENT_PATH, JSON.stringify(fork));
  await rm(settings.GITHUB_STATE);
  await install(settings, () => ({ status: 0 }));
  await assert.rejects(readFile(settings.GITHUB_STATE), { code: 'ENOENT' });
  await post(settings, () => { throw new Error('fork must not create an API client'); });
  await assert.rejects(install(settings, () => ({ status: 1 })), /installation failed/);
});

test('old marker migration leaves human and unrelated bot comments untouched', async () => {
  const old = owned(1, 122, 1);
  old.body = '<!-- himorime:benchmark-report:v2 run_id=122 workflow_id=8 run_number=1 run_attempt=1 -->';
  const deleted = [];
  await publish(run(), render(report(), run()), async (method, path) => {
    if (method === 'POST') return { id: 10 };
    if (method === 'GET') return [old, { ...old, id: 2, user: { login: 'human', type: 'User' } }, { ...old, id: 3, body: 'unrelated' }];
    deleted.push(path);
  });
  assert.deepEqual(deleted, ['/repos/octo/bench/issues/comments/1']);
});

test('mixed problems stay ordered, improvements stay hidden, floor bounds stay bounds', () => {
  const rep = report(), c = rep.suites[0].benchmarks[0].commands[0];
  c.comparisons.latency.verdict = 'improved';
  assert.ok(!render(rep, run()).includes('| Benchmark'));
  c.comparisons.peak_rss = { verdict: 'regression', gate: false, base: 512, head: 4096, unit: 'bytes', max_percent: 10, change_percent: 700 };
  c.head = { metrics: { peak_rss: { status: 'measured', floor: 1024 } } };
  c.base = { metrics: { peak_rss: { status: 'measured', floor: 1024 } } };
  c.budgets = [{ metric: 'latency', aggregation: 'p95', status: 'fail', unit: 'ns', actual: 2000000, operator: '<=', limit: 1000000 }];
  c.comparisons.cpu_total = { verdict: 'inconclusive', reason: 'too few samples' };
  rep.suites[0].error = { kind: 'build', message: 'compilation failed' };
  const body = render(rep, run());
  assert.match(body, /❌ 1 execution or measurement error/);
  assert.ok(body.indexOf('### Errors') < body.indexOf('### Regressions'));
  assert.ok(body.indexOf('### Regressions') < body.indexOf('### Budget violations'));
  assert.ok(body.indexOf('### Budget violations') < body.indexOf('### Inconclusive measurements'));
  assert.match(body, /≤ 1\.00KiB → 4\.00KiB/);
  assert.match(body, /not gated/);
  assert.match(body, /too few samples/);
});

test('client rejects redirects and names missing permissions without exposing the response', async () => {
  const send = client(env.GITHUB_API_URL, 'secret', async (url, options) => {
    assert.equal(url, env.GITHUB_API_URL + '/repos/octo/bench/issues/8/comments');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer secret');
    return new Response('secret or untrusted error text', { status: 403 });
  });
  await assert.rejects(send('POST', '/repos/octo/bench/issues/8/comments', {}), error => /pull-requests: write/.test(error.message) && !/secret/.test(error.message));
  assert.throws(() => client('http://example.com', 'secret'), /HTTPS/);
  assert.throws(() => client('https://user:pass@example.com', 'secret'), /HTTPS/);
  const deleted = client(env.GITHUB_API_URL, 'secret', async () => new Response('', { status: 404 }));
  assert.equal(await deleted('DELETE', '/repos/octo/bench/issues/comments/1'), null);
});

test('post logs all results as tables without changing the report', () => {
  const rep = report();
  rep.himorime_version = 'v0.2.0';
  rep.seed = '18446744073709551615';
  rep.environment = { os: 'linux', arch: 'amd64', cpu_model: 'Example CPU' };
  rep.git = { base_sha: 'base', head_sha: 'head' };
  const c = rep.suites[0].benchmarks[0].commands[0];
  c.comparisons.latency.ci_low_percent = -1;
  c.comparisons.latency.ci_high_percent = 2;
  c.comparisons.latency.required_confidence = 0.95;
  c.head = { metrics: { latency: { status: 'measured', unit: 'ns', source: 'monotonic clock', stats: { median: 1100000, count: 20, percentiles: { p95: 1200000 } } } } };
  const before = JSON.stringify(rep);
  const body = renderReport(rep, run());
  for (const line of body.trim().split('\n')) assert.ok(line === '' || line.startsWith('|'), line);
  for (const text of ['pass', '1.00ms', '1.10ms', 'below tolerance', 'v0.2.0', '18446744073709551615', 'linux', 'amd64', 'Example CPU', 'base', 'head', '0.95', 'p95', 'monotonic clock', run().runURL]) assert.ok(body.includes(text), text);
  assert.equal(JSON.stringify(rep), before);
});
