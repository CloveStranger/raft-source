import test from 'node:test';
import assert from 'node:assert/strict';
import {monitorWindow} from './online.mjs';
function fixture(change=()=>{}) {
 let time=0,index=0;
 const first={servicePid:10,daemonPid:11,connectedAt:100,replica:'a',generation:'b',heartbeat:1000,updatedAt:1000};
 return {first,sample:async()=>{index++;const row={...first,heartbeat:1000+Math.floor(time/30000)*30000,updatedAt:1000+Math.floor(time/30000)*30000};change(row,index,()=>{time+=25000;});return row;},clock:{now:()=>time,sleep:async ms=>{time+=ms;}}};
}
test('continuous observation requires advancing persisted heartbeat and Redis proof',async()=>{
 const f=fixture(),result=await monitorWindow(f.sample,f.first,120,f.clock);
 assert.equal(result.samples,13);assert.equal(result.heartbeatAdvances,4);assert.equal(result.leaseRefreshes,4);
});
test('one disconnected sample fails without resetting the window',async()=>{
 const f=fixture((r,i)=>{if(i===4)throw new Error('Computer disconnected');});
 await assert.rejects(monitorWindow(f.sample,f.first,120,f.clock),/disconnected/);
});
test('a same-process reconnect is detected through connection marker and owner generation',async()=>{
 for(const key of ['connectedAt','generation','daemonPid']) {
  const f=fixture((r,i)=>{if(i===3)r[key]='changed';});
  await assert.rejects(monitorWindow(f.sample,f.first,120,f.clock),new RegExp(key));
 }
});
test('connected but stalled heartbeat or Redis lease does not pass',async()=>{
 for(const key of ['heartbeat','updatedAt']) {
  const f=fixture(r=>{r[key]=1000;});
  await assert.rejects(monitorWindow(f.sample,f.first,120,f.clock),/did not advance/);
 }
});
test('collection over deadline fails instead of turning a gap into an online sample',async()=>{
 const f=fixture((r,i,delay)=>delay());
 await assert.rejects(monitorWindow(f.sample,f.first,120,f.clock),/deadline/);
});
