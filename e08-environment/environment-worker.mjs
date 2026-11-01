import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {copilotReleaseClient,copilotQualityClient} from './runner.js';

const mode=process.argv[2];
const secretNames=['STEWARD_COPILOT_TOKEN','STEWARD_APP_PRIVATE_KEY','E08_RELEASE_ONLY','E08_NOTES_ONLY'];
const result={schemaVersion:1,scope:'synthetic Environment and production subprocess routing',mode,runId:Number(process.env.GITHUB_RUN_ID),attempt:Number(process.env.GITHUB_RUN_ATTEMPT),ref:process.env.GITHUB_REF,head:process.env.GITHUB_SHA};
if(mode==='build'||mode==='observe'){
  for(const key of secretNames)assert.equal(process.env[key]??'','',`UNEXPECTED_${key}`);
  result.status='ISOLATED';
}else{
  assert.ok(['release','quality','missing'].includes(mode));
  const expected=Number(process.env.E08_EXPECTED_REVISION);
  const accepted=JSON.parse(process.env.E08_ACCEPTED_REVISIONS);
  assert.ok([0,1,2].includes(expected)&&Array.isArray(accepted)&&accepted.length>0&&accepted.every(x=>[1,2].includes(x)));
  if(mode!=='missing'){
    assert.ok(process.env.STEWARD_APP_PRIVATE_KEY);
    assert.ok(process.env[mode==='release'?'E08_RELEASE_ONLY':'E08_NOTES_ONLY']);
    assert.equal(process.env[mode==='release'?'E08_NOTES_ONLY':'E08_RELEASE_ONLY']??'','');
  }
  const sandbox=resolve('e08-environment/model-'+mode);
  await mkdir(sandbox+'/tools/quality-language',{recursive:true});
  await writeFile(sandbox+'/provider.json',JSON.stringify({accepted}));
  const sdk=await readFile(new URL('./synthetic-sdk.mjs',import.meta.url));
  for(const file of ['run.mjs','release-notes.mjs'])await writeFile(sandbox+'/tools/quality-language/'+file,sdk);
  const client=(mode==='quality'?copilotQualityClient:copilotReleaseClient)(sandbox,process.env.STEWARD_COPILOT_TOKEN??'');
  let status;
  try{const response=await client.preflight();status=typeof response==='string'?response:response.status;}
  catch(error){if(error.message!=='WAIT_AUTH')throw Error('PREFLIGHT_UNKNOWN');status='WAIT_AUTH';}
  assert.equal(status,expected===0?'WAIT_AUTH':'READY');
  let observed=null;
  try{observed=JSON.parse(await readFile(sandbox+'/observed.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(mode==='missing')assert.equal(observed,null);
  else{assert.equal(observed.status,status);if(expected!==0)assert.equal(observed.revision,expected);assert.equal(observed.isolation,true);}
  Object.assign(result,{status,revision:observed?.revision??null,childStarted:observed!==null,childIsolation:observed?.isolation??null});
}
await mkdir('e08-results',{recursive:true});
await writeFile(`e08-results/${mode}.json`,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
