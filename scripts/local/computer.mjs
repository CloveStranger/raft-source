import path from 'node:path';
import { run } from './common.mjs';
const call = (ctx, args, options={}) => run(ctx.config.computer.executable, args, { ...options, env: {
  RAFT_HOME: ctx.config.computer.home, SLOCK_HOME: ctx.config.computer.home,
  RAFT_SERVER_URL: `http://localhost:${ctx.config.port}`, SLOCK_SERVER_URL: `http://localhost:${ctx.config.port}`,
} });
export const computerStatus = (ctx,options) => call(ctx, ['status', '--json'],options).then(JSON.parse);
export async function stopComputer(ctx, { strict = false } = {}) {
  if (!ctx.config.computer.enabled) return { running: false, servers: [] };
  if (!path.isAbsolute(ctx.config.computer.executable || '')) throw new Error('Configure an absolute raft-computer executable');
  const before = await computerStatus(ctx);
  const managed = before.attestation?.managedServerIds;
  if (before.service.running && (!Array.isArray(managed) || !managed.length)) throw new Error('Cannot determine active Computer managed server set');
  if (strict && before.service.running) {
    const running = before.servers.filter(s => s.daemon.running).map(s => s.serverId).sort();
    if (JSON.stringify(running) !== JSON.stringify([...managed].sort())) throw new Error('Computer managed 集合与运行 daemon 不一致；请先检查 Computer 状态');
  }
  const servers = (managed || []).map(id => {
    const row = before.servers.find(s => s.serverId === id);
    if (!row?.serverSlug) throw new Error('Cannot resolve a managed server slug');
    return { id, slug: row.serverSlug };
  });
  if (before.service.running) await call(ctx, ['stop']);
  const after = JSON.parse(await call(ctx, ['status', '--json']));
  if (after.service.running || after.servers.some(s => s.daemon.running)) throw new Error('Computer did not stop completely');
  return { running: before.service.running, servers };
}
export async function resumeComputer(ctx, state, { strict = false } = {}) {
  if (state.running) for (const server of state.servers) await call(ctx, ['start', server.slug]);
  if (strict && state.running) {
    const after = await computerStatus(ctx);
    const expected = state.servers.map(s => s.id).sort();
    const managed = after.attestation?.managedServerIds || [];
    const running = after.servers.filter(s => s.daemon.running).map(s => s.serverId).sort();
    if (!after.service.running || JSON.stringify([...managed].sort()) !== JSON.stringify(expected) || JSON.stringify(running) !== JSON.stringify(expected)) throw new Error('Computer 恢复集合与原运行集合不一致');
  }
}
