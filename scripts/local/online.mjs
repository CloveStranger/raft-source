import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {load,waitFor,compose} from './common.mjs';
import {computerStatus} from './computer.mjs';
import {redis} from './redis.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// No retry/reset inside this window: a transient disconnect must fail acceptance.
export async function monitorWindow(sample,initial,seconds,{now=()=>performance.now(),sleep=pause}={}) {
  assert.ok(Number.isInteger(seconds)&&seconds>=120,'Observe at least 120 seconds');
  let last=initial,samples=1,heartbeats=0,leaseRefreshes=0;
  const begin=now(),end=begin+seconds*1000;
  while(now()<end) {
    await sleep(Math.min(10000,end-now()));
    const before=now();last=await sample();samples++;
    assert.ok(now()-before<20000,'Sample exceeded its collection deadline');
    for(const key of ['servicePid','daemonPid','connectedAt','replica','generation'])assert.equal(last[key],initial[key],`Connection changed: ${key}`);
    assert.ok(last.heartbeat>=initial.heartbeat,'Server heartbeat regressed');
    assert.ok(last.updatedAt>=initial.updatedAt,'Redis heartbeat regressed');
    if(last.heartbeat>initial.heartbeat){heartbeats++;initial={...initial,heartbeat:last.heartbeat};}
    if(last.updatedAt>initial.updatedAt){leaseRefreshes++;initial={...initial,updatedAt:last.updatedAt};}
  }
  assert.ok(heartbeats>=3,'Server heartbeat did not advance three times');
  assert.ok(leaseRefreshes>=3,'Redis lease did not advance three times');
  return {seconds,samples,continuousOnline:true,heartbeatAdvances:heartbeats,leaseRefreshes};
}
export async function observeOnline(ctx,slug,seconds=120) {
  async function sample() {
    const status=await computerStatus(ctx,{timeoutMs:10000});
    assert.equal(status.service.running,true,'Computer service stopped');
    const target=status.servers.find(s=>s.serverSlug===slug.replace(/^\//,''));
    assert.ok(target,'Workspace is not attached');assert.equal(target.serverConnected,true,'Computer disconnected');
    assert.equal(target.daemon.running,true,'Daemon stopped');
    const managed=[...status.attestation.managedServerIds].sort();
    assert.deepEqual(status.servers.filter(s=>s.daemon.running).map(s=>s.serverId).sort(),managed,'Unexpected Computer running set');
    assert.equal(status.service.version.version,'1.0.47');assert.equal(target.runnerVersion.version,'1.0.47');
    assert.ok(Number.isInteger(status.service.pid)&&Number.isInteger(target.daemon.pid));
    const marker=JSON.parse(await readFile(path.join(ctx.config.computer.home,'computer/servers',target.serverId,'runner.connected'),'utf8'));
    assert.equal(marker.pid,target.daemon.pid);assert.ok(marker.connectedAt>0);
    // User access tokens expire independently of a resident Machine connection.
    // Read the server's persisted pong proof and Redis owner directly; never
    // refresh/rotate the Computer login session just to observe liveness.
    const machineId=target.machineId||target.serverMachineId;
    assert.match(machineId,/^[a-f0-9-]{36}$/);assert.match(target.serverId,/^[a-f0-9-]{36}$/);
    const prefix=`slock:machine:${machineId}`;
    const lease=(await redis(ctx,['MGET',prefix+':replica',prefix+':replica_generation',prefix+':replica_updated_at'],{timeoutMs:5000})).trim().split('\n');
    assert.ok(lease[0]&&lease[1]);assert.ok(Number(lease[2])>0&&Date.now()-Number(lease[2])<=60000,'Missing/stale Redis heartbeat');
    assert.ok(Number(await redis(ctx,['PTTL',prefix+':replica'],{timeoutMs:5000}))>0,'Redis owner expired');
    const row=(await compose(ctx,['exec','-T','db','psql','-X','-U','postgres','-d','slock','-At','-c',`SELECT extract(epoch FROM last_heartbeat)*1000,computer_version FROM daemons WHERE id='${machineId}' AND server_id='${target.serverId}';`],{timeoutMs:5000})).trim().split('|');
    assert.equal(row[1],'1.0.47','Server Computer version/identity not confirmed');
    const heartbeat=Number(row[0]);
    // A fresh connection can be online before its first 30-second pong. Wait
    // for that first persisted proof, then begin the continuous window.
    assert.ok(heartbeat>0&&Date.now()-heartbeat<=60000,'Database heartbeat is missing/stale');
    return {servicePid:status.service.pid,daemonPid:target.daemon.pid,connectedAt:marker.connectedAt,replica:lease[0],generation:lease[1],updatedAt:Number(lease[2]),heartbeat};
  }
  const initial=await waitFor(sample,'Computer online with first persisted heartbeat',90);
  const result=await monitorWindow(sample,initial,seconds);
  console.log(JSON.stringify({workspace:slug,...result}));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [state,slug,seconds]=process.argv.slice(2);
  if(!state||!slug)throw new Error('Usage: online.mjs STATE SLUG [SECONDS>=120]');
  observeOnline(await load(state),slug,seconds?Number(seconds):120).catch(e=>{console.error(e.message);process.exitCode=1;});
}
