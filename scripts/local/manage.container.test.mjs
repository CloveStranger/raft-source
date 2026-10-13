import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {observeOnline} from './online.mjs';
import {init,startApp} from './local.mjs';
import {account,createContent,api,seedComputer} from './app-fixture.mjs';
import {ROOT,compose,sql,hash,run,waitFor} from './common.mjs';

test('project entry restarts and stop/starts an isolated app with account, chat, Agent and files preserved', {timeout:600000},async()=>{
  const executable=process.env.RAFT_COMPUTER_TEST_EXECUTABLE;
  assert.ok(executable && path.isAbsolute(executable),'Matching installed Computer required; test uses an isolated home');
  const d=await fs.mkdtemp('/private/tmp/rctl-');
  let ctx;
  const command=args=>run('/bin/bash',[ROOT+'/raft-local',...args,'--state',ctx.state],{env:{RAFT_NODE:process.execPath}});
  try {
    ctx=await init(d+'/state',18088);await startApp(ctx);
    const user=await account(ctx),content=await createContent(ctx,user);
    await seedComputer(ctx,user,executable);
    const computer=args=>run(executable,args,{env:{RAFT_HOME:ctx.config.computer.home,SLOCK_HOME:ctx.config.computer.home,RAFT_SERVER_URL:`http://localhost:${ctx.config.port}`,SLOCK_SERVER_URL:`http://localhost:${ctx.config.port}`}});
    const second=await api(ctx,'/api/servers',{token:user.accessToken,method:'POST',body:{name:'Attached stopped fixture',slug:`second-${user.server.slug}`}});
    for(const server of [user.server,second])await computer(['attach',server.slug,'--server-url',`http://localhost:${ctx.config.port}`,'--no-start']);
    await computer(['start',user.server.slug]);
    const running=async()=>{
      const s=JSON.parse(await computer(['status','--json']));
      assert.deepEqual(s.attestation.managedServerIds,[user.server.id]);
      assert.ok(s.servers.find(s=>s.serverId===user.server.id).serverConnected);
      assert.equal(s.servers.find(s=>s.serverId===second.id).daemon.running,false);
    };
    await waitFor(running,'isolated Computer ready',90);
    await observeOnline(ctx,user.server.slug,120);
    const expectedEnv=await hash(ctx.state+'/server.env');
    const expectedRows=await sql(ctx,`SELECT row_to_json(m)::text FROM messages m WHERE id='${content.message.id}';`);
    const files=[];
    for(const file of await fs.readdir(ctx.state+'/uploads',{recursive:true})) {
      if((await fs.stat(ctx.state+'/uploads/'+file)).isFile())files.push([file,await hash(ctx.state+'/uploads/'+file)]);
    }
    assert.ok(files.length>=3);
    await command(['restart']);
    await waitFor(running,'Computer original subset after restart',90);
    await observeOnline(ctx,user.server.slug,120);
    await command(['stop']);
    const services=(await compose(ctx,['ps','--status','running','--services'])).trim();assert.equal(services,'');
    await command([]); // No command is the documented one-click start.
    await waitFor(running,'Computer original subset after start',90);
    assert.equal(await hash(ctx.state+'/server.env'),expectedEnv);
    assert.equal(await sql(ctx,`SELECT row_to_json(m)::text FROM messages m WHERE id='${content.message.id}';`),expectedRows);
    for(const [file,digest] of files)assert.equal(await hash(ctx.state+'/uploads/'+file),digest);
    const login=await api(ctx,'/api/auth/login',{method:'POST',body:{email:user.email,password:user.password}});assert.ok(login.accessToken);
    assert.equal((await sql(ctx,`SELECT description FROM agents WHERE id='${content.agent.id}';`)).trim(),'Restore fixture');
    assert.match(await command(['status']),/http:\/\/localhost:18088/);
    await command(['stop']);
    ctx.config.computer.enabled=false;
    await fs.writeFile(ctx.state+'/config.json',JSON.stringify(ctx.config));
    await command(['start']);
    assert.equal(JSON.parse(await computer(['status','--json'])).service.running,false);
    console.log('Isolated entry retained data, restored only the running Computer subset, and kept a restored disabled Computer stopped.');
  } finally {
    if(ctx) {
      await run(executable,['stop'],{env:{RAFT_HOME:ctx.config.computer.home,SLOCK_HOME:ctx.config.computer.home}});
      await compose(ctx,['down','--volumes','--remove-orphans']);
    }
    await fs.rm(d,{recursive:true,force:true});
  }
});
