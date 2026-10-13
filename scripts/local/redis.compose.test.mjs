import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {init} from './local.mjs';
import {ensureServiceConfig} from './redis.mjs';
import {compose,hash} from './common.mjs';
test('actual Compose colon/whitespace/quoted assignments preserve the effective signing key',async t=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),'raft-compose-env-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));
 const ctx=await init(d+'/state'),file=ctx.state+'/server.env';
 const base=(await fs.readFile(file,'utf8')).replace(/^REDIS_URL=.*\n|^SCOPE_ATTESTATION_SECRET=.*\n/gm,'');
 for(const variant of [
  'SCOPE_ATTESTATION_SECRET: fixture-key\nREDIS_URL: redis://redis:6379\n',
  '\uFEFFSCOPE_ATTESTATION_SECRET=fixture-key\nREDIS_URL=redis://redis:6379\n',
  '\u00a0SCOPE_ATTESTATION_SECRET = fixture-key\nREDIS_URL = redis://redis:6379\n',
  '  SCOPE_ATTESTATION_SECRET = fixture-key # keep\n REDIS_URL = redis://redis:6379\n',
  'SCOPE_ATTESTATION_SECRET: "fixture-key"\nREDIS_URL: "redis://redis:6379"\n',
  'SCOPE_ATTESTATION_SECRET=fixture-key\nSCOPE_ATTESTATION_SECRET: fixture-key\nREDIS_URL=redis://redis:6379\n',
 ]) {
  await fs.writeFile(file,variant+base);const original=await hash(file);
  await ensureServiceConfig(ctx);assert.equal(await hash(file),original);
  const result=JSON.parse(await compose(ctx,['config','--format','json']));
  assert.equal(result.services.api.environment.SCOPE_ATTESTATION_SECRET,'fixture-key');
  assert.equal(result.services.api.environment.REDIS_URL,'redis://redis:6379');
 }
});
