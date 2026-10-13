import {load,compose} from './common.mjs';
import {projectName} from './local.mjs';
// restore writes its owned config before starting any recovery containers.
export async function cleanupRecovery(state,recovered,{lookup=load,stop=ctx=>compose(ctx,['down','--volumes','--remove-orphans'])}={}) {
 let ctx=recovered;
 if(!ctx) {
  try{ctx=await lookup(state);}catch(error){if(error.code==='ENOENT')return;throw error;}
 }
 if(ctx.config.project!==projectName(state))throw new Error('Refusing to stop a different recovery project');
 await stop(ctx);
}
