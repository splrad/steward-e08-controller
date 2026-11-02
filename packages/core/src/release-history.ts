import {decodeBuildJson} from './build-manifest.js';
import {evaluateCompletion,parseReleaseRecord,type CompletionSource,type CompletionEvidence,type CompletionTruth,type CycleRecord} from './release-observation.js';

export interface CompletionArchive {
  schemaVersion:1; repositoryId:number; cycleId:string; source:CompletionSource; observation:CompletionEvidence;
  provenance:{path:string;digest:string;sourceUrl:string;observedAt:string}[];
}
const fail=(reason:string):never=>{throw new Error('RELEASE_HISTORY: '+reason);};
const keys=(value:object,expected:string[])=>{if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==expected.sort().join(','))fail('closed contract');};
export function decodeCompletionArchive(bytes:Uint8Array):CompletionArchive {
  const value=decodeBuildJson(bytes) as unknown as CompletionArchive;
  keys(value,['schemaVersion','repositoryId','cycleId','source','observation','provenance']);
  if(value.schemaVersion!==1||value.repositoryId!==value.source.repositoryId||value.cycleId!==value.source.cycleId||!Array.isArray(value.provenance)||!value.provenance.length)fail('completion provenance');
  evaluateCompletion(value.source,value.observation,value.observation.observedAt);
  for(const proof of value.provenance) {
    keys(proof,['path','digest','sourceUrl','observedAt']);
    if(!/^evidence\/(?:native\/[1-9][0-9]*-[1-9][0-9]*|publication|channel|channel-read)\/[a-f0-9]{64}\.json$/.test(proof.path)
      ||!proof.path.endsWith('/'+proof.digest+'.json')||!/^https:\/\/[^\s]+$/.test(proof.sourceUrl)||!Number.isFinite(Date.parse(proof.observedAt))
      ||Date.parse(proof.observedAt)>Date.parse(value.observation.observedAt))fail('raw evidence provenance');
  }
  const digests=new Set(value.provenance.map(proof=>proof.digest));
  if([...value.observation.releases,...value.observation.channels,...value.observation.consumptions].some(fact=>!digests.has(fact.evidenceDigest)))fail('unbacked native observation');
  return structuredClone(value);
}
export interface CycleHistoryFact {id:string;prNumber:number;sourceSha:string;mergedAt:string}
export interface CycleCompletionFact {cycleId:string;source:CompletionSource;observation:CompletionEvidence;kind:'live'|'historical';provenanceComplete:boolean}
export interface RepairDecisionFact {
  eventId:number;actorId:number;createdAt:string;cycleId:string;sourceSha:string;unitIds:string[];releaseIds:number[];tags:string[];
  originalStateCommit:string;originalActiveCycleIds:string[];evidencePath:string;
}
export function completionMatchesCycle(repositoryId:number,cycle:CycleRecord,source:CompletionSource) {
  const assets=(values:{path:string;size:number;sha256:string}[])=>values.map(({path,size,sha256})=>({path,size,sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  const units=source.units.map(u=>[u.id,u.version,u.tag,u.releaseId,u.manifestDigest,u.notesDigest,assets(u.assets)]).sort(),expected=cycle.units.map(u=>[u.id,u.version,u.tag,u.releaseId,u.manifestDigest,u.notesDigest,assets(u.assets)]).sort();
  const channels=(values:{unitId:string;channelId:string}[])=>values.map(v=>JSON.stringify([v.unitId,v.channelId])).sort().join(',');
  return source.repositoryId===repositoryId&&source.cycleId===cycle.id&&source.sourceSha===cycle.sourceSha&&source.deliveryConfigSha===cycle.deliveryConfigSha
    &&JSON.stringify(units)===JSON.stringify(expected)&&channels(source.requiredChannels)===channels(cycle.requiredChannels);
}
/** Derive obligations from the complete source history; cached active/completed pointers are deliberately absent. */
export function reconcileCycleHistory(input:{repositoryId:number;inventoryComplete:boolean;cycles:CycleRecord[];discovered:CycleHistoryFact[];
  completions:CycleCompletionFact[];decisions:RepairDecisionFact[];repairActorId:number;now:string}) {
  keys(input,['repositoryId','inventoryComplete','cycles','discovered','completions','decisions','repairActorId','now']);
  const cycles=input.cycles.map(cycle=>parseReleaseRecord('cycle',cycle)),reasons:{cycleId:string;result:CompletionTruth;reason:string}[]=[],discharged=new Set<string>();
  const add=(cycleId:string,result:CompletionTruth,reason:string)=>reasons.push({cycleId,result,reason});
  if(!input.inventoryComplete)add('history','UNKNOWN','INCOMPLETE_SOURCE_HISTORY');
  const discovered=[...input.discovered].sort((a,b)=>a.mergedAt.localeCompare(b.mergedAt)||a.id.localeCompare(b.id));
  if(new Set(cycles.map(c=>c.id)).size!==cycles.length||new Set(discovered.map(c=>c.id)).size!==discovered.length)fail('duplicate cycle');
  for(const fact of discovered) {
    if(!Number.isFinite(Date.parse(fact.mergedAt))||fact.id!==`pr-${fact.prNumber}-${fact.sourceSha}`)fail('source cycle');
    if(!cycles.some(c=>c.id===fact.id))add(fact.id,'UNKNOWN','CYCLE_RECORD_RECONSTRUCTION_REQUIRED');
  }
  const states=new Map<string,CompletionTruth>(),verifiedUnits=new Map<string,Set<string>>(),repairCoverage=new Map<string,Set<string>>();
  const edges:{from:string;to:string;unitIds:string[]}[]=[];
  for(const cycle of cycles) {
    if(!discovered.some(f=>f.id===cycle.id&&f.sourceSha===cycle.sourceSha&&f.prNumber===cycle.prNumber)){add(cycle.id,'UNKNOWN','MERGED_SOURCE_UNPROVEN');states.set(cycle.id,'UNKNOWN');continue;}
    const facts=input.completions.filter(f=>f.cycleId===cycle.id),live=facts.filter(f=>f.kind==='live').sort((a,b)=>b.observation.observedAt.localeCompare(a.observation.observedAt))[0];
    const historical=facts.filter(f=>f.kind==='historical'&&f.provenanceComplete&&evaluateCompletion(f.source,f.observation,f.observation.observedAt).result==='PASS')
      .sort((a,b)=>b.observation.observedAt.localeCompare(a.observation.observedAt))[0];
    // The most recent admitted source and every unfinished source need a fresh native read.
    const needsLive=cycle.id===discovered.at(-1)?.id||!historical;
    const selected=needsLive?live:historical;
    if(!selected||!selected.provenanceComplete){add(cycle.id,'UNKNOWN',needsLive?'FRESH_COMPLETION_REQUIRED':'ORIGINAL_COMPLETION_REQUIRED');states.set(cycle.id,'UNKNOWN');continue;}
    const source=selected.source;
    if(!completionMatchesCycle(input.repositoryId,cycle,source)) {
      add(cycle.id,'CONFLICT','FROZEN_OBLIGATIONS_CHANGED');states.set(cycle.id,'CONFLICT');continue;
    }
    const evaluated=evaluateCompletion(source,selected.observation,needsLive?input.now:selected.observation.observedAt),result=evaluated.result;
    const global=evaluated.reasons.some(reason=>reason.result!=='PASS'&&!reason.key.startsWith('unit:')&&!reason.key.startsWith('channel:'));
    verifiedUnits.set(cycle.id,new Set(global?[]:cycle.units.filter(unit=>evaluated.reasons.filter(reason=>reason.key===`unit:${unit.id}`||reason.key.startsWith(`channel:${unit.id}:`)).every(reason=>reason.result==='PASS')).map(unit=>unit.id)));
    states.set(cycle.id,result);add(cycle.id,result,needsLive?'NATIVE_COMPLETION':'ORIGINAL_DELIVERY_PROVENANCE');
  }
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(cycle:CycleRecord)=>{
    if(visiting.has(cycle.id)){add(cycle.id,'CONFLICT','REPAIR_CYCLE');return;}
    if(visited.has(cycle.id))return;visiting.add(cycle.id);
    if(cycle.repairOf) {
      const old=cycles.find(c=>c.id===cycle.repairOf),decision=cycle.approvedRepairDecision;
      const facts=input.decisions.filter(f=>f.eventId===decision?.eventId);
      const fact=facts[0],ordered=(values:unknown[])=>JSON.stringify([...values].sort());
      if(!old||facts.length!==1||!fact||fact.actorId!==input.repairActorId||fact.cycleId!==old.id||fact.sourceSha!==old.sourceSha
        ||!(/^[a-f0-9]{40}$/.test(fact.originalStateCommit))||ordered(fact.originalActiveCycleIds)!==ordered([old.id])
        ||['eventId','actorId','createdAt','cycleId','sourceSha','evidencePath'].some(key=>(fact as unknown as Record<string,unknown>)[key]!==decision?.[key])
        ||['unitIds','releaseIds','tags'].some(key=>ordered((fact as unknown as Record<string,unknown[]>)[key]!)!==ordered(decision?.[key] as unknown[]))
        ||!fact.unitIds.length||new Set(fact.unitIds).size!==fact.unitIds.length||fact.unitIds.some(id=>!old.units.some(unit=>unit.id===id)||!cycle.units.some(unit=>unit.id===id))
        ||ordered(fact.releaseIds)!==ordered(old.units.filter(unit=>fact.unitIds.includes(unit.id)&&unit.releaseId!==null).map(unit=>unit.releaseId))
        ||ordered(fact.tags)!==ordered(old.units.filter(unit=>fact.unitIds.includes(unit.id)).map(unit=>unit.tag)))add(cycle.id,'CONFLICT','REPAIR_DECISION_UNPROVEN');
      else {visit(old);edges.push({from:cycle.id,to:old.id,unitIds:fact.unitIds});}
    }
    visiting.delete(cycle.id);visited.add(cycle.id);
  };
  for(const cycle of cycles)visit(cycle);
  for(let pass=0;pass<cycles.length;pass++) {
    const before=discharged.size;
    for(const edge of edges)if(states.get(edge.from)==='PASS'||discharged.has(edge.from)) {
      const covered=repairCoverage.get(edge.to)??new Set<string>();for(const id of edge.unitIds)covered.add(id);repairCoverage.set(edge.to,covered);
    }
    for(const cycle of cycles)if(repairCoverage.has(cycle.id)&&cycle.units.every(unit=>repairCoverage.get(cycle.id)!.has(unit.id)||verifiedUnits.get(cycle.id)?.has(unit.id)))discharged.add(cycle.id);
    if(discharged.size===before)break;
  }
  const dischargedReasons=new Set(['NATIVE_COMPLETION','ORIGINAL_DELIVERY_PROVENANCE','FRESH_COMPLETION_REQUIRED','ORIGINAL_COMPLETION_REQUIRED']);
  const blockers=reasons.filter(r=>r.result!=='PASS'&&!(discharged.has(r.cycleId)&&dischargedReasons.has(r.reason)));
  const result:CompletionTruth=blockers.some(r=>r.result==='CONFLICT')?'CONFLICT':blockers.some(r=>r.result==='UNKNOWN')?'UNKNOWN':blockers.length?'WAIT':'PASS';
  return {result,reasons,dischargedCycleIds:[...discharged].sort(),activeCycleIds:discovered.filter(c=>states.get(c.id)!=='PASS'&&!discharged.has(c.id)).map(c=>c.id),
    lastCompletedCycleId:[...discovered].reverse().find(c=>states.get(c.id)==='PASS')?.id??null};
}
