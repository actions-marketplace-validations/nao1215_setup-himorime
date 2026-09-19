import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const positive = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const outcomes = new Set(['pass', 'improved', 'inconclusive', 'regression', 'over_budget', 'metric_error', 'error']);

function httpsURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('GitHub URLs must use HTTPS without credentials, queries or fragments');
  return url.toString().replace(/\/$/, '');
}

// Destinations come only from the runner context, never from the report.
export function context(env, event) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'pull_request') return null;
  const repository = env.GITHUB_REPOSITORY;
  const pr = event?.pull_request;
  const id = event?.repository?.id;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || repository.split('/').some(p => p === '.' || p === '..') || !positive(id) ||
      event.repository.full_name !== repository || pr?.base?.repo?.id !== id ||
      pr?.head?.repo?.id !== id || !positive(pr?.number) || event.number !== pr.number ||
      !positive(env.GITHUB_RUN_ID) || !positive(env.GITHUB_RUN_ATTEMPT)) return null;
  return { repository, pullRequest: pr.number, runID: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT),
    runURL: `${httpsURL(env.GITHUB_SERVER_URL)}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
    apiURL: httpsURL(env.GITHUB_API_URL) };
}

export async function readReport(path, started) {
  let file;
  try {
    if (!(await lstat(path)).isFile()) throw new Error('benchmark report must be a regular file');
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('benchmark report must be a regular file');
    if (stat.mtimeMs < started) return null;
    const limit = 16 * 1024 * 1024;
    if (stat.size > limit) throw new Error('benchmark report exceeds the 16 MiB size limit');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('benchmark report exceeds the 16 MiB size limit');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    await file?.close();
  }
}

function cell(value, limit = 120) {
  let text = String(value ?? '').replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
  if ([...text].length > limit) text = [...text].slice(0, limit).join('') + '…';
  return (text || '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;').replaceAll('|', '&#124;').replace(/[\\`*_{}\[\]()#!~]/g, '\\$&');
}

const names = { latency: 'Latency', cpu_total: 'CPU time', cpu_user: 'CPU user time', cpu_system: 'CPU system time', cpu_utilization: 'CPU utilization', peak_rss: 'Peak RSS', throughput: 'Throughput' };
const metricName = name => names[name] ?? cell(name);
const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function value(unit, number) {
  if (number === null || number === undefined) return '—';
  if (!finite(number)) throw new Error('invalid numeric measurement');
  const scales = unit === 'ns' ? [[1e9, 's'], [1e6, 'ms'], [1e3, 'µs'], [1, 'ns']] : unit === 'bytes' ? [[2 ** 30, 'GiB'], [2 ** 20, 'MiB'], [1024, 'KiB'], [1, 'B']] : [[1, unit]];
  const [scale, suffix] = scales.find(([scale]) => Math.abs(number) >= scale) ?? scales.at(-1);
  return `${(number / scale).toFixed(2)}${cell(suffix)}`;
}

function measured(side, metric, unit, number) {
  const m = side?.metrics?.[metric];
  if (m && m.status !== 'measured') return cell(m.status);
  if (m?.floor > 0 && finite(number) && number <= m.floor) return `≤ ${value(unit, m.floor)}`;
  return value(unit, number);
}

function problems(rep) {
  const out = [];
  const add = (kind, label, metric, reason, extra = {}) => out.push({ kind, label: cell(label), metric, reason: cell(reason, 240), gated: true, ...extra });
  const error = (label, side, e) => {
    if (!object(e) || typeof e.kind !== 'string' || typeof e.message !== 'string') throw new Error('invalid execution error in report');
    add(0, label, `${metricName(e.metric || 'Execution')} (${side})`, `${e.kind}: ${e.message}${e.exit_code == null ? '' : ` (exit ${e.exit_code})`}`);
  };
  for (const s of rep.suites) {
    if (!object(s) || typeof s.name !== 'string' || !Array.isArray(s.benchmarks)) throw new Error('invalid suite in report');
    if (s.error) error(s.name, 'Suite', s.error);
    for (const b of s.benchmarks) {
      if (!object(b) || typeof b.name !== 'string' || !Array.isArray(b.commands)) throw new Error('invalid benchmark in report');
      const label = `${rep.suites.length > 1 ? s.name + ' / ' : ''}${b.name}`;
      if (b.error) error(label, 'Benchmark', b.error);
      for (const c of b.commands) {
        if (!object(c) || typeof c.name !== 'string' || !outcomes.has(c.result)) throw new Error('invalid command result in report');
        const start = out.length, name = `${label} / ${c.name}`;
        const unavailable = new Set();
        for (const side of ['base', 'head']) {
          const m = c[side];
          if (!m) continue;
          if (m.error) error(name, side, m.error);
          for (const [metric, ms] of Object.entries(m.metrics ?? {})) {
            if (!object(ms) || !['measured', 'not_requested', 'unsupported', 'failed'].includes(ms.status)) throw new Error('invalid metric status in report');
            if (m.error || ['failed', 'unsupported'].includes(ms.status)) unavailable.add(metric);
            if (!m.error && ['failed', 'unsupported'].includes(ms.status)) add(ms.status === 'failed' ? 0 : 4, name, `${metricName(metric)} (${side})`, `${ms.status}: ${ms.reason ?? ''}`);
          }
        }
        if (c.comparisons != null && !object(c.comparisons)) throw new Error('invalid comparisons in report');
        for (const [metric, mc] of Object.entries(c.comparisons ?? {})) {
          if (!object(mc) || !['pass', 'improved', 'regression', 'inconclusive', 'skipped'].includes(mc.verdict)) throw new Error('invalid comparison verdict in report');
          if (mc.derived_from || unavailable.has(metric) || ['pass', 'improved'].includes(mc.verdict)) continue;
          const gated = mc.gate !== false;
          const kind = mc.verdict === 'regression' ? 1 : mc.verdict === 'inconclusive' ? 3 : 4;
          const limits = [];
          if (finite(mc.max_percent)) limits.push(`${mc.better === 'higher' ? '-' : '+'}${mc.max_percent.toFixed(1)}%`);
          if (mc.min_difference > 0) limits.push(value(mc.unit, mc.min_difference));
          add(kind, name, metricName(metric) + (gated ? '' : ' (not gated)'), mc.reason === 'the peak RSS is at or below the measurement floor' ? 'At or below the measurement floor' : mc.reason, {
            gated, values: `${measured(c.base, metric, mc.unit, mc.base)} → ${measured(c.head, metric, mc.unit, mc.head)}`,
            change: finite(mc.change_percent) ? `${mc.change_percent >= 0 ? '+' : ''}${mc.change_percent.toFixed(1)}%` : '—', limit: limits.join(' and ') || '—' });
        }
        if (c.budgets != null && !Array.isArray(c.budgets)) throw new Error('invalid budgets in report');
        for (const bc of c.budgets ?? []) {
          if (!object(bc) || !['pass', 'fail', 'skipped', 'no_data'].includes(bc.status)) throw new Error('invalid budget status in report');
          if (bc.status === 'pass') continue;
          add(bc.status === 'no_data' ? 0 : bc.status === 'skipped' ? 4 : 2, name, `${metricName(bc.metric)} ${cell(bc.aggregation)}`, `Budget ${bc.status}: ${bc.reason ?? ''}`, {
            values: measured(c.head, bc.metric, bc.unit, bc.actual), limit: `${cell(bc.operator)} ${value(bc.unit, bc.limit)}` });
        }
        if (out.length === start && !['pass', 'improved'].includes(c.result)) add(({ regression: 1, over_budget: 2, inconclusive: 3 })[c.result] ?? 0, name, '—', c.result);
      }
    }
  }
  return out.sort((a, b) => a.kind - b.kind);
}

export function render(rep, run) {
  if (!object(rep) || rep.schema_version !== '1' || !object(rep.summary) || !Array.isArray(rep.suites) ||
      ![...outcomes, 'exit_code'].every(key => Number.isSafeInteger(rep.summary[key]) && rep.summary[key] >= 0) || rep.summary.exit_code > 6) throw new Error('invalid benchmark report schema or summary');
  const rows = problems(rep), counts = [0, 0, 0, 0, 0];
  let advisory = 0;
  for (const p of rows) if (p.kind === 1 && !p.gated) advisory++; else counts[p.kind]++;
  let title = '✅ No regressions';
  if (counts[0]) title = `❌ ${count(counts[0], 'execution or measurement error')}`;
  else if (counts[1]) title = `❌ ${count(counts[1], 'regression')} detected${counts[2] ? `, ${count(counts[2], 'budget violation')}` : ''}`;
  else if (counts[2]) title = `❌ ${count(counts[2], 'budget violation')}`;
  else if (rep.summary.exit_code !== 0) title = '❌ Performance checks failed';
  else if (counts[3]) title = `⚠️ ${count(counts[3], 'inconclusive metric comparison')}`;
  else if (advisory) title = `⚠️ ${count(advisory, 'non-gating regression')}`;
  else if (counts[4]) title = `⚠️ ${count(counts[4], 'skipped check')}`;
  else if (!rep.suites.some(s => s.benchmarks.some(b => b.commands.length))) title = '⚠️ No measurements';
  else if (rep.mode === 'run') title = '✅ Measurements completed';
  const parts = [`<!-- himorime:benchmark-report:v3 run_id=${run.runID} run_attempt=${run.attempt} -->`, `## himorime: ${title}`, ''];
  if (rep.summary.fail_on_inconclusive && rep.summary.inconclusive) parts.push('Inconclusive comparisons fail this check because fail-on-inconclusive is enabled.', '');
  const shown = rows.slice(0, 10);
  for (let kind = 0; kind < 5; kind++) {
    const group = shown.filter(p => p.kind === kind);
    if (!group.length) continue;
    if (group.length !== shown.length) parts.push(`### ${['Errors', 'Regressions', 'Budget violations', 'Inconclusive measurements', 'Skipped checks'][kind]}`, '');
    const headers = kind === 1 ? ['Benchmark', 'Metric', 'Base → Head', 'Change', 'Limit'] : kind === 2 ? ['Benchmark', 'Metric', 'Measured', 'Limit'] : ['Benchmark', 'Metric', 'Reason'];
    parts.push(`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`);
    for (const p of group) parts.push(`| ${[p.label, p.metric, ...(kind === 1 ? [p.values ?? '—', p.change ?? '—', p.limit ?? '—'] : kind === 2 ? [p.values ?? '—', p.limit ?? '—'] : [p.reason])].join(' | ')} |`);
    parts.push('');
  }
  if (rows.length > shown.length) parts.push(`Showing ${shown.length} of ${rows.length} problems; remaining items are in the full report.`, '');
  parts.push(`[View full benchmark report and logs](<${run.runURL}>)`, '', '<sub>Generated by [himorime](https://github.com/nao1215/himorime)</sub>', '');
  const body = parts.join('\n');
  if (Buffer.byteLength(body) > 60000) throw new Error('benchmark notification exceeds the comment size limit');
  return body;
}

// Recognize previous reporters during migration, but never touch human comments.
function owned(comment) {
  if (!positive(comment?.id) || comment.user?.login !== 'github-actions[bot]' || comment.user.type !== 'Bot') return null;
  const m = /^<!-- himorime:benchmark-report:v3 run_id=([1-9][0-9]*) run_attempt=([1-9][0-9]*) -->/.exec(comment.body) ??
    /^<!-- himorime:benchmark-report:v2 run_id=([1-9][0-9]*) workflow_id=[1-9][0-9]* run_number=[1-9][0-9]* run_attempt=([1-9][0-9]*) -->/.exec(comment.body);
  if (m && positive(m[1]) && positive(m[2])) return { ...comment, runID: Number(m[1]), attempt: Number(m[2]) };
  if (/^<!-- himorime:benchmark-report:v1 workflow_id=[1-9][0-9]* run_number=[1-9][0-9]* run_attempt=[1-9][0-9]* -->/.test(comment.body)) return { ...comment, runID: 0, attempt: 0 };
  return null;
}

export async function publish(run, body, send) {
  const path = `/repos/${run.repository}/issues/${run.pullRequest}/comments`;
  const created = await send('POST', path, { body });
  if (!positive(created?.id)) throw new Error('GitHub returned a comment without an id');
  const all = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('GitHub comment list exceeded 100 pages');
    const batch = await send('GET', `${path}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid comment list');
    all.push(...batch.map(owned).filter(Boolean));
    if (batch.length < 100) break;
  }
  if (!all.some(c => c.id === created.id)) all.push({ id: created.id, runID: run.runID, attempt: run.attempt });
  all.sort((a, b) => b.runID - a.runID || b.attempt - a.attempt || b.id - a.id);
  for (const old of all.slice(1)) await send('DELETE', `/repos/${run.repository}/issues/comments/${old.id}`);
  return all[0].id;
}

export function client(apiURL, token, request = fetch) {
  if (!token) throw new Error('github-token is required to post a comment');
  const base = httpsURL(apiURL);
  return async (method, path, payload) => {
    const response = await request(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (method === 'DELETE' && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}${response.status === 403 ? '; grant pull-requests: write to the benchmark job' : ''}`);
    if (method === 'DELETE') return null;
    // Pagination limits each response to at most 100 comments.
    const text = await response.text();
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('GitHub response exceeds the size limit');
    return JSON.parse(text);
  };
}
