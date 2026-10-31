import {expect,it} from 'vitest';
import {inspectNativeCycle,recoverNativeCycle,archiveFile,retryLimitFile,verifyNativeRetryLimit,nativeRequestIdentity,nativeRunFact,jobFact,validateEvidenceContext,type ArchiveFile,type ArchivedFile} from '../src/native-release-evidence.js';
import {prepareContinuation,dispatchNativeRun,channelPreparationResults,channelTargetsDigest,channelEvidenceFile,verifyContinuationReleases} from '../src/release-run.js';
import {decodeNativeRetryLimit} from '../../core/src/native-evidence.js';
import {evidenceFixture,NOW,D,START,digest} from './native-evidence-fixture.js';
const OLD='2026-11-26T00:02:00.000Z';
function channel(attempts=1,mode:'submit'|'verify'='submit') {
  const f=evidenceFixture(attempts),unit=f.context.cycle.units[0]!;
  Object.assign(unit,{releaseId:50,manifestDigest:'d'.repeat(64),notesDigest:'e'.repeat(64),assets:[{id:'app',path:'app.zip',size:1,sha256:'f'.repeat(64)}]});
  f.context.cycle.requiredChannels=[{unitId:'app',channelId:'test'}];
  f.request.purpose=`channel-${mode}`;f.request.ref='main';f.request.inputs={cycle_id:f.context.cycle.id,source_sha:f.context.cycle.sourceSha,
    controller_sha:f.context.cycle.controllerSha,execution_sha:f.request.executionSha,operation_key:'0'.repeat(64),request_key:'0'.repeat(64),mode,
    targets_json:JSON.stringify([{unitId:'app',channelId:'test',version:unit.version,releaseId:50,manifestDigest:unit.manifestDigest}])};
  Object.assign(f.request,nativeRequestIdentity(1,f.context.cycle,f.request));f.request.inputs.operation_key=f.request.operationKey;f.request.inputs.request_key=f.request.requestKey;
  for(const [i,run] of f.runs) {
    run.path='.github/workflows/steward-release-channels.yml';run.head_branch='main';run.display_title=f.request.requestKey;
    const result=f.results.get(i)!;result.execution.entry='channel';result.execution.channelId='test';result.execution.inputDigest=f.request.inputDigest;
    result.execution.invocationKey=digest(JSON.stringify([1,f.context.cycle.id,10,100,i,'channel',i*1000,2,'app','test',f.request.inputDigest]));
  }
  const records:ArchivedFile[]=[],files:ArchiveFile[]=[];
  const original=f.store.archive;
  f.store.archive=async next=>{const saved=await original(next);records.push(...saved.records);files.push(...next);return {...saved,records:[...records],files:[...files]};};
  return {...f,records,files};
}
it('continues on reviewed current R while preserving original failures and the full frozen target set',async()=>{
  const f=channel(2);await recoverNativeCycle(f.context,100,f.store,[],f.io,OLD);
  const file=f.files.find(file=>file.path.includes('retry-limit'))!,proof={path:file.path,commit:D,value:JSON.parse(file.content)};
  const next=prepareContinuation(f.context,proof,f.records,OLD,{ref:'main',sha:D});f.context.cycle.dispatches.push(next);
  expect(()=>validateEvidenceContext(f.context)).not.toThrow();expect(next.inputs.targets_json).toBe(f.request.inputs.targets_json);
  expect(next.executionSha).toBe(D);expect(next.sourceSha).toBe(f.request.sourceSha);expect(next.inputs.operation_key).toBe(next.operationKey);
});
it.each([false,true])('pending preparation has zero failures and current readiness=%s controls exact job rerun',async ready=>{
  const f=channel(1,'verify'),raw=f.runs.get(1),job=f.jobs.get(1)![0];
  raw.conclusion='success';job.name='channel-prepare';job.conclusion='success';job.steps[0].name='business-channel-readiness';job.steps[0].conclusion='success';
  f.results.set(1,channelPreparationResults(f.context,f.request,nativeRunFact(raw),jobFact(job),[],job.completed_at)[0]!);
  f.overrides.set('GET /repos/example/product/actions/jobs/1000/logs',f.response(`${job.completed_at} STEWARD_RESULT ${JSON.stringify(f.results.get(1))}\n`));
  const probeRun={...nativeRunFact(raw),id:200},probeJob={...jobFact(job),id:2000,runId:200,name:'observe',steps:[]},targets=JSON.parse(f.request.inputs.targets_json!);
  const payload=JSON.stringify({schemaVersion:1,cycleId:f.context.cycle.id,sourceSha:f.context.cycle.sourceSha,executionSha:raw.head_sha,controllerSha:f.context.cycle.controllerSha,
    targetsDigest:channelTargetsDigest(f.context,targets),nativeRunId:200,runAttempt:1,items:[{unitId:'app',channelId:'test',version:'1.0.0',readStatus:ready?'OK':'PENDING',exists:true,digest:null,accepted:ready,indexed:ready,observedAt:job.completed_at,evidenceKind:'github-pr:3'}]});
  const value={schemaVersion:1 as const,repositoryId:1,cycleId:f.context.cycle.id,sourceSha:f.context.cycle.sourceSha,observedAt:NOW,kind:'PROBE' as const,
    run:probeRun,job:probeJob,artifact:{id:300,name:'probe',digest:'sha256:'+'a'.repeat(64),createdAt:job.completed_at},payload};
  const file=channelEvidenceFile(value);
  const result=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW,{complete:true,observations:[],channelEvidence:[{path:file.path,commit:D,value}]});
  expect(result.observation.budget.remaining).toBe(3);
  expect(f.calls.some(call=>call==='POST /repos/example/product/actions/jobs/1000/rerun')).toBe(ready);
  expect(f.calls.some(call=>call.includes('/rerun-failed-jobs'))).toBe(false);
});
it('ignores native download counters while still checking formal asset identities and bytes',async()=>{
  const f=channel(),unit=f.context.cycle.units[0]!;unit.notesDigest=digest('notes');unit.assets[0]!.sha256=digest('f');let count=0;
  const io={request:async(_method:string,path:string)=>{
    if(path.endsWith('/assets/51'))return f.response('f');
    if(path.includes('/assets?'))return f.response([{id:51,name:'app.zip',size:1,download_count:count++}]);
    if(path.includes('/commits/'))return f.response({sha:f.context.cycle.sourceSha});
    return f.response({id:50,tag_name:unit.tag,author:{id:42},body:'notes',draft:false,immutable:true,assets:[{download_count:count++}]});
  }};
  await expect(verifyContinuationReleases(f.context,io)).resolves.toBeUndefined();expect(count).toBeGreaterThan(1);
});
it('archives original first/terminal Run and all attempts before allowing age continuation',async()=>{
  const f=channel(2),result=await recoverNativeCycle(f.context,100,f.store,[],f.io,OLD);
  expect(result.status).toBe('CONTINUATION_REQUIRED');expect(f.calls.some(c=>c.startsWith('POST'))).toBe(false);
  const file=f.files.find(file=>file.path.startsWith('evidence/retry-limit/'))!,proof=decodeNativeRetryLimit(Buffer.from(file.content));
  expect(proof.reason).toBe('AGE');expect(proof.firstRun.runAttempt).toBe(1);expect(proof.terminalRun.runAttempt).toBe(2);
  const next=prepareContinuation(f.context,{path:file.path,commit:D,value:proof},f.records,OLD);
  expect(next.operationKey).toBe(f.request.operationKey);expect(next.requestKey).not.toBe(f.request.requestKey);expect(next.continuationOfRunId).toBe(100);
  expect(next.canonicalRunId).toBeNull();expect(next.purpose).toBe('channel-submit');expect(result.observation.budget.remaining).toBe(1);
});
it('never rebuilds an expired build Run',async()=>{
  const f=evidenceFixture();const original=f.store.archive;f.store.archive=async files=>({...await original(files),files});
  expect((await recoverNativeCycle(f.context,100,f.store,[],f.io,OLD)).reason).toBe('BUILD_CANNOT_CONTINUE');
  expect(f.calls.some(c=>c.startsWith('POST'))).toBe(false);
});
it.each([50,51])('requires both fifty actual reruns and explicit platform response at attempt %i',async count=>{
  const f=channel(count);for(const jobs of f.jobs.values())jobs[0].steps=[];
  f.overrides.set('POST /repos/example/product/actions/runs/100/rerun-failed-jobs',f.response({message:'Maximum limit of 50 re-runs reached'},422));
  const result=await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW);
  expect(result.status).toBe(count===51?'CONTINUATION_REQUIRED':'UNKNOWN');
  expect(f.files.filter(file=>file.path.startsWith('evidence/retry-limit/'))).toHaveLength(count===51?1:0);
});
it.each([403,429,500])('HTTP %i never proves a retry limit',async status=>{
  const f=channel(51);for(const jobs of f.jobs.values())jobs[0].steps=[];
  f.overrides.set('POST /repos/example/product/actions/runs/100/rerun-failed-jobs',f.response({message:'Maximum limit of 50 re-runs reached'},status));
  expect((await recoverNativeCycle(f.context,100,f.store,[],f.io,NOW)).status).toBe('UNKNOWN');expect(f.files.some(file=>file.path.includes('retry-limit'))).toBe(false);
});
it('generic 422, in-flight, missing readback and boundary age cannot authorize continuation',async()=>{
  const f=channel();f.runs.get(1).status='waiting';f.runs.get(1).conclusion=null;
  expect((await recoverNativeCycle(f.context,100,f.store,[],f.io,OLD)).status).toBe('WAIT');
  const g=channel(51);for(const jobs of g.jobs.values())jobs[0].steps=[];
  g.overrides.set('POST /repos/example/product/actions/runs/100/rerun-failed-jobs',g.response({message:'Validation failed'},422));
  expect((await recoverNativeCycle(g.context,100,g.store,[],g.io,NOW)).reason).toBe('NATIVE_LIMIT_UNPROVEN');
  const h=channel();h.store.archive=async files=>({status:'APPLIED',head:D,records:files.filter(f=>f.path.includes('/native/')).map(f=>({path:f.path,commit:D,value:JSON.parse(f.content)}))});
  expect((await recoverNativeCycle(h.context,100,h.store,[],h.io,OLD)).reason).toBe('LIMIT_NOT_ADOPTED');
  const at=channel();await recoverNativeCycle(at.context,100,at.store,[],at.io,new Date(Date.parse(START)+30*24*60*60_000).toISOString());
  expect(at.files.some(file=>file.path.includes('retry-limit'))).toBe(false);
});
it('rejects missing or substituted original attempts and enforces the three-failure budget',async()=>{
  const f=channel(2);await recoverNativeCycle(f.context,100,f.store,[],f.io,OLD);
  const file=f.files.find(file=>file.path.includes('retry-limit'))!,proof={path:file.path,commit:D,value:JSON.parse(file.content)};
  expect(()=>verifyNativeRetryLimit(f.context,proof,f.records.slice(1))).toThrow('coverage');
  const bad=structuredClone(proof);bad.value.terminalRun.runAttempt=50;expect(()=>retryLimitFile(bad.value)).toThrow();
  const next=prepareContinuation(f.context,proof,f.records,OLD);f.context.cycle.dispatches.push(next);
  const result=await dispatchNativeRun(f.context,next.requestKey,{save:async()=>{throw Error('must not save');}},
    {complete:true,observations:[],archives:[],retryLimits:[proof]},f.io,OLD);
  expect(result.status).toBe('UNKNOWN');expect(f.calls.some(c=>c.includes('/dispatches'))).toBe(false);
  const third=channel(3);expect((await recoverNativeCycle(third.context,100,third.store,[],third.io,OLD)).reason).toBe('FAILURE_BUDGET_EXHAUSTED');
});
it('downloads the frozen formal bytes and binds one continuation without resetting prior failures',async()=>{
  const f=channel(2),unit=f.context.cycle.units[0]!,bytes=Buffer.from('f');unit.notesDigest=digest('notes');unit.assets[0]!.sha256=digest(bytes);
  await recoverNativeCycle(f.context,100,f.store,[],f.io,OLD);
  const file=f.files.find(file=>file.path.includes('retry-limit'))!,proof={path:file.path,commit:D,value:JSON.parse(file.content)};
  const request=prepareContinuation(f.context,proof,f.records,OLD);f.context.cycle.dispatches.push(request);
  f.overrides.set('GET /repos/example/product/actions/workflows/10',f.response({id:10,path:f.runs.get(1).path,state:'active'}));
  f.overrides.set('GET /repos/example/product/git/ref/heads/main',f.response({ref:'refs/heads/main',object:{type:'commit',sha:f.request.executionSha}}));
  f.overrides.set('GET /repos/example/product/releases/50',f.response({id:50,tag_name:unit.tag,author:{id:42},body:'notes',draft:false,immutable:true}));
  f.overrides.set('GET /repos/example/product/releases/50/assets?per_page=100',f.response([{id:51,name:'app.zip',size:1}]));
  f.overrides.set('GET /repos/example/product/releases/assets/51',{status:200,headers:new Headers(),bytes});
  f.overrides.set('GET /repos/example/product/commits/v1.0.0',f.response({sha:f.request.sourceSha}));
  f.overrides.set('POST /repos/example/product/actions/workflows/10/dispatches',f.response({workflow_run_id:200,run_url:'https://api.github.com/repos/example/product/actions/runs/200',html_url:'https://github.com/example/product/actions/runs/200'}));
  f.overrides.set('GET /repos/example/product/actions/runs/200',f.response({...f.runs.get(1),id:200,run_attempt:1,created_at:OLD,updated_at:OLD,status:'queued',conclusion:null,display_title:request.requestKey}));
  const saved:any[]=[];const result=await dispatchNativeRun(f.context,request.requestKey,{save:async cycle=>{saved.push(structuredClone(cycle));return {status:'APPLIED',head:D};}},
    {complete:true,observations:[],archives:f.records,retryLimits:[proof]},f.io,OLD);
  expect(result).toMatchObject({status:'BOUND',canonicalRunId:200});expect(saved.at(-1).dispatches[0].canonicalRunId).toBe(100);
  expect(saved.at(-1).dispatches[1].canonicalRunId).toBe(200);expect(f.calls.filter(call=>call.includes('/dispatches'))).toHaveLength(1);
  expect(f.calls.findIndex(call=>call.endsWith('/releases/assets/51'))).toBeLessThan(f.calls.findIndex(call=>call.includes('/dispatches')));
});
it('uses complete original protected attempts after explicit native expiry and does not issue a rerun',async()=>{
  const f=channel(2),observed=await inspectNativeCycle(f.context,[],f.io,NOW);
  const history=observed.archives.map(value=>({path:archiveFile(value).path,commit:D,value}));
  f.records.push(...history);f.overrides.set('GET /repos/example/product/actions/runs/100',f.response({},410));
  const result=await recoverNativeCycle(f.context,100,f.store,history,f.io,OLD,{complete:true,observations:[]});
  expect(result).toMatchObject({status:'CONTINUATION_REQUIRED'});expect(result.observation.budget.remaining).toBe(1);
  expect(f.calls.some(call=>call.startsWith('POST'))).toBe(false);
});
