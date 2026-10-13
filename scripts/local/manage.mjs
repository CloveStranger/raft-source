#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ROOT, load, compose, json } from './common.mjs';
import { startApp } from './local.mjs';
import { stopComputer, resumeComputer, computerStatus } from './computer.mjs';
import { main as scheduledBackup } from './schedule.mjs';

export const HELP = `用法：./raft-local [start|restart|stop|status|logs|connect 工作区slug|backup|help] [--state 数据目录]
无参数默认 start，数据目录默认 ~/raft-local，也可设置 RAFT_LOCAL_STATE。
connect 显式连接本地实例；backup 使用 ~/raft-backup.key、~/raft-snapshots，支持 --key、--snapshots。
需先运行 Docker Desktop；首次部署参见 deploy/local/README.md。`;
export function computerEnv(ctx) {
  return { RAFT_HOME: ctx.config.computer.home, SLOCK_HOME: ctx.config.computer.home,
    RAFT_SERVER_URL: `http://localhost:${ctx.config.port}`, SLOCK_SERVER_URL: `http://localhost:${ctx.config.port}` };
}
export function interactive(executable, args, env) {
  return new Promise((resolve,reject) => {
    const child=spawn(executable,args,{cwd:ROOT,env:{...process.env,...env},stdio:'inherit'});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(new Error(`Computer 连接失败 (${code})`)));
  });
}
const defaults={startApp,stopComputer,resumeComputer,computerStatus,compose,interactive,scheduledBackup};
export async function operate(command,ctx,{slug,key,snapshots}={},deps=defaults) {
  const resumeFile=path.join(ctx.state,'computer-resume.json');
  async function stop() {
    console.log('正在停止 Computer 和本地服务…');
    const state=await deps.stopComputer(ctx,{strict:true});
    // Repeated stop must keep the original run set for the next explicit start.
    if(state.running) {
      const temp=resumeFile+'.'+randomUUID();
      try {await fs.writeFile(temp,JSON.stringify({version:1,...state})+'\n',{mode:0o600,flag:'wx'});await fs.rename(temp,resumeFile);}
      finally {await fs.rm(temp,{force:true});}
    }
    await deps.compose(ctx,['stop']);
    return state;
  }
  async function start(current) {
    console.log('正在启动数据库、RisingWave 和网页服务…');
    await deps.startApp(ctx);
    if(ctx.config.computer.enabled) {
      let state=current;
      if(!state) {
        try {state=await json(resumeFile);if(state.version!==1)throw new Error('Unsupported Computer resume record');}
        catch(e) {if(e.code!=='ENOENT')throw e;}
      }
      if(state?.running) {await deps.resumeComputer(ctx,{running:state.running,servers:state.servers},{strict:true});await fs.rm(resumeFile,{force:true});}
    }
    console.log(`Raft 已就绪：http://localhost:${ctx.config.port}`);
  }
  if(['start','restart','stop','connect'].includes(command)) {
    const lock=path.join(ctx.state,'.backup-lock');
    await fs.mkdir(lock,{mode:0o700});
    try {
      if(command==='start') await start();
      else if(command==='stop') await stop();
      else if(command==='restart') {const current=await stop();await start(current);}
      else {
        if(!ctx.config.computer.enabled) throw new Error('请先复核 Computer 配置并将 enabled 设为 true');
        if(!path.isAbsolute(ctx.config.computer.executable||'')) throw new Error('请配置 Computer 的绝对 executable 路径');
        await deps.startApp(ctx);
        await deps.interactive(ctx.config.computer.executable,['setup',slug,'--server-url',`http://localhost:${ctx.config.port}`],computerEnv(ctx));
        await fs.rm(resumeFile,{force:true});
      }
    } finally {await fs.rmdir(lock);}
  } else if(command==='status') {
    console.log(await deps.compose(ctx,['ps']));
    if(ctx.config.computer.enabled) {
      const status=await deps.computerStatus(ctx);
      console.log(`Computer：${status.loggedIn?'已登录':'未登录'}，${status.service.running?'运行中':'停止'}；工作区：${status.servers.map(s=>s.serverSlug).join(', ')||'无'}`);
    } else console.log('Computer：已禁用');
    console.log(`数据：${ctx.state}\n网页：http://localhost:${ctx.config.port}\n备份库：${ctx.config.backupRepo||'未配置'}`);
  } else if(command==='logs') console.log(await deps.compose(ctx,['logs','--tail','100','--no-color','api']));
  else if(command==='backup') await deps.scheduledBackup(['run',ctx.state,key,snapshots]);
  else throw new Error(HELP);
}
export function options(args) {
  const {values,positionals}=parseArgs({args,allowPositionals:true,options:{state:{type:'string'},key:{type:'string'},snapshots:{type:'string'}}});
  const command=positionals[0]||'start';
  if(command==='help')return {command};
  if(!['start','restart','stop','status','logs','connect','backup'].includes(command) || positionals.length>(command==='connect'?2:1)) throw new Error(HELP);
  const slug=positionals[1];
  if(command==='connect' && !/^\/?[a-z0-9][a-z0-9-]*$/.test(slug||'')) throw new Error('connect 需要工作区 slug，例如 ./raft-local connect /clove-stranger');
  const state=values.state||process.env.RAFT_LOCAL_STATE||path.join(homedir(),'raft-local');
  return {command,state,slug,key:values.key||process.env.RAFT_LOCAL_BACKUP_KEY||path.join(homedir(),'raft-backup.key'),snapshots:values.snapshots||process.env.RAFT_LOCAL_SNAPSHOTS||path.join(homedir(),'raft-snapshots')};
}
export async function main(args) {
  const selected=options(args);
  if(selected.command==='help') {console.log(HELP);return;}
  await operate(selected.command,await load(selected.state),selected);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(e=>{
  console.error(e.code==='EEXIST'?'备份或服务操作正在运行；请等待完成。':e.message);process.exitCode=1;
});
