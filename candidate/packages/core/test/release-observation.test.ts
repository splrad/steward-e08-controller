import { describe, expect, it } from 'vitest';
import examples from './fixtures/budget-evidence-examples.json' with { type: 'json' };
import { sha256Hex } from '../src/fingerprint.js';
import { decodeReleaseRecord, deriveFailureBudget, evaluateCompletion, nativeWaveKey, parseReleaseRecord,
  type BusinessOutcome, type CurrentInvocation, type NativeAttemptEvidence, type NativeAttemptSet,
  type RepositoryRecord, type CycleRecord, type CompletionSource, type CompletionEvidence } from '../src/release-observation.js';

const S='a'.repeat(40), C='b'.repeat(40), D='c'.repeat(40), H='d'.repeat(64), E='e'.repeat(64);
const cycleId=`pr-12-${S}`, start='2026-10-27T00:00:00.000Z', end='2026-10-27T00:01:00.000Z', now='2026-10-27T00:02:00.000Z';
const repository:RepositoryRecord={schemaVersion:2,repositoryId:1,defaultBranch:'main',revision:0,lastObservedDefaultSha:null,lastCompletedCycleId:null,activeCycleId:null,candidate:null,nextCheckAt:null,lastProgressAt:null,lastErrorCode:null};
const cycle:CycleRecord={id:cycleId,prNumber:12,sourceSha:S,controllerSha:C,deliveryConfigSha:D,
  units:[{id:'app',version:'1.2.3',tag:'v1.2.3',releaseId:null,assets:[],notesDigest:null,manifestDigest:null}],
  requiredChannels:[],dispatches:[],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
function wave(runId=100,runAttempt=1,outcome:BusinessOutcome='BUSINESS_FAILED',entry:NativeAttemptEvidence['entry']='build'):NativeAttemptEvidence {
  return {repositoryId:1,cycleId,workflowId:10,runId,runAttempt,entry,sourceSha:S,inputDigest:H,executorControllerSha:C,actorId:42,
    status:'completed',observedAt:now,jobsComplete:true,jobs:[{id:1,steps:[{number:1,name:'business-build',startedAt:start,completedAt:end,conclusion:'failure'}]}],
    invocations:[{jobId:1,stepNumber:1,evidence:{repositoryId:1,cycleId,workflowId:10,runId,runAttempt,entry,jobId:1,unitId:'app',channelId:null,
      invocationKey:H,inputDigest:H,startedAt:start,businessStartedProven:!['WAIT','REJECTED_BEFORE_BUSINESS'].includes(outcome),nativeEvidencePath:'evidence/native.json',outcome,completedAt:end,objectEvidencePaths:['evidence/object.json'],observedAt:now}}],
    sourceUrl:`https://api.github.com/repos/example/product/actions/runs/${runId}`,evidenceDigest:E};
}
function input(attempts:NativeAttemptEvidence[]) {
  const runs=[...new Set(attempts.map(item=>item.runId))].map(runId=>{
    const values=attempts.filter(item=>item.runId===runId),item=values[0]!;
    return {runId,workflowId:item.workflowId,entry:item.entry,sourceSha:S,inputDigest:H,actorId:42,latestAttempt:Math.max(...values.map(item=>item.runAttempt)),availability:'live' as const};
  });
  const native:NativeAttemptSet={complete:true,runs,attempts};
  const context:CurrentInvocation={repositoryId:1,cycleId,sourceSha:S,expectedRunIds:runs.map(run=>run.runId),currentWave:null};
  return {native,context};
}
describe('closed factual schema 2',()=>{
  const buildRequest=()=>({requestKey:E,operationKey:H,purpose:'build' as const,workflowId:10,ref:`steward/build/${cycleId}`,sourceSha:S,targetKey:'fixed-target',
    inputs:{cycle_id:cycleId,operation_key:H,source_sha:S,controller_sha:C},inputDigest:H,executionSha:S,sentAt:start,searchWindows:[],canonicalRunId:null,nativeResponseEvidencePath:null,continuationOfRunId:null,retryLimitEvidencePath:null});
  it('accepts only fixed build dispatch fields and binds their source to the cycle',()=>{
    const value=structuredClone(cycle);value.dispatches=[buildRequest()];expect(parseReleaseRecord('cycle',value)).toEqual(value);
    value.dispatches[0]!.inputs.controller_sha=D;expect(()=>parseReleaseRecord('cycle',value)).toThrow('dispatch input identity');
  });
  it.each(['shell','plugin','workflow','allowed_jobs'])('rejects arbitrary dispatch input %s',field=>{
    const value=structuredClone(cycle);value.dispatches=[buildRequest()];value.dispatches[0]!.inputs[field]='unexpected';
    expect(()=>parseReleaseRecord('cycle',value)).toThrow('invalid cycle record');
  });
  it('binds channel targets to the frozen units and rejects embedded command fields',()=>{
    const value=structuredClone(cycle);value.units[0]!.releaseId=7;value.units[0]!.manifestDigest=H;
    const target={unitId:'app',channelId:'winget',version:'1.2.3',releaseId:7,manifestDigest:H};
    value.dispatches=[{...buildRequest(),purpose:'channel-submit',ref:'main',executionSha:D,inputs:{cycle_id:cycleId,operation_key:H,request_key:E,source_sha:S,execution_sha:D,controller_sha:C,mode:'submit',targets_json:JSON.stringify([target])}}];
    expect(parseReleaseRecord('cycle',value)).toEqual(value);
    value.dispatches[0]!.inputs.targets_json=JSON.stringify([{...target,shell:'run something'}]);expect(()=>parseReleaseRecord('cycle',value)).toThrow('closed fields');
    value.dispatches[0]!.inputs.targets_json=JSON.stringify([{...target,releaseId:99}]);expect(()=>parseReleaseRecord('cycle',value)).toThrow('target identity');
  });
  it('accepts an actual pre-PR candidate with explicit nulls and preserves G/H/N fields',()=>{
    const candidate={id:H,prNumber:null,branch:'release-please--branches--main',baseSha:S,generatedSnapshotPath:null,publishedHead:null,editingAckHead:null,statusCommentId:null,contentGenerationDigest:H,adoptionOverride:null,observedLabelEventIds:[],pendingWrite:null};
    expect(parseReleaseRecord('repository',{...repository,candidate})).toEqual({...repository,candidate});
    expect(parseReleaseRecord('cycle',cycle)).toEqual(cycle);
  });
  it.each(['phase','status','businessRound','failureCount','allowedJobs','nextAttempt','ignored','retired','authorizationRevision'])('rejects writable authority/cache field %s',field=>{
    expect(()=>parseReleaseRecord('repository',{...repository,[field]:1})).toThrow();
    expect(()=>parseReleaseRecord('cycle',{...cycle,[field]:1})).toThrow();
  });
  it.each([0,1,3,'2',null])('rejects unknown or unsupported state schema %j',schemaVersion=>{
    expect(()=>parseReleaseRecord('repository',{...repository,schemaVersion})).toThrow();
  });
  it.each(['{"schemaVersion":2,"schemaVersion":2}','\ufeff{}','{"a":"\\ud800"}','{"a":1e400}'])('strictly decodes raw bytes %s',source=>{
    expect(()=>decodeReleaseRecord('repository',new TextEncoder().encode(source))).toThrow();
  });
  it('rejects source/PR id mismatch and foreign required units',()=>{
    expect(()=>parseReleaseRecord('cycle',{...cycle,prNumber:13})).toThrow('cycle identity');
    expect(()=>parseReleaseRecord('cycle',{...cycle,requiredChannels:[{unitId:'other',channelId:'winget'}]})).toThrow('required channels');
  });
  it('rejects path escape and missing explicit nullable fields',()=>{
    expect(()=>parseReleaseRecord('cycle',{...cycle,completedEvidencePath:'evidence/../outside.json'})).toThrow();
    const value=structuredClone(repository) as Partial<RepositoryRecord>; delete value.activeCycleId;
    expect(()=>parseReleaseRecord('repository',value)).toThrow();
  });
  it('copies mutable caller records and rejects a result dated before its start',()=>{
    const value=structuredClone(cycle),parsed=parseReleaseRecord('cycle',value);value.units[0]!.version='changed';expect(parsed.units[0]!.version).toBe('1.2.3');
    const evidence=wave().invocations[0]!.evidence;
    expect(()=>parseReleaseRecord('executionEvidence',{...evidence,completedAt:'2026-10-26T00:00:00Z'})).toThrow('chronology');
  });
});
describe('failure budget from native attempts and evidence',()=>{
  it('does not infer execution from timestamps on a skipped native step, and rejects conflicting receipts',async()=>{
    const value=wave(),{native,context}=input([value]);value.jobs[0]!.steps[0]!.conclusion='skipped';
    const receipt=value.invocations[0]!;value.invocations=[];
    expect(await deriveFailureBudget(native,[],context)).toMatchObject({remaining:3,failedWaveKeys:[],unknownEvidence:[],conflictEvidence:[]});
    value.invocations=[receipt];
    const conflict=await deriveFailureBudget(native,[],context);expect(conflict.remaining).toBeNull();
    expect(conflict.conflictEvidence.some(key=>key.endsWith(':invocation-source'))).toBe(true);
  });
  it('keeps an unobserved current wave UNKNOWN instead of treating it as a trusted exclusion',async()=>{
    const {native,context}=input([wave()]);context.currentWave=wave(999);
    const result=await deriveFailureBudget(native,[],context);expect(result.remaining).toBeNull();expect(result.unknownEvidence).toContain('current-wave-not-observed');
  });
  it.each(['complete','step-number','step-time','extra-field'])('rejects malformed native %s evidence',async kind=>{
    const value=wave(),{native,context}=input([value]);
    if(kind==='complete')value.jobsComplete='true' as never;
    if(kind==='step-number')value.jobs[0]!.steps[0]!.number=0;
    if(kind==='step-time')value.jobs[0]!.steps[0]!.completedAt='2026-10-26T00:00:00Z';
    if(kind==='extra-field')(value.jobs[0] as unknown as Record<string,unknown>).allowed=true;
    await expect(deriveFailureBudget(native,[],context)).rejects.toThrow('RELEASE_OBSERVATION');
  });
  it('rejects contradictory snapshots with the same native observation time',async()=>{
    const a=wave(),b=wave(100,1,'EFFECT_CONFIRMED'),{native,context}=input([a,b]);
    const result=await deriveFailureBudget(native,[],context);expect(result.remaining).toBeNull();expect(result.conflictEvidence).toContain((await nativeWaveKey(a))+':ambiguous-observation');
  });
  it.each(examples.examples)('recomputes the attached normative example $id: $scenario',async example=>{
    const observations=example.evidence.map(item=>{
      const parts=item.waveKey.split(':');const runId=Number(parts[3]),attempt=Number(parts[4]),entry=parts[2]==='central'?'publish':parts[2] as 'build'|'channel';
      const value=wave(runId,attempt,item.classification as BusinessOutcome,entry);
      value.status=item.terminal?'completed':'in_progress';value.invocations[0]!.evidence.businessStartedProven=item.businessStartedProven;return value;
    });
    // The examples abbreviate successful/pre-business attempts; materialize that
    // native coverage only in this fixture. Production never fills missing history.
    if(example.evidenceComplete) for(const item of [...observations]) for(let n=1;n<item.runAttempt;n++) if(!observations.some(other=>other.runId===item.runId&&other.runAttempt===n)) observations.push(wave(item.runId,n,'WAIT',item.entry));
    const {native,context}=input(observations);native.complete=example.evidenceComplete;
    context.currentWave=observations.find(item=>item.status!=='completed')??null;
    const result=await deriveFailureBudget(native,[],context);
    expect(result.failedWaveKeys).toHaveLength(example.expected.knownFailedCount);
    expect(result.remaining).toBe(example.expected.remaining);
    expect(result.unknownEvidence.length>0).toBe(example.expected.unknown);
  });
  it('counts two failed jobs in one terminal wave once and keeps partial read-only failure free',async()=>{
    const value=wave();value.jobs.push({...structuredClone(value.jobs[0]!),id:2});
    value.invocations.push({...structuredClone(value.invocations[0]!),jobId:2,evidence:{...value.invocations[0]!.evidence,jobId:2,unitId:'second',invocationKey:E}});
    const {native,context}=input([value]);expect((await deriveFailureBudget(native,[],context)).remaining).toBe(2);
    value.invocations[0]!.evidence.outcome='EFFECT_CONFIRMED';value.invocations[1]!.evidence.outcome='WAIT';value.invocations[1]!.evidence.businessStartedProven=false;
    expect((await deriveFailureBudget(native,[],context)).remaining).toBe(3);
  });
  it('keeps a current parallel wave out of failure counts and reports another live wave',async()=>{
    const a=wave(),b=wave(200);a.status='in_progress';b.status='in_progress';const {native,context}=input([a,b]);context.currentWave=a;
    const result=await deriveFailureBudget(native,[],context);expect(result.failedWaveKeys).toEqual([]);expect(result.remaining).toBe(3);expect(result.inFlightWaveKeys).toEqual([await nativeWaveKey(b)]);
  });
  it.each(['missing','jobs','step-only','unknown-write','before-marker'])('does not infer zero or failure from %s',async kind=>{
    const value=wave();const {native,context}=input([value]);
    if(kind==='missing')native.attempts=[];
    if(kind==='jobs')value.jobsComplete=false;
    if(kind==='step-only')value.invocations=[];
    if(kind==='unknown-write')value.invocations[0]!.evidence.outcome='UNKNOWN';
    if(kind==='before-marker')value.invocations[0]!.evidence.businessStartedProven=false;
    const result=await deriveFailureBudget(native,[],context);expect(result.remaining).toBeNull();expect(result.unknownEvidence.length).toBeGreaterThan(0);
  });
  it('accepts a later trusted UNKNOWN-to-effect observation, rejects immutable identity changes',async()=>{
    const a=wave(100,1,'UNKNOWN');a.observedAt=end;a.invocations[0]!.evidence.observedAt=end;
    const b=wave(100,1,'EFFECT_CONFIRMED');const {native,context}=input([a,b]);
    expect((await deriveFailureBudget(native,[],context)).remaining).toBe(3);
    a.executorControllerSha=D;const result=await deriveFailureBudget(native,[],context);expect(result.remaining).toBeNull();expect(result.conflictEvidence).toContain((await nativeWaveKey(a))+':immutable-identity');
  });
  it('uses protected-history bytes only after explicit native expiration, not after 403 or unknown reads',async()=>{
    const value=wave();const {native,context}=input([value]);native.attempts=[];native.runs[0]!.availability='expired';
    const archive={stateCommit:C,rawDigest:await sha256Hex(JSON.stringify(value)),attempt:value};
    expect((await deriveFailureBudget(native,[archive],context)).remaining).toBe(2);
    native.runs[0]!.availability='unavailable';expect((await deriveFailureBudget(native,[archive],context)).remaining).toBeNull();
    native.runs[0]!.availability='expired';archive.rawDigest=H;expect((await deriveFailureBudget(native,[archive],context)).remaining).toBeNull();
  });
  it.each(['actor','source','job','future'])('rejects native %s identity mismatch',async kind=>{
    const value=wave(),{native,context}=input([value]);
    if(kind==='actor')value.actorId=99;if(kind==='source')value.sourceSha=C;
    if(kind==='job')value.invocations[0]!.jobId=999;if(kind==='future')value.runAttempt=2;
    const result=await deriveFailureBudget(native,[],context);expect(result.remaining).toBeNull();expect(result.conflictEvidence.length).toBeGreaterThan(0);
  });
  it('freezes input before hashing and accepts actually observed attempts beyond an arbitrary 100 cap',async()=>{
    const attempts=Array.from({length:101},(_,i)=>wave(100,i+1,'WAIT')),{native,context}=input(attempts);
    const pending=deriveFailureBudget(native,[],context);native.complete=false;native.attempts.length=0;
    expect((await pending).remaining).toBe(3);
  });
  it('distinguishes the central publish wave from a product wave and ignores no persisted counters',async()=>{
    const value=wave();expect(await nativeWaveKey(value)).not.toBe(await nativeWaveKey({...value,entry:'publish'}));
    const {native,context}=input([value]);await expect(deriveFailureBudget({...native,businessRound:0} as never,[],context)).rejects.toThrow('closed fields');
  });
});
function completion() {
  const source:CompletionSource={repositoryId:1,cycleId,sourceSha:S,deliveryConfigSha:D,units:[{id:'app',version:'1.2.3',tag:'v1.2.3',releaseId:7,authorId:42,manifestDigest:H,notesDigest:E,assets:[{path:'app.zip',size:12,sha256:H}]}],requiredChannels:[{unitId:'app',channelId:'winget',version:'1.2.3',digest:H,inputDigest:E,private:false}]};
  const facts:CompletionEvidence={source:structuredClone(source),sourceComplete:true,observedAt:now,releasesComplete:true,channelsComplete:true,
    releases:[{...source.units[0]!,unitId:'app',sourceSha:S,draft:false,immutable:true,evidenceDigest:E} as CompletionEvidence['releases'][number]],
    channels:[{unitId:'app',channelId:'winget',version:'1.2.3',digest:H,inputDigest:E,nativeObjectId:'native-pr-9',accepted:true,indexed:true,rejected:false,visible:true,observedAt:now,evidenceDigest:H}],
    consumptions:[{unitId:'app',channelId:'winget',version:'1.2.3',digest:H,inputDigest:E,repositoryId:1,sourceSha:S,runId:100,jobId:10,conclusion:'success',consumedDigest:H,logDigest:E,evidenceDigest:H}],inFlightWaveKeys:[],unknownWriteKeys:[]};
  delete (facts.releases[0] as unknown as Record<string,unknown>).id;
  return {source,facts};
}
describe('four-valued completion',()=>{
  it('requires all native objects and actual consumption, independent of object key order',()=>{
    const {source,facts}=completion();expect(evaluateCompletion(source,facts,now).result).toBe('PASS');
    facts.source=JSON.parse(JSON.stringify(facts.source).replace('"repositoryId":1,','').replace('{','{"repositoryId":1,'));
    expect(evaluateCompletion(source,facts,now).result).toBe('PASS');
  });
  it.each(['source','release-read','channel-read','consumption','unknown-write'])('returns UNKNOWN for %s gaps',kind=>{
    const {source,facts}=completion();if(kind==='source')facts.sourceComplete=false;if(kind==='release-read')facts.releasesComplete=false;
    if(kind==='channel-read')facts.channelsComplete=false;if(kind==='consumption')facts.consumptions=[];if(kind==='unknown-write')facts.unknownWriteKeys=[H];
    expect(evaluateCompletion(source,facts,now).result).toBe('UNKNOWN');
  });
  it.each(['draft','mutable','missing-release','pending','invisible','live-wave','failed-consumption'])('returns WAIT for %s',kind=>{
    const {source,facts}=completion();if(kind==='draft')facts.releases[0]!.draft=true;if(kind==='mutable')facts.releases[0]!.immutable=false;if(kind==='missing-release')facts.releases=[];
    if(kind==='pending')facts.channels[0]!.indexed=false;if(kind==='invisible')facts.channels[0]!.visible=false;if(kind==='live-wave')facts.inFlightWaveKeys=[H];if(kind==='failed-consumption')facts.consumptions[0]!.conclusion='failure';
    expect(evaluateCompletion(source,facts,now).result).toBe('WAIT');
  });
  it.each(['source','required','bytes','actor','tag','manifest','notes','rejected','digest','consumption','duplicate'])('returns CONFLICT for %s changes',kind=>{
    const {source,facts}=completion();if(kind==='source')facts.source.sourceSha=C;if(kind==='required')facts.source.requiredChannels=[];
    if(kind==='bytes')facts.releases[0]!.assets[0]!.sha256=E;if(kind==='actor')facts.releases[0]!.authorId=99;if(kind==='tag')facts.releases[0]!.tag='another';
    if(kind==='manifest')facts.releases[0]!.manifestDigest=E;if(kind==='notes')facts.releases[0]!.notesDigest=H;if(kind==='rejected')facts.channels[0]!.rejected=true;
    if(kind==='digest')facts.channels[0]!.digest=E;if(kind==='consumption')facts.consumptions[0]!.consumedDigest=E;if(kind==='duplicate')facts.releases.push(structuredClone(facts.releases[0]!));
    if(kind==='source')facts.source.cycleId=`pr-12-${C}`;
    expect(evaluateCompletion(source,facts,now).result).toBe('CONFLICT');
  });
  it('keeps private probe TTL tied to original observation time and accepts the exact ten-minute boundary',()=>{
    const {source,facts}=completion();source.requiredChannels[0]!.private=true;facts.source=structuredClone(source);
    expect(evaluateCompletion(source,facts,'2026-10-27T00:12:00.000Z').result).toBe('PASS');
    facts.observedAt='2026-10-27T00:12:00.001Z';expect(evaluateCompletion(source,facts,facts.observedAt).result).toBe('WAIT');
  });
  it('checks every changed unit and cannot remove a required channel to get PASS',()=>{
    const {source,facts}=completion();source.units.push({...structuredClone(source.units[0]!),id:'second'});facts.source=structuredClone(source);
    expect(evaluateCompletion(source,facts,now).result).toBe('WAIT');facts.source.requiredChannels=[];expect(evaluateCompletion(source,facts,now).result).toBe('CONFLICT');
  });
  it.each(['phase','activeCycleId','completedEvidencePath','lastCompletedCycleId'])('does not accept cached %s as authority',field=>{
    const {source,facts}=completion();expect(()=>evaluateCompletion(source,{...facts,[field]:'PASS'} as never,now)).toThrow('closed fields');
  });
});
