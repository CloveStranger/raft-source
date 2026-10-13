import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init,startApp } from './local.mjs';
import { compose,run,waitFor,hash } from './common.mjs';
import { account,seedComputer } from './app-fixture.mjs';
import { backup,restore } from './backup.mjs';
import { keygen } from './archive.mjs';
import {observeOnline} from './online.mjs';
import {redis} from './redis.mjs';
import {verifyWorkerScope} from './scope-fixture.mjs';
import { stopComputer,resumeComputer } from './computer.mjs';

test('real Computer stops, backs up workfiles, resumes only its managed workspace and reconnects after restore', {timeout:600000},async()=>{
  const executable=process.env.RAFT_COMPUTER_TEST_EXECUTABLE;
  assert.ok(executable && path.isAbsolute(executable),'Set RAFT_COMPUTER_TEST_EXECUTABLE to the matching installed Computer (isolated home only)');
  const d=await fs.mkdtemp('/private/tmp/rc-');
  let original,restored;
  const call=(ctx,args)=>run(executable,args,{env:{RAFT_HOME:ctx.config.computer.home,SLOCK_HOME:ctx.config.computer.home,RAFT_SERVER_URL:`http://localhost:${ctx.config.port}`,SLOCK_SERVER_URL:`http://localhost:${ctx.config.port}`}});
  try {
    original=await init(d+'/original',18086);await startApp(original);
    const user=await account(original);await seedComputer(original,user,executable);
    await call(original,['attach',user.server.slug,'--server-url',`http://localhost:${original.config.port}`,'--no-start']);
    await call(original,['start',user.server.slug]);
    await waitFor(async()=>{const s=JSON.parse(await call(original,['status','--json']));assert.ok(s.service.running);assert.ok(s.servers.some(s=>s.serverConnected));},'Computer connected',90);
    await fs.mkdir(original.config.computer.home+'/agents/fixture/.runtime',{recursive:true});
    await fs.writeFile(original.config.computer.home+'/agents/fixture/MEMORY.md','Agent工作文件');
    await fs.writeFile(original.config.computer.home+'/agents/fixture/.runtime/settings.json','{"fixture":true}');
    original.config.coverageReviewed=true;await fs.writeFile(original.state+'/config.json',JSON.stringify(original.config));
    const attachment=JSON.parse(await fs.readFile(original.config.computer.home+'/computer/servers/'+user.server.id+'/runner.state.json','utf8'));
    const response=await fetch(`http://localhost:${original.config.port}/internal/machine/scope-attestation`,{method:'POST',headers:{Authorization:`Bearer ${attachment.apiKey}`,'Content-Type':'application/json','X-Server-Id':user.server.id},body:JSON.stringify({scope:'feedback-report:create'})});
    assert.equal(response.status,200,'scope attestation must be configured');
    const endpointToken=(await response.json()).attestation;assert.ok(endpointToken);
    assert.deepEqual(await verifyWorkerScope(original,endpointToken),{valid:true,scope:'feedback-report:create',serverId:user.server.id});
    // The real endpoint's token lasts two minutes. A one-hour fixture isolates
    // restored-key verification from expiry during the continuous-online test.
    const attestation=(await compose(original,['exec','-T','api','node','--import','@oxc-node/core/register','--input-type=module','-e',"import {readFileSync} from 'node:fs';import {verifyScopeAttestation,createScopeAttestation} from './packages/server/src/lib/scopeAttestation.ts';const claims=verifyScopeAttestation(readFileSync(0,'utf8'));if(!claims)throw new Error('Endpoint signature invalid');console.log(createScopeAttestation({...claims,exp:Math.floor(Date.now()/1000)+3600}));"],{input:endpointToken})).trim();
    await redis(original,['SET','fixture:redis-recovery','persistent value']);
    const originalEnv=await hash(original.state+'/server.env');
    await keygen(d+'/key');await backup(original.state,d+'/key',d+'/snapshot');
    const after=JSON.parse(await call(original,['status','--json']));assert.equal(after.service.running,true);
    assert.deepEqual(after.attestation.managedServerIds,[user.server.id]);
    await observeOnline(original,user.server.slug,120);
    await stopComputer(original);await compose(original,['stop']);
    restored=await restore(d+'/snapshot',d+'/key',d+'/restored');
    assert.equal(await hash(restored.state+'/server.env'),originalEnv);
    assert.equal((await redis(restored,['GET','fixture:redis-recovery'])).trim(),'persistent value');
    assert.deepEqual(await verifyWorkerScope(restored,attestation),{valid:true,scope:'feedback-report:create',serverId:user.server.id});
    assert.equal(await hash(restored.state+'/raft/agents/fixture/MEMORY.md'),await hash(original.state+'/raft/agents/fixture/MEMORY.md'));
    assert.equal((JSON.parse(await call(restored,['status','--json']))).service.running,false);
    restored.config.computer.enabled=true;
    const inventory=JSON.parse(await fs.readFile(restored.state+'/restore-inventory.json','utf8'));
    await resumeComputer(restored,inventory.computer);
    await waitFor(async()=>{const s=JSON.parse(await call(restored,['status','--json']));assert.ok(s.servers.some(s=>s.serverConnected));assert.deepEqual(s.attestation.managedServerIds,[user.server.id]);},'restored Computer connected',90);
    await observeOnline(restored,user.server.slug,120);
  } catch(error) {
    console.error('Isolated Computer fixture:', d);
    for(const ctx of [restored,original]) if(ctx) {
      const base=ctx.config.computer.home+'/computer';
      for(const file of [base+'/run/service.log',...((await fs.readdir(base+'/servers').catch(()=>[])).map(id=>base+'/servers/'+id+'/runner.log'))]) {
        const text=await fs.readFile(file,'utf8').catch(()=> '');
        console.error(text.split('\n').filter(l=>/error|Error|fail|FAIL|ENOENT|socket|timeout/.test(l)).slice(-12).join('\n'));
      }
    }
    throw error;
  } finally {
    for(const ctx of [restored,original]) if(ctx) {
      if(ctx.config.computer.enabled) await call(ctx,['stop']);
      await compose(ctx,['down','--volumes','--remove-orphans']);
    }
    await fs.rm(d,{recursive:true,force:true});
  }
});
