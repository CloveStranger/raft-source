import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init,startApp } from './local.mjs';
import { load,compose,sql,hash,waitFor } from './common.mjs';
import { rwsql } from './risingwave.mjs';
import { backup,restore } from './backup.mjs';
import { keygen } from './archive.mjs';
import { account,createContent,api } from './app-fixture.mjs';

test('complete application restores uploads, chat, Agent config, auth keys and rebuilt RW graph', {timeout:600000},async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'raft-app-test-'));
  let original,restored;
  try {
    original=process.env.RAFT_APP_TEST_STATE?await load(process.env.RAFT_APP_TEST_STATE):await init(d+'/original',18085);
    await startApp(original);
    const user=await account(original), content=await createContent(original,user);
    original.config.coverageReviewed=true;
    await fs.writeFile(original.state+'/config.json',JSON.stringify(original.config));
    // Independent expectations are captured from the live fixture before backup.
    const uploadFiles=[];
    for(const file of await fs.readdir(original.state+'/uploads',{recursive:true})) {
      if((await fs.stat(original.state+'/uploads/'+file)).isFile()) uploadFiles.push({file,hash:await hash(original.state+'/uploads/'+file)});
    }
    assert.ok(uploadFiles.length>=3,'user avatar, Agent avatar and attachment must exist before backup');
    const attachmentRow=await sql(original,`SELECT row_to_json(a)::text FROM attachments a WHERE id='${content.attachment.id}';`);
    assert.equal(JSON.parse(attachmentRow).message_id,content.message.id);
    const userAvatar=await sql(original,`SELECT avatar_url FROM users WHERE id='${user.user.id}';`);
    assert.ok(userAvatar.trim());
    const origin=`http://localhost:${original.config.port}`;
    const page=await fetch(origin+'/some/deep/link');assert.equal(page.status,200);assert.match(await page.text(),/<html/);
    const unknown=await fetch(origin+'/api/does-not-exist');assert.equal(unknown.status,404);assert.equal((await unknown.json()).code,'not_found');
    const socket=await fetch(origin+'/socket.io/?EIO=4&transport=polling');assert.equal(socket.status,200);assert.match(await socket.text(),/^0\{/);
    await waitFor(async()=>assert.equal((await rwsql(original,`SELECT count(*) FROM rw_messages WHERE id='${content.message.id}';`)).trim(),'1'),'CDC fixture');
    await new Promise((resolve,reject)=>{const ws=new WebSocket(origin.replace('http:','ws:')+'/socket.io/?EIO=4&transport=websocket');const timer=setTimeout(()=>{ws.close();reject(new Error('Socket.io upgrade timeout'));},10000);ws.onmessage=e=>{clearTimeout(timer);ws.close();try{assert.match(String(e.data),/^0\{/);resolve();}catch(error){reject(error);}};ws.onerror=()=>{clearTimeout(timer);reject(new Error('Socket.io upgrade failed'));};});
    const agentConfig=await sql(original,`SELECT json_build_object('avatar',avatar_url,'runtime',runtime_config,'env',env_vars,'model',model)::text FROM agents WHERE id='${content.agent.id}';`);
    const counts=await rwsql(original,'SELECT count(*) FROM rw_inbox_serving_v8;');
    const credential=await compose(original,['exec','-T','api','node','--import','@oxc-node/core/register','--input-type=module','-e',"import {encryptManagedMcpSecret} from './packages/server/src/services/managedMcpCredentialService.ts';console.log(encryptManagedMcpSecret({token:'fixture-only'}));"]);
    await keygen(d+'/key');await backup(original.state,d+'/key',d+'/snapshot');
    await compose(original,['stop']);
    restored=await restore(d+'/snapshot',d+'/key',d+'/restored');
    assert.equal((await sql(restored,`SELECT content FROM messages WHERE id='${content.message.id}';`)).trim(),'聊天与附件恢复样本');
    assert.equal((await sql(restored,`SELECT description FROM agents WHERE id='${content.agent.id}';`)).trim(),'Restore fixture');
    assert.equal(await sql(restored,`SELECT json_build_object('avatar',avatar_url,'runtime',runtime_config,'env',env_vars,'model',model)::text FROM agents WHERE id='${content.agent.id}';`),agentConfig);
    assert.equal(await rwsql(restored,'SELECT count(*) FROM rw_inbox_serving_v8;'),counts);
    const login=await api(restored,'/api/auth/login',{method:'POST',body:{email:user.email,password:user.password}});assert.ok(login.accessToken);
    assert.equal(await sql(restored,`SELECT row_to_json(a)::text FROM attachments a WHERE id='${content.attachment.id}';`),attachmentRow);
    assert.equal(await sql(restored,`SELECT avatar_url FROM users WHERE id='${user.user.id}';`),userAvatar);
    for(const f of uploadFiles) assert.equal(await hash(restored.state+'/uploads/'+f.file),f.hash);
    const decrypted=await compose(restored,['exec','-T','api','node','--import','@oxc-node/core/register','--input-type=module','-e',`import {decryptManagedMcpSecret} from './packages/server/src/services/managedMcpCredentialService.ts';console.log(JSON.stringify(decryptManagedMcpSecret(${JSON.stringify(credential.trim())})));`]);
    assert.deepEqual(JSON.parse(decrypted),{token:'fixture-only'});
    await compose(restored,['restart','risingwave']);await startApp(restored);
    assert.equal((await rwsql(restored,`SELECT count(*) FROM rw_messages WHERE id='${content.message.id}';`)).trim(),'1');
  } finally {
    for(const ctx of [restored,original]) if(ctx) await compose(ctx,['down','--volumes','--remove-orphans']);
    await fs.rm(d,{recursive:true,force:true});
  }
});
