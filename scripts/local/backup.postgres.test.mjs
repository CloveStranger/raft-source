import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init, startDatabase } from './local.mjs';
import { backup, restore } from './backup.mjs';
import { keygen } from './archive.mjs';
import {pack,unpack,encrypt,decrypt,split,join} from './archive.mjs';
import { ensureServiceConfig,redis } from './redis.mjs';
import { compose, sql, hash } from './common.mjs';
test('real PG16 + encrypted files restore relations, sequence, roles, ACLs, credentials and workfiles', { timeout: 180000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raft-pg-test-'));
  let original, restored, legacy;
  try {
    original = await init(dir+'/original', 18083);
    await fs.mkdir(dir+'/workspace/.runtime', { recursive:true });
    await fs.writeFile(dir+'/workspace/.runtime/auth.json', '{"token":"fixture-only"}');
    await fs.writeFile(dir+'/workspace/MEMORY.md', '持久记忆');
    await fs.mkdir(dir+'/original/uploads/avatars', {recursive:true});
    await fs.writeFile(dir+'/original/uploads/avatars/test.webp', Buffer.from([0,255,0,3]));
    await fs.writeFile(dir+'/original/uploads/attachment.bin', Buffer.from([4,7,9,0]));
    const skills=['workflow-governance','web-workflow','flutter-workflow','test-workflow','app-build'];
    const expectedSkills=new Map();
    for(const skill of skills) {
      await fs.mkdir(dir+'/skills/'+skill,{recursive:true});
      await fs.writeFile(dir+'/skills/'+skill+'/SKILL.md','skill bytes: '+skill);
      expectedSkills.set(skill,await hash(dir+'/skills/'+skill+'/SKILL.md'));
    }
    await fs.mkdir(dir+'/skills/workflow-governance/references');
    await fs.writeFile(dir+'/skills/workflow-governance/references/shared.md','reference bytes');
    const referenceHash=await hash(dir+'/skills/workflow-governance/references/shared.md');
    for(const agent of ['one','two']) {
      const base=dir+'/workspace/agents/'+agent+'/.agents/skills';await fs.mkdir(base,{recursive:true});
      for(const skill of skills)await fs.symlink(dir+'/skills/'+skill,base+'/'+skill);
    }
    original.config.extraRoots = [{name:'workfiles',path:dir+'/workspace'},{name:'agent-skills',path:dir+'/skills'}]; original.config.coverageReviewed = true;
    await fs.writeFile(dir+'/original/config.json', JSON.stringify(original.config));
    await startDatabase(original);
    await sql(original, `CREATE ROLE backup_reader LOGIN PASSWORD 'fixture-only';
      CREATE TABLE agents(id serial PRIMARY KEY, avatar_url text, runtime_config jsonb);
      CREATE TABLE messages(id serial PRIMARY KEY, agent_id int REFERENCES agents(id), content text);
      CREATE TABLE joint_channels(id text PRIMARY KEY, canonical_channel_id text);
      INSERT INTO agents(avatar_url,runtime_config) VALUES ('/api/cdn/avatars/test.webp','{"model":"test-model","runtime":"codex","env":{"TEST":"yes"}}');
      INSERT INTO messages(agent_id,content) VALUES (1,'chat restored');
      INSERT INTO joint_channels VALUES ('joint1','channel1');
      GRANT SELECT ON messages TO backup_reader;`);
    await redis(original,['SET','fixture:redis-value','持久Redis数据']);
    await redis(original,['RPUSH','fixture:queue','first','second']);
    await redis(original,['HSET','fixture:hash','count','9']);
    await redis(original,['EVAL',"redis.call('SET',KEYS[1],string.char(0,255,1));return 1",'1','fixture:binary']);
    await keygen(dir+'/key');
    await backup(original.state, dir+'/key', dir+'/snapshot');
    await compose(original, ['stop', 'db']);
    restored = await restore(dir+'/snapshot', dir+'/key', dir+'/restored', {start:false});
    assert.equal((await redis(restored,['GET','fixture:redis-value'])).trim(),'持久Redis数据');
    assert.equal((await redis(restored,['LRANGE','fixture:queue','0','-1'])).trim(),'first\nsecond');
    assert.equal((await redis(restored,['HGET','fixture:hash','count'])).trim(),'9');
    assert.equal((await redis(restored,['EVAL',"return redis.call('GET',KEYS[1])==string.char(0,255,1) and 1 or 0",'1','fixture:binary'])).trim(),'1');
    assert.equal((await redis(original,['PING'])).trim(),'PONG');
    assert.equal((await sql(restored, 'SELECT messages.content FROM messages JOIN agents ON agents.id=messages.agent_id;')).trim(),'chat restored');
    assert.equal((await sql(restored, "SELECT runtime_config->>'model' FROM agents;")).trim(),'test-model');
    assert.equal((await sql(restored, "INSERT INTO messages(agent_id,content) VALUES (1,'second') RETURNING id;")).split('\n')[0], '2');
    assert.equal((await sql(restored, "SELECT has_table_privilege('backup_reader','messages','SELECT');")).trim(),'t');
    assert.equal((await sql(restored, 'SELECT canonical_channel_id FROM joint_channels;')).trim(),'channel1');
    for (const f of ['uploads/avatars/test.webp','uploads/attachment.bin','server.env'])
      assert.equal(await hash(dir+'/original/'+f), await hash(dir+'/restored/'+f));
    for (const f of ['MEMORY.md','.runtime/auth.json']) assert.equal(await hash(dir+'/workspace/'+f), await hash(dir+'/restored/external/workfiles/'+f));
    // restore() has returned and its verified temp is gone. Make the fixture's
    // original target unavailable: every skill must still come from recovery.
    await fs.rename(dir+'/skills',dir+'/skills-original-disabled');
    await assert.rejects(fs.access(dir+'/skills'));
    assert.equal(restored.config.computer.enabled,false);
    for(const agent of ['one','two'])for(const skill of skills) {
      const link=dir+'/restored/external/workfiles/agents/'+agent+'/.agents/skills/'+skill;
      assert.equal(await fs.realpath(link),await fs.realpath(dir+'/restored/external/agent-skills/'+skill));
      assert.equal(path.isAbsolute(await fs.readlink(link)),false);
      assert.equal(await hash(link+'/SKILL.md'),expectedSkills.get(skill));
    }
    assert.equal(await hash(dir+'/restored/external/workfiles/agents/one/.agents/skills/workflow-governance/references/shared.md'),referenceHash);
    await assert.rejects(restore(dir+'/snapshot',dir+'/key',dir+'/restored',{start:false}), /already exists/);
    // Reproduce the established four-service archive format: no Redis payload
    // or scope key. PostgreSQL and all registered roots remain unchanged.
    await join(dir+'/snapshot',dir+'/new.enc');await decrypt(dir+'/new.enc',dir+'/new.tar',dir+'/key');
    await unpack(dir+'/new.tar',dir+'/verified');
    const manifest=JSON.parse(await fs.readFile(dir+'/verified/manifest.json','utf8'));
    const {redisSnapshot,files,roots,excluded,format,...metadata}=manifest;
    // Re-encrypt legal archives with a declared but missing/invalid RDB. Hash
    // integrity alone must not let Redis start empty and claim full recovery.
    const rdb=dir+'/verified/deployment/redis/dump.rdb';
    const validRdb=await fs.readFile(rdb);
    for(const kind of ['missing','invalid']) {
      if(kind==='missing')await fs.rm(rdb);else await fs.writeFile(rdb,'not an RDB');
      await fs.writeFile(dir+'/bad-spec',JSON.stringify({roots:roots.map(r=>({...r,path:dir+'/verified/'+r.name})),metadata:{...metadata,redisSnapshot}}));
      await pack(dir+'/bad-spec',dir+'/'+kind+'.tar');await encrypt(dir+'/'+kind+'.tar',dir+'/'+kind+'.enc',dir+'/key');await split(dir+'/'+kind+'.enc',dir+'/'+kind+'-bundle');
      await assert.rejects(restore(dir+'/'+kind+'-bundle',dir+'/key',dir+'/'+kind+'-target',{start:false}));
      await assert.rejects(fs.access(dir+'/'+kind+'-target'));
    }
    await fs.writeFile(rdb,validRdb);
    await fs.rm(dir+'/verified/deployment/redis',{recursive:true});
    // Historical format1 cannot contain registered cross-root mapping entries.
    await fs.rm(dir+'/verified/workfiles/agents',{recursive:true});
    const legacyEnv=(await fs.readFile(dir+'/verified/deployment/server.env','utf8')).replace(/^REDIS_URL=.*\n|^SCOPE_ATTESTATION_SECRET=.*\n/gm,'');
    await fs.writeFile(dir+'/verified/deployment/server.env',legacyEnv);
    await fs.writeFile(dir+'/legacy-spec',JSON.stringify({roots:roots.map(r=>({...r,path:dir+'/verified/'+r.name})),metadata}));
    await pack(dir+'/legacy-spec',dir+'/legacy.tar');await encrypt(dir+'/legacy.tar',dir+'/legacy.enc',dir+'/key');await split(dir+'/legacy.enc',dir+'/legacy-bundle');
    legacy=await restore(dir+'/legacy-bundle',dir+'/key',dir+'/legacy-restored',{start:false});
    assert.equal((await sql(legacy,'SELECT content FROM messages ORDER BY id LIMIT 1;')).trim(),'chat restored');
    assert.equal((await redis(legacy,['EXISTS','fixture:redis-value'])).trim(),'0');
    const legacyInventory=JSON.parse(await fs.readFile(legacy.state+'/restore-inventory.json','utf8'));
    assert.equal(legacyInventory.redisRecovery,'legacy-no-redis-fresh-instance');assert.equal(legacyInventory.format,1);
    assert.equal(await fs.readFile(legacy.state+'/server.env','utf8'),legacyEnv);
    await ensureServiceConfig(legacy);
    assert.equal((await fs.readFile(legacy.state+'/server.env','utf8')).replace(/^REDIS_URL=.*\n|^SCOPE_ATTESTATION_SECRET=.*\n/gm,''),legacyEnv);

  } finally {
    for (const ctx of [legacy,restored,original]) if (ctx) await compose(ctx,['down','--volumes','--remove-orphans']);
    await fs.rm(dir,{recursive:true,force:true});
  }
});
