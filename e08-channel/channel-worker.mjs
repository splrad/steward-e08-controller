// E08 synthetic channel adapter. Native source, identity, reports and recovery contracts use the production implementation.
import * as native from '../controller-origin/e08-native-policy/native-api/index.mjs';
import {writeFile,appendFile} from 'node:fs/promises';
const inputs=JSON.parse(process.env.CHANNEL_INPUTS),stage=process.argv[2],io=native.nativeEvidenceTransport(process.env.GH_TOKEN);
if(inputs.mode==='submit')throw Error('E08_FIXTURE_SUPPORTS_OBSERVE_AND_VERIFY_ONLY');
const reader=new native.NativeEvidenceReader(io,process.env.GITHUB_REPOSITORY);
const head=(await reader.json('git/ref/heads/steward/release-state')).object.sha;
async function file(path){const b=await reader.json(`contents/${path}?ref=${head}`);return JSON.parse(Buffer.from(b.content,'base64').toString());}
const cycle=await file(`cycles/${inputs.cycle_id}.json`),state={head,repository:await file('state.json'),cycles:[{value:cycle}],domainRecords:[]};
// Only the initial admission needs historical records; the controller verifies and archives recovery before every repeat.
if(stage==='admit'){
 const tree=await reader.json(`git/trees/${head}?recursive=1`);if(tree.truncated)throw Error('INCOMPLETE_STATE');
 for(const entry of tree.tree.filter(e=>e.type==='blob'&&e.path.startsWith('evidence/'))){const value=await file(entry.path);if(value.cycleId===cycle.id)state.domainRecords.push({path:entry.path,commit:head,value});}
}
const selection=await native.pipelineChannelIdentity(inputs,state,process.env,undefined,io,stage==='admit'?'admit':'source');
if(!['SOURCE','ADMITTED','OBSERVE'].includes(selection.status)){
 if(selection.reason==='SOURCE_REF_MOVED')console.log('STEWARD_SOURCE_REJECTED '+JSON.stringify(selection));
 console.log(JSON.stringify(selection));process.exit(['UNKNOWN','NOT_BOUND'].includes(selection.status)?75:1);
}
const {context,targets,run}=selection,request=cycle.dispatches.find(r=>r.requestKey===inputs.request_key);
const matrixTarget=()=>{const selected=targets.filter(t=>t.unitId===process.env.UNIT_ID&&t.channelId===process.env.CHANNEL_ID);if(selected.length!==1)throw Error('MATRIX_TARGET_REQUIRED');return selected[0];};
const output=async values=>{for(const [k,v] of Object.entries(values))await appendFile(process.env.GITHUB_OUTPUT,`${k}=${typeof v==='object'?JSON.stringify(v):v}\n`);};
const envelope=items=>({schemaVersion:1,cycleId:cycle.id,sourceSha:cycle.sourceSha,executionSha:run.headSha,controllerSha:cycle.controllerSha,targetsDigest:selection.targetsDigest,nativeRunId:run.id,runAttempt:run.runAttempt,items});
async function reads(){
 // A real immutable Release and its original bytes back the synthetic channel object. A dedicated test variable represents indexing delay.
 await native.verifyContinuationReleases(context,io);
 const ready=process.env.E08_READY==='true';
 return targets.map(t=>({unitId:t.unitId,channelId:t.channelId,version:t.version,readStatus:ready?'OK':'PENDING',exists:true,digest:'sha256:'+t.manifestDigest,accepted:true,indexed:ready,observedAt:new Date().toISOString(),evidenceKind:'E08_SYNTHETIC_INDEX_DELAY_NATIVE_RELEASE_BYTES'}));
}
if(stage==='source'){
 await output({targets_digest:selection.targetsDigest,limit:[803,807].includes(cycle.prNumber)&&request?.continuationOfRunId===null,has_work:true});
 console.log(JSON.stringify({sourceSha:cycle.sourceSha,executionSha:run.headSha,controllerSha:cycle.controllerSha,defaultBranch:state.repository.defaultBranch}));
}else if(stage==='observe'){
 if(selection.status!=='OBSERVE')throw Error('OBSERVE_REQUIRED');
 await writeFile('report.json',JSON.stringify(envelope(await reads()))+'\n');await output({targets_digest:selection.targetsDigest});
}else if(stage==='prepare'){
 if(request?.canonicalRunId!==run.id)throw Error('CANONICAL_REQUIRED');
 const ready=native.channelReadyTargets(context,targets,inputs.mode,await reads(),new Date().toISOString());
 const jobs=(await reader.pages(`actions/runs/${run.id}/attempts/${run.runAttempt}/jobs`,'jobs')).map(native.jobFact),job=jobs.find(j=>j.name==='channel-prepare');
 for(const receipt of native.channelPreparationResults(context,request,run,job,ready.ready,new Date().toISOString()))console.log('STEWARD_RESULT '+JSON.stringify(receipt));
 await output({has_work:ready.ready.length>0,matrix:{include:ready.ready}});
}else if(stage==='business'){
 await native.verifyContinuationReleases(context,io);
 const target=matrixTarget();await writeFile('report.json',JSON.stringify(envelope([{...target,nativeObjectId:'release:'+target.releaseId,digest:target.manifestDigest,accepted:true,indexed:true,consumed:true,observedAt:new Date().toISOString()}]))+'\n');
 console.log('E08_FROZEN_BYTES_READ '+JSON.stringify({sourceSha:cycle.sourceSha,executionSha:run.headSha,releaseId:target.releaseId}));
}else if(stage==='result'){
 const target=matrixTarget(),jobs=(await reader.pages(`actions/runs/${run.id}/attempts/${run.runAttempt}/jobs`,'jobs')).map(native.jobFact),job=jobs.find(j=>j.name===`${inputs.mode}/${target.channelId}/${target.unitId}`);
 const name=`channel-${request.requestKey}-${target.unitId}-${target.channelId}-${run.id}-${run.runAttempt}`;
 const matches=(await reader.pages(`actions/runs/${run.id}/artifacts`,'artifacts')).filter(a=>a.name===name);
 if(matches.length!==1||matches[0].workflow_run?.head_sha!==run.headSha)throw Error('NATIVE_ARTIFACT_REQUIRED');
 const object={kind:'artifact',id:matches[0].id,digest:matches[0].digest.replace('sha256:','')};
 for(const receipt of native.channelBusinessResults(context,request,run,job,target,new Date().toISOString(),[object]))console.log('STEWARD_RESULT '+JSON.stringify(receipt));
}
