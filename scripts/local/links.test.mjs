import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pack,unpack} from './archive.mjs';
import {rebindLinks} from './backup.mjs';
import {run} from './common.mjs';
test('registered Agent skill links archive safely and use the recovered copy instead of the original path',async t=>{
 const d=await fs.mkdtemp(path.join(os.tmpdir(),'raft-link-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));
 await fs.mkdir(d+'/raft/agents/a/.agents/skills',{recursive:true});await fs.mkdir(d+'/skills/workflow',{recursive:true});
 await fs.writeFile(d+'/skills/workflow/SKILL.md','original skill bytes');
 await fs.symlink(d+'/skills/workflow',d+'/raft/agents/a/.agents/skills/workflow');
 await fs.writeFile(d+'/spec',JSON.stringify({roots:[{name:'raft',path:d+'/raft',computer:true},{name:'agent-skills',path:d+'/skills'}],metadata:{}}));
 await pack(d+'/spec',d+'/archive');await unpack(d+'/archive',d+'/verified');
 const manifest=JSON.parse(await fs.readFile(d+'/verified/manifest.json','utf8'));assert.equal(manifest.format,2);
 assert.equal(await fs.readFile(d+'/verified/raft/agents/a/.agents/skills/workflow/SKILL.md','utf8'),'original skill bytes');
 const dest=d+'/restored';await fs.mkdir(dest);await fs.cp(d+'/verified/raft',dest+'/raft',{recursive:true,verbatimSymlinks:true});
 await fs.cp(d+'/verified/agent-skills',dest+'/external/agent-skills',{recursive:true,verbatimSymlinks:true});
 const forged=structuredClone(manifest);forged.files.find(f=>f.targetRoot).targetPath='../../escape';
 await assert.rejects(rebindLinks(forged,dest,[{name:'agent-skills',path:dest+'/external/agent-skills'}]),/escapes/);
 await rebindLinks(manifest,dest,[{name:'agent-skills',path:dest+'/external/agent-skills'}]);
 await fs.writeFile(d+'/skills/workflow/SKILL.md','changed live original');
 const link=dest+'/raft/agents/a/.agents/skills/workflow';
 assert.equal(await fs.realpath(link),await fs.realpath(dest+'/external/agent-skills/workflow'));
 assert.equal(await fs.readFile(link+'/SKILL.md','utf8'),'original skill bytes');
 assert.equal(path.isAbsolute(await fs.readlink(link)),false);
 // Contradict only authenticated mapping metadata; tar links and file hashes
 // remain valid. The decoder must reject this before restore can use it.
 const code=`import tarfile,json,io,sys
with tarfile.open(sys.argv[1],'r:gz') as src,tarfile.open(sys.argv[2],'w:gz') as dst:
 for member in src.getmembers():
  data=src.extractfile(member).read() if member.isfile() else None
  if member.name=='manifest.json':
   obj=json.loads(data)
   entry=next(e for e in obj['files'] if 'targetRoot' in e)
   if len(sys.argv)>3:
    for key in ('targetRoot','targetPath','originalTarget'):del entry[key]
   else:entry['targetPath']='workflow/SKILL.md'
   data=json.dumps(obj).encode();member.size=len(data)
  dst.addfile(member,io.BytesIO(data) if data is not None else None)
`;
 await run(process.env.RAFT_PYTHON||'python3',['-c',code,d+'/archive',d+'/contradictory']);
 await assert.rejects(unpack(d+'/contradictory',d+'/bad-verified'),e=>/Registered link contradicts archive target/.test(e.details));
 await run(process.env.RAFT_PYTHON||'python3',['-c',code,d+'/archive',d+'/missing-map','missing']);
 await assert.rejects(unpack(d+'/missing-map',d+'/missing-verified'),e=>/Missing registered link mapping/.test(e.details));
 const missing=structuredClone(manifest);for(const e of missing.files.filter(e=>e.targetRoot))for(const key of ['targetRoot','targetPath','originalTarget'])delete e[key];
 await assert.rejects(rebindLinks(missing,dest,[{name:'agent-skills',path:dest+'/external/agent-skills'}]),/Missing registered link mapping/);
});
