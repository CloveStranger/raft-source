import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {operate,interactive,options} from './manage.mjs';
import {stopComputer,resumeComputer} from './computer.mjs';
import {ROOT,run,json} from './common.mjs';

async function fixture(t) {
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'raft-control-'));
  t.after(()=>fs.rm(d,{recursive:true,force:true}));
  const ctx={state:d,config:{port:18087,backupRepo:'owner/private',computer:{enabled:true,home:d+'/raft',executable:'/fixture/computer'}}};
  const calls=[];
  let running=true;
  const deps={
    startApp:async()=>calls.push('ready'),
    compose:async(_,args)=>{calls.push(args);return 'fixture services';},
    stopComputer:async()=>{const s={running,servers:running?[{id:'one',slug:'one'}]:[]};running=false;calls.push('computer-stop');return s;},
    resumeComputer:async(_,s)=>{running=s.running;calls.push(['resume',s]);},
    interactive:async(exe,args,env)=>calls.push({exe,args,env}),
    scheduledBackup:async args=>calls.push(args),
  };
  return {d,ctx,calls,deps};
}
test('restart resumes only the old run set after readiness and consumes the pending file',async t=>{
  const {d,ctx,calls,deps}=await fixture(t);
  await operate('restart',ctx,{},deps);
  assert.deepEqual(calls,['computer-stop',['stop'],'ready',['resume',{running:true,servers:[{id:'one',slug:'one'}]}]]);
  await assert.rejects(fs.access(d+'/computer-resume.json'));
  await assert.rejects(fs.access(d+'/.backup-lock'));
});
test('repeated stop then start preserves the run set and data; failed start leaves recovery intent',async t=>{
  const {d,ctx,calls,deps}=await fixture(t);
  await fs.writeFile(d+'/valuable','original');
  await operate('stop',ctx,{},deps);await operate('stop',ctx,{},deps);
  assert.equal((await fs.stat(d+'/computer-resume.json')).mode&0o777,0o600);
  const record=await json(d+'/computer-resume.json');
  const before={running:record.running,servers:record.servers};
  await assert.rejects(operate('start',ctx,{}, {...deps,startApp:async()=>{throw new Error('fixture startup failure');}}));
  assert.deepEqual(await json(d+'/computer-resume.json'),record);
  await operate('start',ctx,{},deps);
  assert.deepEqual(calls.at(-1),['resume',before]);
  assert.equal(await fs.readFile(d+'/valuable','utf8'),'original');
});
test('restored disabled Computer stays stopped and an active backup prevents service mutations',async t=>{
  const {d,ctx,calls,deps}=await fixture(t);
  ctx.config.computer.enabled=false;
  await fs.writeFile(d+'/computer-resume.json',JSON.stringify({running:true,servers:[{slug:'one'}]}));
  await operate('start',ctx,{},deps);
  assert.deepEqual(calls,['ready']);
  await fs.access(d+'/computer-resume.json');
  await fs.mkdir(d+'/.backup-lock');
  await assert.rejects(operate('restart',ctx,{},deps),{code:'EEXIST'});
  assert.deepEqual(calls,['ready']);
});
test('connect targets the selected local origin and isolated home; backup delegates to existing scheduler',async t=>{
  const {ctx,calls,deps}=await fixture(t);
  await operate('connect',ctx,{slug:'/local-one'},deps);
  assert.deepEqual(calls[1],{exe:'/fixture/computer',args:['setup','/local-one','--server-url','http://localhost:18087'],env:{RAFT_HOME:ctx.config.computer.home,SLOCK_HOME:ctx.config.computer.home,RAFT_SERVER_URL:'http://localhost:18087',SLOCK_SERVER_URL:'http://localhost:18087'}});
  await operate('backup',ctx,{key:'/outside/key',snapshots:'/outside/snapshots'},deps);
  assert.deepEqual(calls.at(-1),['run',ctx.state,'/outside/key','/outside/snapshots']);
});
test('interactive Computer forwards argv and environment without shell expansion',async t=>{
  const {d}=await fixture(t),exe=d+'/computer';
  await fs.writeFile(exe,`#!${process.execPath}\nimport fs from 'node:fs';fs.writeFileSync(process.env.PROBE,JSON.stringify({args:process.argv.slice(2),home:process.env.RAFT_HOME}));`,{mode:0o700});
  await interactive(exe,['setup','/one','--server-url','http://localhost:18087'],{PROBE:d+'/probe',RAFT_HOME:d+'/isolated'});
  assert.deepEqual(await json(d+'/probe'),{args:['setup','/one','--server-url','http://localhost:18087'],home:d+'/isolated'});
  await fs.writeFile(exe,`#!${process.execPath}\nimport fs from 'node:fs';let input='';for await(const data of process.stdin)input+=data;fs.writeFileSync(process.env.PROBE,input);`,{mode:0o700});
  await run(process.execPath,['--input-type=module','-e',`import {interactive} from './scripts/local/manage.mjs';await interactive(${JSON.stringify(exe)},[],{PROBE:${JSON.stringify(d+'/input')}});`],{input:'browser-approval input fixture'});
  assert.equal(await fs.readFile(d+'/input','utf8'),'browser-approval input fixture');
});
test('launcher works outside repository and with spaces, old system Node and preinstalled NVM Node',async t=>{
  const {d}=await fixture(t),copy=d+'/project space';
  await fs.mkdir(copy+'/scripts/local',{recursive:true});
  await fs.copyFile(ROOT+'/raft-local',copy+'/raft-local');
  await fs.copyFile(ROOT+'/start-raft.command',copy+'/start-raft.command');
  await fs.copyFile(ROOT+'/restart-raft.command',copy+'/restart-raft.command');
  await fs.writeFile(copy+'/scripts/local/manage.mjs',`console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));`);
  await fs.mkdir(d+'/home/.nvm/versions/node/v24.fixture/bin',{recursive:true});
  await fs.symlink(process.execPath,d+'/home/.nvm/versions/node/v24.fixture/bin/node');
  const env={HOME:d+'/home',PATH:'/usr/bin:/bin',RAFT_NODE:''};
  const result=JSON.parse(await run('/bin/bash',[copy+'/raft-local','status','--state',d+'/state space'],{env}));
  assert.deepEqual(result,{args:['status','--state',d+'/state space'],cwd:await fs.realpath(ROOT)});
  const doubleClick=JSON.parse(await run('/bin/bash',[copy+'/start-raft.command','--state',d+'/state space'],{env}));
  assert.deepEqual(doubleClick.args,['start','--state',d+'/state space']);
  const restartClick=JSON.parse(await run('/bin/bash',[copy+'/restart-raft.command','--state',d+'/state space'],{env}));
  assert.deepEqual(restartClick.args,['restart','--state',d+'/state space']);
  await assert.rejects(run('/bin/bash',[copy+'/raft-local','help'],{env:{...env,RAFT_NODE:'/usr/local/bin/node'}}));
});

test('restart of an already stopped Computer keeps it stopped; successful connect supersedes pending intent',async t=>{
 const {d,ctx,calls,deps}=await fixture(t);
 await operate('stop',ctx,{},deps);
 await operate('restart',ctx,{},deps);
 assert.equal(calls.some(c=>Array.isArray(c)&&c[0]==='resume'),false);
 await fs.access(d+'/computer-resume.json');
 await operate('connect',ctx,{slug:'/new'},deps);
 await assert.rejects(fs.access(d+'/computer-resume.json'));
});
test('argument precedence, relative paths and invalid commands are decided before loading or mutating an instance',()=>{
 assert.equal(options([]).command,'start');
 assert.equal(options(['status','--state','relative dir']).state,'relative dir');
 assert.equal(options(['backup','--key','/k','--snapshots','/b']).key,'/k');
 assert.equal(options(['backup','--key','/k','--snapshots','/b']).snapshots,'/b');
 assert.throws(()=>options(['destroy']));assert.throws(()=>options(['connect']));
});

test('lifecycle strict Computer boundaries refuse a mixed retained set before stop and detect extra restored targets',async t=>{
 const {d,ctx}=await fixture(t),exe=d+'/strict-computer';
 ctx.config.computer.executable=exe;ctx.config.computer.home=d;
 await fs.writeFile(exe,`#!${process.execPath}\nimport fs from 'node:fs';const p=process.env.RAFT_HOME+'/strict';let s=JSON.parse(fs.readFileSync(p));s.calls.push(process.argv.slice(2));fs.writeFileSync(p,JSON.stringify(s));if(process.argv[2]==='status')console.log(JSON.stringify(s.status));`,{mode:0o700});
 const status={service:{running:true},attestation:{managedServerIds:['one','two']},servers:[{serverId:'one',serverSlug:'one',daemon:{running:true}},{serverId:'two',serverSlug:'two',daemon:{running:false}}]};
 await fs.writeFile(d+'/strict',JSON.stringify({status,calls:[]}));
 await assert.rejects(stopComputer(ctx,{strict:true}),/不一致/);
 assert.deepEqual((await json(d+'/strict')).calls,[['status','--json']]);
 await assert.rejects(resumeComputer(ctx,{running:true,servers:[{id:'one',slug:'one'}]},{strict:true}),/不一致/);
});
