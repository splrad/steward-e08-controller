import { expect, it } from 'vitest';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { permitOfflineCommand } from './offline-fixtures.js';
const {coordinateReleaseWake,serviceReleaseWake}=await import(pathToFileURL(resolve('scripts/release-coordinator.mjs')).href);
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
it.skipIf(process.platform==='win32')('executes independent native health against all-attempt fixtures and retains successful no-target entry after health-only rerun',async()=>{
  const workflow=YAML.parse(await readFile('.github/workflows/release.yml','utf8')),script=workflow.jobs['automation-health'].steps[0].run;
  const root=await mkdtemp(join(tmpdir(),'native-health-fixture-'));
  try {
    const fixture=String.raw`
gh() {
  local endpoint='' arg
  for arg in "$@"; do if [[ "$arg" == repos/* || "$arg" == users/* ]]; then endpoint=$arg; fi; done
  case "$endpoint" in
    repos/splrad/steward) printf '%s' '{"id":1296724484,"full_name":"splrad/steward","default_branch":"main","archived":false,"disabled":false}' ;;
    repos/splrad/steward/actions/runs/1) printf '%s' '{"id":1,"run_attempt":2,"workflow_id":10,"repository":{"id":1296724484},"head_branch":"main","event":"schedule"}' ;;
    users/*) printf '%s' '{"id":41898282,"type":"Bot"}' ;;
    repos/splrad/steward/issues*) printf '%s' '[[]]' ;;
    repos/splrad/steward/actions/workflows/release.yml) printf '%s' '{"id":10,"path":".github/workflows/release.yml","state":"active"}' ;;
    repos/splrad/steward/actions/workflows/update-dependencies.yml) printf '%s' '{"id":20,"path":".github/workflows/update-dependencies.yml","state":"active"}' ;;
    repos/splrad/steward/actions/workflows/20/runs*status=*) printf '%s' '[{"total_count":0,"workflow_runs":[]}]' ;;
    repos/splrad/steward/actions/workflows/20/runs*)
      data=$(jq -cn --arg now "$(date -u +%FT%TZ)" '{total_count:1,workflow_runs:[{id:2,repository:{id:1296724484},head_repository:{id:1296724484},workflow_id:20,head_branch:"main",event:"schedule",run_attempt:2,created_at:$now,run_started_at:$now}]}')
      if [[ " $* " == *' --slurp '* ]]; then printf '[%s]' "$data"; else printf '%s' "$data"; fi ;;
    repos/splrad/steward/actions/runs/2/jobs*)
      jq -cn --arg now "$(date -u +%FT%TZ)" '[{total_count:2,jobs:[{id:21,name:"targets",run_attempt:1,status:"completed",conclusion:"success",started_at:$now,steps:[{name:"update-targets-empty",conclusion:"success"},{name:"update-targets-found",conclusion:"skipped"}]},{id:22,name:"automation-health",run_attempt:2,status:"completed",conclusion:"failure",started_at:$now}]}]' ;;
    *) printf 'UNREGISTERED %s\n' "$endpoint" >&2; return 42 ;;
  esac
}
`;
    const args=['-c',fixture+'\n'+script];permitOfflineCommand('bash',args);
    const result=spawnSync('bash',args,{env:{...process.env,GH_TOKEN:'offline',DEFAULT_BRANCH:'main',CURRENT_RUN_ID:'1',CURRENT_ATTEMPT:'2'},cwd:root,encoding:'utf8',timeout:20_000});
    expect(result.status,result.stderr).toBe(0);expect(result.stdout).toBe('');
  }finally {await rm(root,{recursive:true,force:true});}
});
