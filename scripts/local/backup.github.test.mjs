import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keygen,pack,unpack,encrypt,decrypt,split,join } from './archive.mjs';
import { publish,download,privateRepo } from './github.mjs';
import { hash,writeJson } from './common.mjs';
test('authorized private GitHub release roundtrip restores synthetic data only', {timeout:180000},async()=>{
  const repo=process.env.RAFT_GITHUB_TEST_REPO;
  assert.ok(repo,'Set RAFT_GITHUB_TEST_REPO only after authorizing synthetic encrypted Release uploads to that private repository');
  await privateRepo(repo);
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'raft-github-test-'));
  try {
    await fs.mkdir(d+'/files');await fs.writeFile(d+'/files/avatar.webp',Buffer.from([1,0,255,3]));
    await fs.writeFile(d+'/files/chat.json',JSON.stringify({fixture:'synthetic only',text:'恢复验证'}));
    await writeJson(d+'/spec.json',{roots:[{name:'files',path:d+'/files'}],metadata:{testOnly:true}});
    await keygen(d+'/key');await pack(d+'/spec.json',d+'/tar');await encrypt(d+'/tar',d+'/enc',d+'/key');
    await split(d+'/enc',d+'/bundle',256);
    const tag=await publish(d+'/bundle',repo);console.log(`Synthetic encrypted test Release: ${repo} ${tag}`);
    await download(repo,tag,d+'/download');await join(d+'/download',d+'/joined');
    await decrypt(d+'/joined',d+'/verified',d+'/key');await unpack(d+'/verified',d+'/restored');
    for(const f of ['avatar.webp','chat.json']) assert.equal(await hash(d+'/files/'+f),await hash(d+'/restored/files/'+f));
  } finally { await fs.rm(d,{recursive:true,force:true}); }
});
