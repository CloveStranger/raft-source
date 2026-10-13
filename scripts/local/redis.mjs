import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {compose,waitFor} from './common.mjs';

export const REDIS_IMAGE='redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
export const LOCAL_REDIS_URL='redis://redis:6379';
// Parse the two managed keys without exposing their values in errors.
export function serviceConfig(text) {
  text=text.replace(/^\uFEFF/,''); // Compose accepts a UTF-8 BOM at file start.
  const result={};
  for(const key of ['REDIS_URL','SCOPE_ATTESTATION_SECRET']) {
    const rows=[...text.matchAll(new RegExp(String.raw`^[^\S\r\n]*(?:export[^\S\r\n]+)?${key}[^\S\r\n]*[=:][^\S\r\n]*(.*)$`,'gm'))];
    const values=rows.map(row=>{
      const raw=row[1].trim();
      if(!raw)return '';
      if(raw.startsWith("'")||raw.startsWith('"')) {
        const quote=raw[0],end=raw.indexOf(quote,1);
        if(end<0||!/^\s*(?:#.*)?$/.test(raw.slice(end+1)))throw new Error(`Ambiguous ${key} assignment`);
        const value=raw.slice(1,end);
        if(value.includes('\\')||(quote==='"'&&value.includes('$')))throw new Error(`Ambiguous ${key} assignment`);
        return value;
      }
      if(raw.includes('$')||raw.includes('\\'))throw new Error(`Ambiguous ${key} assignment`);
      return raw.replace(/\s+#.*$/,'').trim();
    });
    if(new Set(values).size>1)throw new Error(`Conflicting ${key} assignments`);
    result[key]=values[0]||'';
  }
  if(result.REDIS_URL&&result.REDIS_URL!==LOCAL_REDIS_URL)throw new Error('Local deployment requires its managed Redis URL');
  return result;
}
export async function ensureServiceConfig(ctx) {
  const file=path.join(ctx.state,'server.env');
  const original=await fs.readFile(file,'utf8'),current=serviceConfig(original);
  let next=original;
  for(const key of ['REDIS_URL','SCOPE_ATTESTATION_SECRET']) {
    if(current[key])continue; // Existing signing keys never rotate on restart/recovery.
    const value=key==='REDIS_URL'?LOCAL_REDIS_URL:randomBytes(32).toString('base64');
    const pattern=new RegExp(String.raw`^[^\S\r\n]*(?:export[^\S\r\n]+)?${key}[^\S\r\n]*[=:].*$`,'gm');
    const bom=next.startsWith('\uFEFF')?'\uFEFF':'',body=next.slice(bom.length);
    if(pattern.test(body))next=bom+body.replace(pattern,`${key}=${value}`);
    else next+=(next.endsWith('\n')?'':'\n')+`${key}=${value}\n`;
  }
  if(next!==original) {
    const temp=file+'.'+randomUUID();
    try {await fs.writeFile(temp,next,{mode:0o600,flag:'wx'});await fs.rename(temp,file);}
    finally {await fs.rm(temp,{force:true});}
  }
}
export const redis = (ctx,args,options) => compose(ctx,['exec','-T','redis','redis-cli','--raw',...args],options);
export async function waitRedis(ctx) {
  await waitFor(async()=>{if((await redis(ctx,['PING'])).trim()!=='PONG')throw new Error('Redis pending');},'Redis');
}
export async function startRedis(ctx) {
  await compose(ctx,['up','-d','redis']);await waitRedis(ctx);
}
export async function saveRedis(ctx) {
  if((await redis(ctx,['SAVE'])).trim()!=='OK')throw new Error('Redis snapshot failed');
}
export async function copyRedisData(ctx,destination) {
  await fs.mkdir(destination,{mode:0o700});
  await compose(ctx,['cp','redis:/data/dump.rdb',path.join(destination,'dump.rdb')]);
  await fs.access(path.join(destination,'dump.rdb'));
}
