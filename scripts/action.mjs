import { appendFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { client, context, publish, readReport, render, renderReport } from './comment.mjs';

export async function install(env = process.env, execute = spawnSync) {
  const started = Date.now();
  let run = null;
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'pull_request') run = context(env, JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
  const childEnv = { ...env };
  for (const key of ['version', 'github-token', 'install-dir', 'verify-checksum', 'verify-attestation', 'add-to-path']) {
    childEnv[`INPUT_${key.toUpperCase().replaceAll('-', '_')}`] = env[`INPUT_${key.toUpperCase()}`] ?? '';
  }
  childEnv.GH_TOKEN = childEnv.INPUT_GITHUB_TOKEN;
  const script = fileURLToPath(new URL('./install.sh', import.meta.url)).replaceAll('\\', '/');
  const result = execute('bash', [script], { env: childEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`himorime installation failed (${result.signal ?? result.status})`);
  if (run && env.GITHUB_STATE && env.RUNNER_TEMP) {
    await appendFile(env.GITHUB_STATE, `publication=${JSON.stringify({ run, started, path: join(env.RUNNER_TEMP, 'himorime.json') })}\n`);
  }
}

export async function post(env = process.env, makeClient = client, output = process.stdout) {
  if (!env.STATE_publication) return;
  const state = JSON.parse(env.STATE_publication);
  if (!Number.isSafeInteger(state.started) || state.started <= 0) throw new Error('invalid setup-himorime installation state');
  const report = await readReport(state.path, state.started);
  if (report === null) return;
  const body = render(report, state.run);
  const token = randomUUID();
  output.write(`::stop-commands::${token}\n`);
  try { output.write(renderReport(report, state.run)); }
  finally { output.write(`\n::${token}::\n`); }
  const send = makeClient(state.run.apiURL, env['INPUT_GITHUB-TOKEN']);
  await publish(state.run, body, send);
}

export async function run(operation) {
  try {
    await operation();
  } catch (error) {
    const token = process.env['INPUT_GITHUB-TOKEN'];
    let message = String(error.message);
    if (token) message = message.replaceAll(token, '***');
    // Report contents and API errors must not become workflow commands.
    message = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    process.stderr.write(`::error::setup-himorime: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run(install);
