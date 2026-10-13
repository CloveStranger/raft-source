import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {ROOT,load,hash,json,run,compose,inside} from './common.mjs';
import {download} from './github.mjs';
import {join,decrypt,unpack} from './archive.mjs';
import {restore} from './backup.mjs';
import {cleanupRecovery} from './recovery-cleanup.mjs';

// Explicit operational verification: uploads an encrypted snapshot to the
// configured private repo and restores data only; never starts another Computer.
const [state,key,base]=process.argv.slice(2);
if(!state||!key||!base)throw new Error('Usage: verify-private.mjs STATE KEY SNAPSHOTS');
const ctx=await load(state);
assert.equal(ctx.config.backupRepo,'CloveStranger/raft-backups','This formal verification is authorized for the configured private backup repo only');
const log=await run('/bin/bash',[path.join(ROOT,'raft-local'),'backup','--state',ctx.state,'--key',key,'--snapshots',base],{env:{RAFT_NODE:process.execPath}});
const tag=/Published private backup: (backup-[A-Za-z0-9.-]+)/.exec(log)?.[1];assert.ok(tag,'Backup was not published');
const check=await fs.mkdtemp(path.join(base,'verified-'));await fs.chmod(check,0o700);
let recovered,evidence;
const recoveryState=path.join(check,'restored');
try {
 await download(ctx.config.backupRepo,tag,path.join(check,'download'));
 await join(path.join(check,'download'),path.join(check,'data.enc'));
 await decrypt(path.join(check,'data.enc'),path.join(check,'data.tar.gz'),key);
 await unpack(path.join(check,'data.tar.gz'),path.join(check,'contents'));
 const root=path.join(check,'contents'),manifest=await json(path.join(root,'manifest.json'));
 assert.equal(manifest.format,2);assert.equal(manifest.redisSnapshot.persistence,'rdb');
 assert.equal(await hash(path.join(root,'deployment/server.env')),await hash(path.join(ctx.state,'server.env')));
 recovered=await restore(path.join(check,'download'),key,recoveryState,{start:false});
 assert.equal(recovered.config.computer.enabled,false);
 const restoredSkillRoot=recovered.config.extraRoots.find(r=>r.name==='agent-skills');assert.ok(restoredSkillRoot);
 const realRoot=await fs.realpath(restoredSkillRoot.path);
 let links=0;
 for(const entry of manifest.files.filter(f=>f.targetRoot==='agent-skills')) {
  const [name,...parts]=entry.path.split('/');assert.equal(name,'raft');
  const link=path.join(recovered.state,'raft',...parts),resolved=await fs.realpath(link);
  assert.equal(path.isAbsolute(await fs.readlink(link)),false);assert.ok(inside(realRoot,resolved));
  const archivedSkill=path.join(root,'agent-skills',entry.targetPath,'SKILL.md');
  assert.equal(await hash(path.join(link,'SKILL.md')),await hash(archivedSkill));links++;
 }
 assert.ok(links>0,'Formal registered skill references were not restored');
 evidence={tag,repository:ctx.config.backupRepo,format:2,downloadAuthenticated:true,envUnchanged:true,redisSnapshotValidated:true,computerDisabled:true,recoveredSkillLinks:links,registeredRoots:manifest.roots.map(r=>r.name),files:manifest.files.length};
} finally {
 await cleanupRecovery(recoveryState,recovered);
}
evidence.cleanupCompleted=true;
await fs.writeFile(path.join(check,'verification.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(evidence));
