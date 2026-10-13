import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init } from './local.mjs';
import { ROOT, run, json } from './common.mjs';
import { plist } from './schedule.mjs';
import { stopComputer, resumeComputer } from './computer.mjs';
import { dataRoots, checkCoverage } from './backup.mjs';
import { keygen, encrypt, split } from './archive.mjs';
import { RISINGWAVE_REQUIRED_RELATIONS, RISINGWAVE_BOOTSTRAP_ARTIFACTS, buildRisingWaveBootstrapStatements } from '../dev/raftdev-risingwave-bootstrap.ts';
async function dir(t) { const d=await fs.mkdtemp(path.join(os.tmpdir(),'raft-local-test-')); t.after(()=>fs.rm(d,{recursive:true,force:true}));return d; }

test('init is exclusive, keys are private, data-root omissions fail', async t => {
  const d=await dir(t), ctx=await init(d+'/state');
  assert.equal((await fs.stat(d+'/state/server.env')).mode & 0o777,0o600);
  await assert.rejects(init(d+'/state'));
  await assert.rejects(checkCoverage(ctx), /coverageReviewed/);
  ctx.config.extraRoots=[{name:'missing',path:d+'/missing'}];
  await assert.rejects(dataRoots(ctx));
});
test('nginx preserves API semantics, both websocket paths and desktop/static policy; RW reuses canonical graph', async () => {
  const nginx=await fs.readFile(path.join(ROOT,'deploy/local/nginx.conf'),'utf8');
  for(const value of ['socket\\.io','daemon','proxy_set_header Upgrade','try_files $uri =404','desktop-manifest.json','Content-Security-Policy']) assert.ok(nginx.includes(value),value);
  const artifacts=Object.fromEntries(await Promise.all(RISINGWAVE_BOOTSTRAP_ARTIFACTS.map(async a=>[a.file,await fs.readFile(path.join(ROOT,a.file),'utf8')])));
  assert.equal(buildRisingWaveBootstrapStatements(artifacts).length,49);
  assert.equal(RISINGWAVE_REQUIRED_RELATIONS.length,37);
  const compose=await fs.readFile(path.join(ROOT,'deploy/local/compose.yaml'),'utf8');
  assert.ok(compose.includes('--store-directory'));assert.ok(compose.includes('NODE_ENV: production'));assert.ok(compose.includes('127.0.0.1:'));
});
test('Computer resumes only previously managed servers, and refuses failed stop', async t => {
  const d=await dir(t), executable=d+'/computer';
  await fs.writeFile(executable,`#!${process.execPath}\nimport fs from 'node:fs';const p=process.env.RAFT_HOME+'/state';let s=JSON.parse(fs.readFileSync(p));const a=process.argv.slice(2);s.calls.push(a);if(a[0]==='stop'&&!s.fail)s.running=false;if(a[0]==='start')s.running=true;fs.writeFileSync(p,JSON.stringify(s));if(a[0]==='status')console.log(JSON.stringify({service:{running:s.running},attestation:{managedServerIds:['server-one']},servers:[{serverId:'server-one',serverSlug:'one-slug',daemon:{running:s.running}}]}));`,{mode:0o700});
  await fs.writeFile(d+'/state',JSON.stringify({running:true,calls:[]}));
  const ctx={state:d,config:{port:8080,computer:{enabled:true,executable,home:d}}};
  const stopped=await stopComputer(ctx);await resumeComputer(ctx,stopped);
  assert.deepEqual((await json(d+'/state')).calls,[['status','--json'],['stop'],['status','--json'],['start','one-slug']]);
  await fs.writeFile(d+'/state',JSON.stringify({running:true,fail:true,calls:[]}));
  await assert.rejects(stopComputer(ctx),/did not stop/);
});
test('private repository gate precedes mutations; draft publishes only after asset validation', async t => {
  const d=await dir(t), executable=d+'/gh';
  await fs.writeFile(executable,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2),p=process.env.FIXTURE_STATE;let s=JSON.parse(fs.readFileSync(p));s.calls.push(a);if(a[0]==='repo')console.log(JSON.stringify({nameWithOwner:'owner/backups',isPrivate:process.env.PRIVATE==='1'}));if(a[1]==='upload')s.assets.push({name:path.basename(a[3]),size:fs.statSync(a[3]).size});if(a[0]==='release'&&a[1]==='view')console.log(JSON.stringify({isDraft:true,assets:s.assets}));fs.writeFileSync(p,JSON.stringify(s));`,{mode:0o700});
  await fs.writeFile(d+'/data','fixture');await keygen(d+'/key');await encrypt(d+'/data',d+'/enc',d+'/key');await split(d+'/enc',d+'/bundle');
  const code=`import {publish} from './scripts/local/github.mjs';await publish(${JSON.stringify(d+'/bundle')},'owner/backups');`;
  const env={RAFT_GH:executable,FIXTURE_STATE:d+'/state'};
  await fs.writeFile(d+'/state',JSON.stringify({calls:[],assets:[]}));
  await assert.rejects(run(process.execPath,['--input-type=module','-e',code],{env:{...env,PRIVATE:'0'}}));
  assert.equal((await json(d+'/state')).calls.length,1);
  await fs.writeFile(d+'/state',JSON.stringify({calls:[],assets:[]}));
  await run(process.execPath,['--input-type=module','-e',code],{env:{...env,PRIVATE:'1'}});
  const calls=(await json(d+'/state')).calls;
  assert.equal(calls[1][1],'create');assert.ok(calls[1].includes('--draft'));
  assert.equal(calls.at(-1)[1],'edit');assert.ok(calls.at(-1).includes('--draft=false'));
});
test('launchd output uses exact argv, escaped paths and daily interval; no shell execution', () => {
  const content=plist(['/node path','/script','run','/state & <x>'],{PATH:'/bin'},'/state');
  assert.ok(content.includes('&amp; &lt;x&gt;'));assert.ok(content.includes('<integer>86400</integer>'));
  assert.ok(!content.includes('/bin/sh'));assert.ok(!content.includes('<key>RunAtLoad</key>'));
});
