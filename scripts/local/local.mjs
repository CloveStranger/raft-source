#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, emptyDirectory, writeJson, load, compose, sql, waitFor, sourceRevision } from './common.mjs';
import { stopComputer } from './computer.mjs';
import { ensureServiceConfig,startRedis } from './redis.mjs';
import { ensureRisingWave } from './risingwave.mjs';
export const projectName = state => 'raft-' + createHash('sha256').update(path.resolve(state)).digest('hex').slice(0, 12);
export async function init(state, port = 8080) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024..65535');
  state = await emptyDirectory(state);
  for (const name of ['uploads', 'raft']) await fs.mkdir(path.join(state, name), { mode: 0o700 });
  const secret = () => randomBytes(32).toString('base64');
  const env = {
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'), JWT_SECRET: secret(),
    SLOCK_MCP_CREDENTIAL_KEY: secret(), SLOCK_PROVIDER_CREDENTIAL_KEY: secret(),
    AGENT_BOOTSTRAP_TOKEN_PEPPER: secret(), SLOCK_DEVICE_LOGIN_ENABLED: 'true',
    SCOPE_ATTESTATION_SECRET: secret(), REDIS_URL: 'redis://redis:6379',
    APP_URL: `http://localhost:${port}`, SERVER_URL: `http://localhost:${port}`, CORS_ORIGIN: `http://localhost:${port}`,
  };
  await fs.writeFile(path.join(state, 'server.env'), Object.entries(env).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  await writeJson(path.join(state, 'config.json'), { version: 1, project: projectName(state), port, sourceRevision: await sourceRevision(),
    backupRepo: '', computer: { enabled: false, executable: null, home: path.join(state, 'raft') },
    extraRoots: [], coverageReviewed: false });
  return load(state);
}
export async function startDatabase(ctx) {
  await compose(ctx, ['up', '-d', 'db']);
  await waitFor(() => sql(ctx, 'SELECT 1;'), 'PostgreSQL');
  await startRedis(ctx);
}
export async function startApp(ctx, { migrate = true } = {}) {
  await ensureServiceConfig(ctx);
  await startDatabase(ctx);
  if (migrate) await compose(ctx, ['run', '--rm', '--no-deps', 'api', 'pnpm', '--dir', 'packages/server', 'db:migrate']);
  await compose(ctx, ['up', '-d', 'risingwave']);
  await ensureRisingWave(ctx);
  await compose(ctx, ['up', '-d', 'api', 'web']);
  await waitFor(async () => {
    const response = await fetch(`http://localhost:${ctx.config.port}/health`);
    if (!response.ok) throw new Error('API pending');
  }, 'Raft API');
}
export async function main(args) {
  const [command, state, value] = args;
  if (!state) throw new Error('Usage: node scripts/local/local.mjs init|build|up|stop|status STATE [PORT]');
  if (command === 'init') { await init(state, value ? Number(value) : 8080); console.log(`Initialized ${path.resolve(state)}; review config.json before backups.`); return; }
  const ctx = await load(state);
  if (command === 'build') await compose(ctx, ['build'], { inherit: true });
  else if (command === 'up') { await startApp(ctx); console.log(`Raft: http://localhost:${ctx.config.port}`); }
  else if (command === 'stop') { await stopComputer(ctx); await compose(ctx, ['stop']); }
  else if (command === 'status') console.log(await compose(ctx, ['ps']));
  else throw new Error('Unknown command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
