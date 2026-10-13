import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupRecovery} from './recovery-cleanup.mjs';
import {projectName} from './local.mjs';
test('a restore that failed before returning still shuts down the exact owned recovery project',async()=>{
 const state='/fixture/recovery',ctx={state,config:{project:projectName(state)}},calls=[];
 await cleanupRecovery(state,undefined,{lookup:async p=>{assert.equal(p,state);calls.push('lookup');return ctx;},stop:async c=>{assert.equal(c,ctx);calls.push('down');}});
 assert.deepEqual(calls,['lookup','down']);
});
test('pre-creation failure has no project; foreign project or failed cleanup cannot be treated as success',async()=>{
 let stopped=false;
 await cleanupRecovery('/fixture/recovery',undefined,{lookup:async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});},stop:async()=>{stopped=true;}});
 assert.equal(stopped,false);
 await assert.rejects(cleanupRecovery('/fixture/recovery',{config:{project:projectName('/fixture/original')}},{stop:async()=>{stopped=true;}}),/different recovery/);
 assert.equal(stopped,false);
 await assert.rejects(cleanupRecovery('/fixture/recovery',{config:{project:projectName('/fixture/recovery')}},{stop:async()=>{throw new Error('cleanup failed');}}),/cleanup failed/);
});
