#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, docker, run, load, json, writeJson, inside, compose, sql, emptyDirectory, sourceRevision } from './common.mjs';
import { keygen, pack, unpack, encrypt, decrypt, split, join } from './archive.mjs';
import { publish, download, privateRepo } from './github.mjs';
import { stopComputer, resumeComputer } from './computer.mjs';
import { REDIS_IMAGE,serviceConfig,saveRedis,copyRedisData,waitRedis } from './redis.mjs';
import { projectName, startDatabase, startApp } from './local.mjs';

export async function dataRoots(ctx) {
  const roots = [{ name: 'uploads', path: path.join(ctx.state, 'uploads') },
    { name: 'raft', path: ctx.config.computer.home, computer: true }, ...ctx.config.extraRoots];
  const names = new Set(['deployment']);
  for (const root of roots) {
    if (!/^[a-z][a-z0-9-]*$/.test(root.name) || names.has(root.name) || !path.isAbsolute(root.path)) throw new Error('Invalid or duplicate data root');
    names.add(root.name);
    root.path = await fs.realpath(root.path); // a missing root is a hard error
    if (!(await fs.stat(root.path)).isDirectory()) throw new Error('Data roots must be directories');
  }
  for (const a of roots) for (const b of roots) if (a !== b && inside(a.path, b.path)) throw new Error('Overlapping roots; use one encompassing directory');
  return roots;
}
export async function checkCoverage(ctx) {
  if (!ctx.config.coverageReviewed) throw new Error('Review Computer/runtime/workfile roots and set coverageReviewed=true in config.json');
  const env = await fs.readFile(path.join(ctx.state, 'server.env'), 'utf8');
  if (/^(S3_[A-Z_]+|CDN_BASE_URL|DATABASE_URL|UPLOADS_DIR|UPLOADS_LOCAL|RISINGWAVE_DATABASE_URL)=.+/m.test(env)) throw new Error('This backup profile supports only its managed PostgreSQL and local uploads; remove external storage overrides after importing their data');
  const configured=serviceConfig(env);
  if (!configured.REDIS_URL || !configured.SCOPE_ATTESTATION_SECRET) throw new Error('Run the local start command to configure managed Redis and scope attestation before backup');
  if (!ctx.config.computer.enabled && (await fs.readdir(ctx.config.computer.home)).length) throw new Error('Computer home has data; enable Computer quiescing before backup');
  const columns = (await sql(ctx, "SELECT table_name || '.' || column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('avatar_url','icon_url');")).trim().split('\n').filter(Boolean);
  for (const value of columns) {
    const [table, column] = value.split('.');
    if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) throw new Error('Unexpected avatar schema');
    const rows = (await sql(ctx, `SELECT DISTINCT "${column}" FROM "${table}" WHERE "${column}" IS NOT NULL;`)).trim().split('\n').filter(Boolean);
    for (const url of rows) {
      if (url.startsWith('pixel:')) continue;
      const parsed = new URL(url, `http://localhost:${ctx.config.port}`);
      if (parsed.origin !== `http://localhost:${ctx.config.port}`) throw new Error('External avatar/icon found; import its image into local storage before complete backup');
      const match = /(?:^|\/)(avatars\/.*)$/.exec(decodeURIComponent(parsed.pathname));
      if (match) {
        const p = path.resolve(ctx.state, 'uploads', match[1]);
        if (!inside(path.join(ctx.state, 'uploads'), p)) throw new Error('Invalid avatar key');
        await fs.access(p);
      }
    }
  }
}
export async function backup(state, key, output, { upload = false } = {}) {
  const ctx = await load(state), roots = await dataRoots(ctx);
  key = await fs.realpath(key); output = path.resolve(output);
  if (roots.some(r => inside(r.path, key) || inside(r.path, output)) || inside(ctx.state, key) || inside(ctx.state, output)) throw new Error('Keep backup key and output outside all backed-up data roots');
  if (upload) await privateRepo(ctx.config.backupRepo);
  await checkCoverage(ctx);
  const lock = path.join(ctx.state, '.backup-lock');
  await fs.mkdir(lock, { mode: 0o700 });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'raft-backup-'));
  let computer, apiRunning = false, apiStopped = false, redisStopped = false, pending=false, failure;
  const resumeFile=path.join(ctx.state,'computer-resume.json');
  try {
    const services = (await compose(ctx, ['ps', '--status', 'running', '--services'])).trim().split('\n');
    if (!services.includes('redis')) throw new Error('Managed Redis must be running for a complete backup');
    computer = await stopComputer(ctx,{strict:true});
    if(computer.running) {
      const record=resumeFile+'.'+randomUUID();
      try {await writeJson(record,{version:1,...computer});await fs.rename(record,resumeFile);pending=true;}
      finally {await fs.rm(record,{force:true});}
    }
    apiRunning = services.includes('api');
    if (apiRunning) { await compose(ctx, ['stop', '-t', '60', 'api']); apiStopped = true; }
    const deployment = path.join(temp, 'deployment');
    await fs.mkdir(deployment, { mode: 0o700 });
    for (const name of ['server.env', 'config.json']) await fs.copyFile(path.join(ctx.state, name), path.join(deployment, name));
    await compose(ctx, ['exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-d', 'slock', '-Fc', '--no-publications', '--no-subscriptions'], { outputFile: path.join(deployment, 'database.dump') });
    await compose(ctx, ['exec', '-T', 'db', 'pg_dumpall', '-U', 'postgres', '--roles-only'], { outputFile: path.join(deployment, 'roles.sql') });
    await saveRedis(ctx);
    await compose(ctx, ['stop', '-t', '60', 'redis']); redisStopped = true;
    await copyRedisData(ctx, path.join(deployment, 'redis'));
    // Source revision and helper sources travel with the encrypted data.
    await fs.cp(path.join(ROOT, 'scripts/local'), path.join(deployment, 'tools'), { recursive: true });
    await fs.cp(path.join(ROOT, 'deploy/local'), path.join(deployment, 'deploy'), { recursive: true });
    await writeJson(path.join(temp, 'spec.json'), { roots: [...roots, { name: 'deployment', path: deployment }], metadata: {
      createdAt: new Date().toISOString(), sourceRevision: ctx.config.sourceRevision, postgresMajor: 16,
      originalState: ctx.state, computer, apiRunning, port: ctx.config.port,
      redisSnapshot: { version: 1, image: REDIS_IMAGE, persistence: 'rdb' },
    } });
    await pack(path.join(temp, 'spec.json'), path.join(temp, 'data.tar.gz'));
    if (redisStopped) { await compose(ctx, ['start', 'redis']); await waitRedis(ctx); redisStopped = false; }
    if (apiStopped) { await compose(ctx, ['start', 'api']); apiStopped = false; }
    await resumeComputer(ctx, computer,{strict:true}); computer = undefined;
    if(pending){await fs.rm(resumeFile,{force:true});pending=false;}
    await encrypt(path.join(temp, 'data.tar.gz'), path.join(temp, 'data.enc'), key);
    await split(path.join(temp, 'data.enc'), output);
    if (upload) console.log(`Published private backup: ${await publish(output, ctx.config.backupRepo)}`);
    return output;
  } catch(error) {failure=error;throw error;}
  finally {
    const errors=[];
    async function attempt(fn){try{await fn();}catch(e){errors.push(e);}}
    if(redisStopped)await attempt(async()=>{await compose(ctx,['start','redis']);await waitRedis(ctx);});
    if(apiStopped)await attempt(()=>compose(ctx,['start','api']));
    if(computer)await attempt(async()=>{
      await resumeComputer(ctx,computer,{strict:true});
      if(pending)await fs.rm(resumeFile,{force:true});
    });
    await attempt(()=>fs.rm(temp,{recursive:true,force:true}));
    await attempt(()=>fs.rmdir(lock));
    if(errors.length)throw new AggregateError([...(failure?[failure]:[]),...errors],'Backup/recovery failed; inspect service status and retry local start');
  }
}
// Only links authenticated and verified inside the archive are rebound. External
// roots move under external/<name>; Computer stays disabled throughout recovery.
export async function rebindLinks(manifest,destination,extraRoots) {
  const targets=new Map([['raft',path.join(destination,'raft')],['uploads',path.join(destination,'uploads')],['deployment',path.join(destination,'recovery')],...extraRoots.map(r=>[r.name,r.path])]);
  for(const entry of manifest.files.filter(f=>f.type==='symlink')) {
    const [sourceName,...parts]=entry.path.split('/');
    if(!entry.targetRoot) {
      const archiveTarget=path.posix.normalize(path.posix.join(path.posix.dirname(entry.path),entry.target));
      if(archiveTarget.split('/')[0]!==sourceName)throw new Error('Missing registered link mapping');
      continue;
    }
    const base=targets.get(sourceName),targetBase=targets.get(entry.targetRoot);
    if(!base||!targetBase||typeof entry.targetPath!=='string')throw new Error('Invalid registered link mapping');
    const link=path.resolve(base,...parts),target=path.resolve(targetBase,entry.targetPath);
    if(!inside(base,link)||link===base||!inside(targetBase,target))throw new Error('Registered link escapes restored roots');
    if(await fs.readlink(link)!==entry.target)throw new Error('Registered link does not match archive');
    const realBase=await fs.realpath(base),realParent=await fs.realpath(path.dirname(link));
    const realTargetBase=await fs.realpath(targetBase),realTarget=await fs.realpath(target);
    if(!inside(realBase,realParent)||!inside(realTargetBase,realTarget))throw new Error('Registered link resolves outside restored roots');
    await fs.unlink(link);await fs.symlink(path.relative(path.dirname(link),target)||'.',link);
  }
}
export async function restore(bundle, key, destination, { start = true } = {}) {
  destination = path.resolve(destination);
  try { await fs.lstat(destination); throw new Error('Restore target already exists'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'raft-restore-'));
  try {
    await join(bundle, path.join(temp, 'data.enc'));
    await decrypt(path.join(temp, 'data.enc'), path.join(temp, 'data.tar.gz'), key);
    await unpack(path.join(temp, 'data.tar.gz'), path.join(temp, 'verified'));
    const verified = path.join(temp, 'verified'), manifest = await json(path.join(verified, 'manifest.json'));
    const old = await json(path.join(verified, 'deployment/config.json'));
    const expectedRevision = await sourceRevision();
    if (manifest.postgresMajor !== 16 || old.sourceRevision !== manifest.sourceRevision || manifest.sourceRevision !== expectedRevision) throw new Error('Unsupported source/database version');
    if (manifest.redisSnapshot) {
      if (manifest.redisSnapshot.version !== 1 || manifest.redisSnapshot.image !== REDIS_IMAGE || manifest.redisSnapshot.persistence !== 'rdb') throw new Error('Unsupported Redis snapshot version');
      const snapshot=path.join(verified,'deployment/redis');
      await fs.access(path.join(snapshot,'dump.rdb'));
      await run(docker,['run','--rm','--network','none','--volume',`${snapshot}:/snapshot:ro`,REDIS_IMAGE,'redis-check-rdb','/snapshot/dump.rdb']);
    }
    // Never execute archived Computer paths automatically on a different host.
    await emptyDirectory(destination);
    for (const name of ['uploads', 'raft']) await fs.cp(path.join(verified, name), path.join(destination, name), { recursive: true, verbatimSymlinks: true });
    await fs.copyFile(path.join(verified, 'deployment/server.env'), path.join(destination, 'server.env'));
    if (manifest.redisSnapshot) await fs.cp(path.join(verified, 'deployment/redis'), path.join(destination, 'redis'), { recursive: true });
    const extraRoots = [];
    for (const root of manifest.roots.filter(r => !['uploads', 'raft', 'deployment'].includes(r.name))) {
      const target = path.join(destination, 'external', root.name);
      await fs.cp(path.join(verified, root.name), target, { recursive: true, verbatimSymlinks: true });
      extraRoots.push({ name: root.name, path: target });
    }
    await fs.cp(path.join(verified, 'deployment'), path.join(destination, 'recovery'), { recursive: true });
    await rebindLinks(manifest,destination,extraRoots);
    await writeJson(path.join(destination, 'config.json'), { ...old, project: projectName(destination), extraRoots,
      computer: { ...old.computer, home: path.join(destination, 'raft'), enabled: false }, coverageReviewed: false });
    await writeJson(path.join(destination, 'restore-inventory.json'), {...manifest,redisRecovery:manifest.redisSnapshot?'restored-rdb':'legacy-no-redis-fresh-instance'});
    if(!manifest.redisSnapshot)console.log('Legacy archive has no Redis snapshot: starting fresh Redis; startup adds only missing scope/Redis configuration.');
    const ctx = await load(destination);
    await startDatabase(ctx);
    const count = await sql(ctx, "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');");
    if (count.trim() !== '0') throw new Error('Restore database is not empty');
    const roles = (await fs.readFile(path.join(destination, 'recovery/roles.sql'), 'utf8')).replace(/^CREATE ROLE postgres;$/m, '');
    await sql(ctx, roles, 'postgres');
    await compose(ctx, ['exec', '-T', 'db', 'pg_restore', '-U', 'postgres', '-d', 'slock', '--single-transaction', '--exit-on-error'], { inputFile: path.join(destination, 'recovery/database.dump') });
    if (start) await startApp(ctx, { migrate: false });
    console.log('Restored; Computer remains stopped. Review original path mappings in restore-inventory.json before reconnecting.');
    return ctx;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
export async function main(args) {
  const [command, a, b, c] = args;
  if (command === 'keygen' && a) await keygen(a);
  else if (command === 'create' && c) await backup(a, b, c);
  else if (command === 'sync' && c) await backup(a, b, c, { upload: true });
  else if (command === 'restore' && c) await restore(a, b, c);
  else if (command === 'download' && c) await download(a, b, c);
  else if (command === 'publish' && b) console.log(await publish(a, b));
  else throw new Error('Usage: backup.mjs keygen KEY | create|sync STATE KEY OUTPUT | restore BUNDLE KEY NEW_STATE | download REPO TAG OUTPUT | publish BUNDLE REPO');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
