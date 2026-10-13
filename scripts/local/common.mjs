import { spawn } from 'node:child_process';
import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const docker = process.env.RAFT_DOCKER || 'docker';
export const gh = process.env.RAFT_GH || 'gh';
export const sourceRevision = async () => (await json(path.join(ROOT, 'deploy/local/source-version.json'))).revision;
export const json = async p => JSON.parse(await fs.readFile(p, 'utf8'));
export const writeJson = (p, data) => fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
export const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
export async function emptyDirectory(p) {
  p = path.resolve(p);
  // mkdir is exclusive: even an existing empty target requires a different name.
  await fs.mkdir(p, { mode: 0o700 });
  return p;
}
export async function hash(p) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk);
  return h.digest('hex');
}
export async function run(executable, args, { input, inputFile, outputFile, env, inherit = false, timeoutMs } = {}) {
  const child = spawn(executable, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer=timeoutMs ? setTimeout(()=>child.kill('SIGKILL'),timeoutMs) : undefined;
  const stdout = [], stderr = [];
  const complete = new Promise((resolve, reject) => {
    child.on('error', err=>{clearTimeout(timer);reject(err);});
    child.on('close', code => {clearTimeout(timer);code === 0 ? resolve() : reject(Object.assign(new Error(`${path.basename(executable)} failed (${code}); inspect local service logs`), { details: Buffer.concat(stderr).toString('utf8') }));});
  });
  // Never echo command arguments or subprocess stderr: DSNs/credentials may appear there.
  child.stderr.on('data', b => { if (stderr.length < 64) stderr.push(b); });
  if (inherit) child.stdout.pipe(process.stdout);
  else if (!outputFile) child.stdout.on('data', b => stdout.push(b));
  const jobs = [complete];
  if (outputFile) jobs.push(pipeline(child.stdout, createWriteStream(outputFile, { mode: 0o600, flags: 'wx' })));
  if (inputFile) jobs.push(pipeline(createReadStream(inputFile), child.stdin));
  else { child.stdin.on('error', () => {}); child.stdin.end(input); }
  await Promise.all(jobs);
  return Buffer.concat(stdout).toString('utf8');
}
export async function load(state) {
  state = await fs.realpath(state);
  const config = await json(path.join(state, 'config.json'));
  if (config.version !== 1 || !/^raft-[a-f0-9]{12}$/.test(config.project)) throw new Error('Invalid local config');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !Array.isArray(config.extraRoots) || !path.isAbsolute(config.computer?.home || '') || !/^[a-f0-9]{40}$/.test(config.sourceRevision || '')) throw new Error('Invalid deployment paths, port or source revision');
  return { state, config };
}
export function compose(ctx, args, options = {}) {
  return run(docker, ['compose', '--project-name', ctx.config.project, '--env-file', path.join(ctx.state, 'server.env'),
    '-f', path.join(ROOT, 'deploy/local/compose.yaml'), ...args], {
    ...options, env: { ...options.env, RAFT_STATE: ctx.state, RAFT_SOURCE: ROOT, RAFT_REVISION: ctx.config.sourceRevision, RAFT_HTTP_PORT: String(ctx.config.port) },
  });
}
export const sql = (ctx, text, db = 'slock') => compose(ctx,
  ['exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', db, '-At'], { input: text });
export async function waitFor(fn, label, seconds = 120) {
  const end = Date.now() + seconds * 1000;
  do {
    try { return await fn(); } catch { /* startup readiness only, bounded by deadline */ }
    await new Promise(r => setTimeout(r, 1000));
  } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${label}`);
}
