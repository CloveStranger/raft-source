import {ROOT,compose} from './common.mjs';
// Execute the real worker verifier read-only; tokens stay in stdin/memory.
export async function verifyWorkerScope(ctx,token) {
  const result=await compose(ctx,['run','--rm','--no-deps','--volume',`${ROOT}/packages/trace-upload-worker/src/shared:/worker:ro`,'api','node','--import','@oxc-node/core/register','--input-type=module','-e',`import {readFileSync} from 'node:fs';import {verifyScopeAttestation} from '/worker/auth.ts';const claims=await verifyScopeAttestation(readFileSync(0,'utf8'),{SCOPE_ATTESTATION_SECRET:process.env.SCOPE_ATTESTATION_SECRET});console.log(JSON.stringify({valid:true,scope:claims.scope,serverId:claims.serverId}));`],{input:token});
  return JSON.parse(result);
}
