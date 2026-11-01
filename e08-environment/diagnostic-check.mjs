import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const value=process.env.STEWARD_COPILOT_TOKEN;
if(!value||!process.env.STEWARD_APP_PRIVATE_KEY||!process.env.E08_RELEASE_ONLY)throw Error('FIXTURE_SECRET_REQUIRED');
const worker=fileURLToPath(new URL('./environment-worker.mjs',import.meta.url));
const secretValues=[value,process.env.STEWARD_APP_PRIVATE_KEY,process.env.E08_RELEASE_ONLY];
const results=[];
for(const [mode,environment] of [['build',{...process.env}],['observe',{...process.env}],['release',{...process.env,E08_NOTES_ONLY:value,E08_EXPECTED_REVISION:'1',E08_ACCEPTED_REVISIONS:'[1,2]'}]]){
 const result=spawnSync(process.execPath,[worker,mode],{env:environment,encoding:'utf8'});
 if(result.error||result.status===0||!result.stderr.includes('UNEXPECTED_'))throw Error('LEAK_DIAGNOSTIC_NOT_REACHED');
 for(const secret of secretValues)if((result.stdout+result.stderr).includes(secret))throw Error('SECRET_IN_DIAGNOSTIC');
 results.push({mode,rejected:true,secretFreeDiagnostic:true});
}
const sdk=spawnSync(process.execPath,[fileURLToPath(new URL('./synthetic-sdk.mjs',import.meta.url)),'preflight'],{env:process.env,encoding:'utf8'});
if(sdk.error||sdk.status===0||!sdk.stderr.includes('CHILD_ENVIRONMENT_LEAK'))throw Error('CHILD_LEAK_DIAGNOSTIC_NOT_REACHED');
for(const secret of secretValues)if((sdk.stdout+sdk.stderr).includes(secret))throw Error('SECRET_IN_CHILD_DIAGNOSTIC');
results.push({mode:'sdk',rejected:true,secretFreeDiagnostic:true});
const proof={schemaVersion:1,mode:'diagnostic',runId:Number(process.env.GITHUB_RUN_ID),attempt:Number(process.env.GITHUB_RUN_ATTEMPT),ref:process.env.GITHUB_REF,head:process.env.GITHUB_SHA,status:'PASS',results};
await mkdir('e08-results',{recursive:true});await writeFile('e08-results/diagnostic.json',JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
