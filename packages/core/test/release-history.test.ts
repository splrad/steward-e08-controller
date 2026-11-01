import {expect,it} from 'vitest';
import {reconcileCycleHistory,type CycleCompletionFact,type RepairDecisionFact} from '../src/release-history.js';
import type {CompletionSource,CompletionEvidence,CycleRecord} from '../src/release-observation.js';
const S='a'.repeat(40),C='b'.repeat(40),D='c'.repeat(40),H='d'.repeat(64),NOW='2026-10-27T00:00:00.000Z';
export function historyCycle(n=1):{cycle:CycleRecord;fact:CycleCompletionFact} {
  const sourceSha=n===1?S:C,id=`pr-${n}-${sourceSha}`,unit={id:'app',version:`1.0.${n}`,tag:`v1.0.${n}`,releaseId:n,manifestDigest:H,notesDigest:H,assets:[{id:'app',path:'app.zip',size:1,sha256:H}]};
  const cycle:CycleRecord={id,prNumber:n,sourceSha,controllerSha:C,deliveryConfigSha:D,units:[unit],requiredChannels:[],dispatches:[],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
  const source:CompletionSource={repositoryId:1,cycleId:id,sourceSha,deliveryConfigSha:D,units:[{...unit,releaseId:n,authorId:42,assets:unit.assets.map(({path,size,sha256})=>({path,size,sha256}))}],requiredChannels:[]};
  const u=source.units[0]!,{id:unitId,...release}=u;
  const observation:CompletionEvidence={source,sourceComplete:true,observedAt:NOW,releasesComplete:true,channelsComplete:true,
    releases:[{...release,unitId,sourceSha,draft:false,immutable:true,evidenceDigest:H}],channels:[],consumptions:[],inFlightWaveKeys:[],unknownWriteKeys:[]};
  return {cycle,fact:{cycleId:id,source,observation,kind:'live',provenanceComplete:true}};
}
function input(values= [historyCycle()]) {
  return {repositoryId:1,inventoryComplete:true,cycles:values.map(v=>v.cycle),discovered:values.map((v,i)=>({id:v.cycle.id,prNumber:v.cycle.prNumber,sourceSha:v.cycle.sourceSha,mergedAt:`2026-10-${25+i}T00:00:00.000Z`})),
    completions:values.map(v=>v.fact),decisions:[] as RepairDecisionFact[],repairActorId:99,now:NOW};
}
it('uses fresh actual completion and treats persisted pointers only as locators',()=>{
  const v=historyCycle(),i=input([v]);v.cycle.completedEvidencePath='evidence/fake.json';
  expect(reconcileCycleHistory(i)).toMatchObject({result:'PASS',activeCycleIds:[],lastCompletedCycleId:v.cycle.id});
  i.completions=[];expect(reconcileCycleHistory(i).result).toBe('UNKNOWN');
});
it.each(['inventory','source','provenance','fresh'])('cannot complete with missing %s',kind=>{
  const i=input();if(kind==='inventory')i.inventoryComplete=false;if(kind==='source')i.discovered=[];
  if(kind==='provenance')i.completions[0]!.provenanceComplete=false;if(kind==='fresh')i.completions[0]!.kind='historical';
  expect(reconcileCycleHistory(i).result).toBe('UNKNOWN');
});
it('preserves earlier complete delivery when an old object is delisted, while requiring the newest source live',()=>{
  const old=historyCycle(),latest=historyCycle(2);old.fact.kind='historical';
  const i=input([old,latest]),delisted=structuredClone(old.fact);delisted.kind='live';delisted.observation.releases=[];i.completions.push(delisted);
  expect(reconcileCycleHistory(i).result).toBe('PASS');latest.fact.observation.releases=[];expect(reconcileCycleHistory(i).result).toBe('WAIT');
});
it('keeps unknown writes and changed fixed obligations closed',()=>{
  const i=input();i.completions[0]!.observation.unknownWriteKeys=[H];expect(reconcileCycleHistory(i).result).toBe('UNKNOWN');
  i.completions[0]!.observation.unknownWriteKeys=[];i.cycles[0]!.units[0]!.version='2.0.0';expect(reconcileCycleHistory(i).result).toBe('CONFLICT');
});
function repair() {
  const old=historyCycle(),replacement=historyCycle(2);old.fact.observation.releases=[];
  const decision={eventId:10,actorId:99,createdAt:NOW,cycleId:old.cycle.id,sourceSha:S,unitIds:['app'],releaseIds:[1],tags:['v1.0.1'],evidencePath:'evidence/repair.json'};
  replacement.cycle.repairOf=old.cycle.id;replacement.cycle.approvedRepairDecision=decision;
  const i=input([old,replacement]);i.decisions=[{...decision,originalStateCommit:D,originalActiveCycleIds:[old.cycle.id]}];return i;
}
it('a completed exact repair discharges old obligations without changing original records',()=>{
  const i=repair(),before=JSON.stringify(i),result=reconcileCycleHistory(i);
  expect(result).toMatchObject({result:'PASS',dischargedCycleIds:[i.cycles[0]!.id],activeCycleIds:[]});expect(JSON.stringify(i)).toBe(before);
});
it('a unit-scoped completed repair discharges only its units and preserves independently proved other obligations',()=>{
  const i=repair(),other={...structuredClone(i.cycles[0]!.units[0]!),id:'other',releaseId:3};i.cycles[0]!.units.push(other);
  const unit={...structuredClone(i.completions[0]!.source.units[0]!),id:'other',releaseId:3};i.completions[0]!.source.units.push(unit);
  i.completions[0]!.observation.source=structuredClone(i.completions[0]!.source);
  const {id:unitId,...fields}=unit;i.completions[0]!.observation.releases=[{...fields,unitId,sourceSha:S,draft:false,immutable:true,evidenceDigest:H}];
  expect(reconcileCycleHistory(i).result).toBe('PASS');
  i.completions[0]!.observation.releases=[];expect(reconcileCycleHistory(i).result).toBe('WAIT');
});
it('propagates a completed repair chain while retaining native source identity blockers',()=>{
  const i=repair(),last=historyCycle(3),parent=i.cycles[1]!;i.completions[1]!.observation.releases=[];
  const decision={eventId:11,actorId:99,createdAt:NOW,cycleId:parent.id,sourceSha:parent.sourceSha,unitIds:['app'],releaseIds:[2],tags:['v1.0.2'],evidencePath:'evidence/repair-two.json'};
  last.cycle.repairOf=parent.id;last.cycle.approvedRepairDecision=decision;i.cycles.push(last.cycle);i.completions.push(last.fact);
  i.discovered.push({id:last.cycle.id,prNumber:3,sourceSha:last.cycle.sourceSha,mergedAt:NOW});i.decisions.push({...decision,originalStateCommit:D,originalActiveCycleIds:[parent.id]});
  expect(reconcileCycleHistory(i)).toMatchObject({result:'PASS',dischargedCycleIds:[i.cycles[0]!.id,parent.id].sort()});
  i.discovered.shift();expect(reconcileCycleHistory(i).result).toBe('UNKNOWN');
});
it.each(['actor','active','source','incomplete','ambiguous','units'])('rejects or waits for %s repair evidence',kind=>{
  const i=repair();if(kind==='actor')i.decisions[0]!.actorId=98;if(kind==='active')i.decisions[0]!.originalActiveCycleIds=[i.cycles[1]!.id];
  if(kind==='source')i.decisions[0]!.sourceSha=C;if(kind==='incomplete')i.completions[1]!.observation.releases=[];
  if(kind==='ambiguous')i.decisions.push(structuredClone(i.decisions[0]!));if(kind==='units')i.decisions[0]!.unitIds=['other'];
  expect(reconcileCycleHistory(i).result).toBe(kind==='incomplete'?'WAIT':'CONFLICT');
});
