import { expect, it } from 'vitest';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const {coordinateReleaseWake,serviceReleaseWake,fetchState}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
it('reads Pages state only after validating both governance writers and an unbypassable integrity rule',async()=>{
  const repository={id:12,full_name:'test/product',default_branch:'main'},reads:string[]=[];
  let actors=[4243096,900],integrity:any[]=[],omitBypass=false;
  const fetcher=async(input:any,init:any)=>{
    const path=decodeURIComponent(new URL(String(input)).pathname);reads.push(path);expect(init.method).toBe('GET');
    if(path.includes('/git/ref/'))return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
    const data=path.includes('/rules/branches/')?[
      {type:'creation',ruleset_id:1},{type:'update',ruleset_id:1},{type:'non_fast_forward',ruleset_id:2},{type:'deletion',ruleset_id:2}
    ]:{id:path.endsWith('/1')?1:2,target:'branch',enforcement:'active',
      ...(omitBypass?{}:{bypass_actors:path.endsWith('/1')?actors.map(actor_id=>({actor_id,actor_type:'Integration',bypass_mode:'always'})):integrity}),
      rules:path.endsWith('/1')?[{type:'creation'},{type:'update',parameters:{update_allows_fetch_and_merge:false}}]:[{type:'non_fast_forward'},{type:'deletion'}]};
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  };
  const read=(governanceAppId:any=900)=>fetchState('',repository,'fixture-token','steward/governance-state',{governanceAppId,fetcher});
  await expect(read()).rejects.toThrow('RELEASE_BOOTSTRAP_REQUIRED');
  expect(reads.at(-1)).toBe('/repos/test/product/git/ref/heads/steward/governance-state');
  reads.length=0;actors=[4243096];await expect(read()).rejects.toThrow('QUALITY_PROTECTION');
  actors=[4243096,900];integrity=[{actor_id:4243096}];await expect(read()).rejects.toThrow('QUALITY_INTEGRITY');
  integrity=[];omitBypass=true;await expect(read()).rejects.toThrow('QUALITY_PROTECTION');
  await expect(read(null)).rejects.toThrow('QUALITY_GOVERNANCE_ID_PENDING');
  expect(reads.some(path=>path.includes('/git/ref/'))).toBe(false);
});
const START=Date.parse('2026-10-27T00:00:00Z');
it('services the least recently served repositories first, isolates failures and emits only aggregate health',async()=>{
  const calls:number[]=[],health:any[]=[];
  const summary=await coordinateReleaseWake({discover:async()=>[{id:1,full_name:'private/secret'},{id:2},{id:3}],
    observe:async(repo:any)=>({lastServedAt:new Date(START+repo.id*60_000).toISOString(),nextCheckAt:null}),
    service:async(repo:any)=>{calls.push(repo.id);if(repo.id===2)throw new Error('private/secret credential-shaped failure');return {status:'WAIT'};},health:async(value:any)=>health.push(value)},()=>START+10*60_000);
  expect(calls).toEqual([1,2,3]);expect(summary.counts).toEqual({scanned:3,completed:0,waiting:2,failed:1,unknown:0});
  expect(summary.scanCompletedAt).toBeNull();expect(JSON.stringify(health)).not.toMatch(/private|secret|credential/);expect(summary.errorCodes).toEqual(['RELEASE_NATIVE_UNAVAILABLE']);
});
it('stops claiming repositories at forty minutes and does not refresh scanCompletedAt',async()=>{
  let now=START;const claims:number[]=[];
  const result=await coordinateReleaseWake({discover:async()=>[{id:1},{id:2},{id:3}],observe:async(repo:any)=>{claims.push(repo.id);now+=20*60_000;return {lastServedAt:null,nextCheckAt:null};},service:async()=>{throw new Error('must not claim');},health:async()=>{}},()=>now);
  expect(claims).toEqual([1,2]);expect(result.scanCompletedAt).toBeNull();expect(result.errorCodes).toContain('CLAIM_WINDOW_CLOSED');
});
it('honors nextCheckAt without polling or invoking a business entry',async()=>{
  let calls=0;const result=await coordinateReleaseWake({discover:async()=>[{id:1}],observe:async()=>({nextCheckAt:new Date(START+60_000).toISOString()}),service:async()=>{calls++;},health:async()=>{}},()=>START);
  expect(calls).toBe(0);expect(result.counts.waiting).toBe(1);expect(result.scanCompletedAt).toBe(new Date(START).toISOString());
});
it('services Pages independently of absent release state or a future channel wait, isolating private errors',async()=>{
  const calls:number[]=[];
  const result=await coordinateReleaseWake({discover:async()=>[{id:1},{id:2},{id:3}],pages:async(r:any)=>{calls.push(r.id);if(r.id===2)throw Error('private/name');return {status:'WAIT'};},
    observe:async(r:any)=>{if(r.id===1)throw Error('RELEASE_BOOTSTRAP_REQUIRED');return {nextCheckAt:new Date(START+60000).toISOString()};},
    service:async()=>{throw Error('must wait');},health:async()=>{}},()=>START);
  expect(calls).toEqual([1,2,3]);expect(result.errorCodes).toContain('PAGES_UNAVAILABLE');expect(JSON.stringify(result)).not.toContain('private/name');expect(result.counts.waiting).toBe(2);
});
it('invokes the fixed entry sequence and recovers only native canonical Run IDs',async()=>{
  const calls:string[]=[],snapshot={repository:{activeCycleId:'cycle'},cycles:[{value:{id:'cycle',dispatches:[{canonicalRunId:100},{canonicalRunId:null}]}}]};
  const result=await serviceReleaseWake({},async()=>snapshot,async(command:string,input:any)=>{calls.push(command+(command==='rerun'?':'+input.runId:''));return {status:'WAIT',reason:'PREREQUISITE_REQUIRED',publishInvoked:false};});
  expect(calls).toEqual(['candidate','dispatch-build','publish','dispatch-channel','observe-channel','rerun:100']);expect(result.status).toBe('WAIT');
});
it('ends a repository wake after the single publish invocation',async()=>{
  const calls:string[]=[],snapshot={repository:{activeCycleId:'cycle'},cycles:[]};
  const result=await serviceReleaseWake({},async()=>snapshot,async(command:string)=>{calls.push(command);return {status:'WAIT',publishInvoked:command==='publish'};});
  expect(calls).toEqual(['candidate','dispatch-build','publish']);expect(result.publishInvoked).toBe(true);
});
it('keeps health failure separate from successful business service and never repeats that service',async()=>{
  let calls=0;await expect(coordinateReleaseWake({discover:async()=>[{id:1}],observe:async()=>({nextCheckAt:null}),service:async()=>{calls++;return {status:'COMPLETE'};},health:async()=>{throw new Error('health unavailable');}},()=>START)).rejects.toThrow('health unavailable');expect(calls).toBe(1);
});
it('continues a new wake with previously unserved repositories after the forty-minute cutoff',async()=>{
  let now=START;const calls:number[]=[],served=new Map<number,string>();
  const ports={discover:async()=>[{id:1},{id:2},{id:3}],observe:async(repo:any)=>({lastServedAt:served.get(repo.id)??null,nextCheckAt:null}),
    service:async(repo:any)=>{calls.push(repo.id);served.set(repo.id,new Date(now).toISOString());now+=20*60_000;return {status:'WAIT'};},health:async()=>{}};
  const first=await coordinateReleaseWake(ports,()=>now);expect(calls).toEqual([1,2]);expect(first.scanCompletedAt).toBeNull();
  now+=60_000;await coordinateReleaseWake(ports,()=>now);expect(calls.slice(2)).toEqual([3,1]);
});
it('isolates inaccessible, archived and disabled repositories without changing their state or exposing their names',async()=>{
  const observed:number[]=[],serviced:number[]=[];
  const result=await coordinateReleaseWake({discover:async()=>[{id:1,full_name:'private/denied'},{id:2,archived:true},{id:3,disabled:true},{id:4}],
    observe:async(repo:any)=>{observed.push(repo.id);if(repo.id===1)throw new Error('403 private/denied');return {};},
    service:async(repo:any)=>{serviced.push(repo.id);return {status:'WAIT'};},health:async()=>{}},()=>START);
  expect(observed).toEqual([1,4]);expect(serviced).toEqual([4]);expect(result.counts.unknown).toBe(1);
  expect(JSON.stringify(result)).not.toMatch(/private|denied|403/);expect(result.scanCompletedAt).toBeNull();
});
