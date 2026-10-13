import { promises as fs } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { compose, waitFor } from './common.mjs';
import { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } from '../../packages/shared/src/legalAcceptance.ts';
export async function api(ctx, route, {token,server,body,method='GET'}={}) {
  const headers={...(token?{Authorization:`Bearer ${token}`} : {}),...(server?{'X-Server-Id':server}:{})};
  if(body && !(body instanceof FormData)) headers['Content-Type']='application/json';
  const r=await fetch(`http://localhost:${ctx.config.port}${route}`,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const text=await r.text();
  if(!r.ok) throw new Error(`${method} ${route}: ${r.status}: ${text.slice(0,250)}`);
  return JSON.parse(text);
}
export async function account(ctx) {
  const suffix=randomUUID().slice(0,8), email=`fixture-${suffix}@example.test`, password='Fixture-only-12345!';
  const login=await api(ctx,'/api/auth/register',{method:'POST',body:{email,password,acceptTerms:true,termsVersion:CURRENT_TERMS_VERSION,privacyVersion:CURRENT_PRIVACY_VERSION}});
  const verify=await waitFor(async()=>{
    const logs=await compose(ctx,['logs','--no-color','api']);
    const tokens=[...logs.matchAll(/\?verify=([^"<\s&]+)/g)];
    if(!tokens.length) throw new Error('Email pending');return tokens.at(-1)[1];
  },'fixture verification email',30);
  await api(ctx,'/api/auth/verify-email',{method:'POST',body:{token:verify}});
  await api(ctx,'/api/auth/me/complete-profile',{token:login.accessToken,method:'POST',body:{name:`user${suffix}`,displayName:'Backup fixture'}});
  const server=await api(ctx,'/api/servers',{token:login.accessToken,method:'POST',body:{name:'Backup fixture',slug:`backup-${suffix}`}});
  return {...login,email,password,server};
}
export async function createContent(ctx, user) {
  const opts={token:user.accessToken,server:user.server.id,method:'POST'};
  const channel=await api(ctx,'/api/channels',{...opts,body:{name:'backup-test',visibility:'public'}});
  const chunk=(type,data)=>{const t=Buffer.from(type),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('IEND',Buffer.alloc(0))]);
  const avatar=new FormData();avatar.append('avatar',new Blob([png],{type:'image/png'}),'avatar.png');
  const profile=await api(ctx,'/api/auth/me/avatar',{...opts,body:avatar});
  const upload=new FormData();upload.append('channelId',channel.id);upload.append('files',new Blob(['attachment fixture bytes'],{type:'text/plain'}),'notes.txt');
  const uploaded=await api(ctx,'/api/attachments/upload',{...opts,body:upload});
  const attachment=(Array.isArray(uploaded)?uploaded:uploaded.attachments)[0];
  const message=await api(ctx,'/api/messages',{...opts,body:{channelId:channel.id,content:'聊天与附件恢复样本',attachmentIds:[attachment.id],randomId:randomUUID()}});
  const agent=await api(ctx,'/api/agents',{...opts,body:{name:'backup-agent',external:true,description:'Restore fixture',avatarUrl:'pixel:random:42'}});
  const agentAvatar=new FormData();agentAvatar.append('avatar',new Blob([png],{type:'image/png'}),'agent.png');
  await api(ctx,`/api/agents/${agent.id}/avatar`,{...opts,body:agentAvatar});
  return {channel,profile,attachment,message,agent};
}
export async function seedComputer(ctx,user,executable) {
  await fs.mkdir(ctx.config.computer.home+'/computer',{recursive:true});
  await fs.writeFile(ctx.config.computer.home+'/computer/user-session.json',JSON.stringify({kind:'user-session',schemaVersion:1,
    userId:user.user.id,accessToken:user.accessToken,refreshToken:user.refreshToken,email:user.email,serverUrl:`http://localhost:${ctx.config.port}`}),{mode:0o600});
  ctx.config.computer={...ctx.config.computer,enabled:true,executable};
  await fs.writeFile(ctx.state+'/config.json',JSON.stringify(ctx.config),{mode:0o600});
}
