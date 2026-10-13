import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {init} from './local.mjs';
import {ensureServiceConfig,LOCAL_REDIS_URL} from './redis.mjs';
import {hash,run,json} from './common.mjs';
import {keygen} from './archive.mjs';
async function fixture(t) {
 const d=await fs.mkdtemp(path.join(os.tmpdir(),'raft-redis-test-'));
 t.after(()=>fs.rm(d,{recursive:true,force:true}));
 return {d,ctx:await init(d+'/state')};
}
test('new deployment generates private scope signing key and managed Redis URL',async t=>{
 const {ctx}=await fixture(t),env=await fs.readFile(ctx.state+'/server.env','utf8');
 assert.equal(/^REDIS_URL=(.*)$/m.exec(env)[1],LOCAL_REDIS_URL);
 assert.equal(Buffer.from(/^SCOPE_ATTESTATION_SECRET=(.*)$/m.exec(env)[1],'base64').length,32);
 assert.equal((await fs.stat(ctx.state+'/server.env')).mode&0o777,0o600);
});
test('legacy startup adds only missing service config and preserves all old credentials on repeated startup',async t=>{
 const {ctx}=await fixture(t),file=ctx.state+'/server.env';
 const old=(await fs.readFile(file,'utf8')).replace(/^REDIS_URL=.*\n|^SCOPE_ATTESTATION_SECRET=.*\n/gm,'')+'CUSTOM_SETTING=keep\n';
 await fs.writeFile(file,old);
 await ensureServiceConfig(ctx);const next=await fs.readFile(file,'utf8');
 assert.equal(next.replace(/^REDIS_URL=.*\n|^SCOPE_ATTESTATION_SECRET=.*\n/gm,''),old);
 const digest=await hash(file);await ensureServiceConfig(ctx);assert.equal(await hash(file),digest);
});
test('external Redis override is refused without changing local secrets',async t=>{
 const {ctx}=await fixture(t),file=ctx.state+'/server.env';
 await fs.writeFile(file,(await fs.readFile(file,'utf8')).replace(LOCAL_REDIS_URL,'redis://external.example:6379'));
 const before=await hash(file);await assert.rejects(ensureServiceConfig(ctx),/managed Redis/);assert.equal(await hash(file),before);
});
test('failed Redis export restores original API and Redis state and never publishes a partial snapshot',async t=>{
 const {ctx,d}=await fixture(t),exe=d+'/docker';
 ctx.config.coverageReviewed=true;await fs.writeFile(ctx.state+'/config.json',JSON.stringify(ctx.config));
 await keygen(d+'/key');await fs.writeFile(d+'/service-state',JSON.stringify({running:['db','redis','api'],calls:[]}));
 await fs.writeFile(exe,`#!${process.execPath}\nimport fs from 'node:fs';const p=process.env.FIXTURE_STATE,s=JSON.parse(fs.readFileSync(p)),a=process.argv.slice(2);s.calls.push(a);const save=()=>fs.writeFileSync(p,JSON.stringify(s));if(a.includes('ps'))console.log(s.running.join('\\n'));if(a.includes('SAVE'))console.log('OK');if(a.includes('PING'))console.log('PONG');if(a.includes('stop'))s.running=s.running.filter(x=>x!==a.at(-1));if(a.includes('start')&&!s.running.includes(a.at(-1)))s.running.push(a.at(-1));if(a.includes('pg_dump'))console.log('fixture dump');save();if(a.includes('cp'))process.exit(2);`,{mode:0o700});
 const code=`import {backup} from './scripts/local/backup.mjs';await backup(${JSON.stringify(ctx.state)},${JSON.stringify(d+'/key')},${JSON.stringify(d+'/snapshot')});`;
 await assert.rejects(run(process.execPath,['--input-type=module','-e',code],{env:{RAFT_DOCKER:exe,FIXTURE_STATE:d+'/service-state'}}));
 assert.deepEqual((await json(d+'/service-state')).running.sort(),['api','db','redis']);
 await assert.rejects(fs.access(d+'/snapshot'));await assert.rejects(fs.access(ctx.state+'/.backup-lock'));
});
test('quoted empty configuration is generated; quoted and duplicate signing keys are preserved',async t=>{
 const {ctx}=await fixture(t),file=ctx.state+'/server.env';
 await fs.writeFile(file,`REDIS_URL="${LOCAL_REDIS_URL}"\nSCOPE_ATTESTATION_SECRET=''\n`);
 await ensureServiceConfig(ctx);
 const signed=await fs.readFile(file,'utf8');assert.match(signed,/SCOPE_ATTESTATION_SECRET=[A-Za-z0-9+/=]{44}\n/);
 const preserved=`REDIS_URL='${LOCAL_REDIS_URL}'\nSCOPE_ATTESTATION_SECRET='existing-key'\nSCOPE_ATTESTATION_SECRET="existing-key"\n`;
 await fs.writeFile(file,preserved);await ensureServiceConfig(ctx);assert.equal(await fs.readFile(file,'utf8'),preserved);
});
test('conflicting managed assignments fail before changing either key',async t=>{
 const {ctx}=await fixture(t),file=ctx.state+'/server.env';
 const old=`REDIS_URL=${LOCAL_REDIS_URL}\nSCOPE_ATTESTATION_SECRET=first\nSCOPE_ATTESTATION_SECRET=second\n`;
 await fs.writeFile(file,old);await assert.rejects(ensureServiceConfig(ctx),/Conflicting SCOPE/);assert.equal(await fs.readFile(file,'utf8'),old);
});
test('unquoted empty scope key does not consume the next environment line',async t=>{
 const {ctx}=await fixture(t),file=ctx.state+'/server.env';
 await fs.writeFile(file,`REDIS_URL=${LOCAL_REDIS_URL}\nSCOPE_ATTESTATION_SECRET=\nCUSTOM_SETTING=keep\n`);
 await ensureServiceConfig(ctx);const text=await fs.readFile(file,'utf8');
 assert.match(text,/SCOPE_ATTESTATION_SECRET=[A-Za-z0-9+/=]{44}\nCUSTOM_SETTING=keep\n/);
});
test('mixed colon/equal conflicting scope values are rejected without writing',async t=>{
 const {ctx}=await fixture(t),file=ctx.state+'/server.env';
 const text='SCOPE_ATTESTATION_SECRET=first\n SCOPE_ATTESTATION_SECRET: second\n';
 await fs.writeFile(file,text);await assert.rejects(ensureServiceConfig(ctx),/Conflicting/);assert.equal(await fs.readFile(file,'utf8'),text);
});
test('empty key on the BOM first line is filled without leaving conflicting duplicate keys',async t=>{
 const {ctx}=await fixture(t),file=ctx.state+'/server.env';
 await fs.writeFile(file,`\uFEFFSCOPE_ATTESTATION_SECRET=''\nREDIS_URL=${LOCAL_REDIS_URL}\n`);
 await ensureServiceConfig(ctx);const content=await fs.readFile(file,'utf8');
 assert.ok(content.startsWith('\uFEFFSCOPE_ATTESTATION_SECRET='));
 assert.equal(content.split('SCOPE_ATTESTATION_SECRET=').length,2);
 const before=await hash(file);await ensureServiceConfig(ctx);assert.equal(await hash(file),before);
});
