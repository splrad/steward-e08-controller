import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionContext,centralReadOnly,verifyCentral,main} from './release-worker.mjs';

const central='splrad/steward-e08-controller',id=1440689456,sha='a'.repeat(40);
const env={GITHUB_REPOSITORY:central,GITHUB_REPOSITORY_ID:String(id),GITHUB_REF:'refs/heads/e08-channel-trunk',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_WORKFLOW_REF:`${central}/.github/workflows/release.yml@refs/heads/e08-channel-trunk`,GITHUB_WORKFLOW_SHA:sha,GITHUB_SHA:sha,
  GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',E08_ADOPTION_PR:'7'};
test('exact central dispatch identity passes; altered repo, ref, event, path, SHA or input fails before execution',async()=>{
  assert.equal(executionContext(env).adoptionPr,7);
  for(const [key,value] of [['GITHUB_REPOSITORY','splrad/steward'],['GITHUB_REPOSITORY_ID','1296724484'],['GITHUB_REF','refs/heads/feature'],
    ['GITHUB_EVENT_NAME','pull_request'],['GITHUB_WORKFLOW_REF',`${central}/.github/workflows/other.yml@refs/heads/e08-channel-trunk`],
    ['GITHUB_WORKFLOW_SHA','b'.repeat(40)],['GITHUB_SHA','b'.repeat(40)],['GITHUB_RUN_ID','0'],['GITHUB_RUN_ATTEMPT','1.1'],['E08_ADOPTION_PR','7; arbitrary']]) {
    await assert.rejects(main({...env,[key]:value}),/E08_CENTRAL_IDENTITY/);
  }
});
test('central transport is read only and cannot reach product, production, or path traversal',()=>{
  const seen=[],io=centralReadOnly({request:(...args)=>seen.push(args)});
  io.request('GET',`/repos/${central}`);io.request('GET',`/repos/${central}/actions/runs/100`);
  for(const [method,path] of [['POST',`/repos/${central}/actions/workflows/release.yml/dispatches`],['GET','/repos/splrad/steward/actions/runs/1'],
    ['GET','/repos/splrad/steward-e08-product'],['GET',`/repos/${central}/../steward`],['GET',`/repos/${central}/%2e%2e/steward`],
    ['GET',`/repos/${central}other/actions/runs/1`]])assert.throws(()=>io.request(method,path),/E08_CENTRAL_READ_ONLY/);
  assert.equal(seen.length,2);
});
test('native central evidence must match exact run attempt, checkout, workflow and active repository',async()=>{
  const repository={id,full_name:central,default_branch:'e08-channel-trunk',archived:false,disabled:false};
  const run={id:100,repository:{id},head_repository:{id},workflow_id:3,path:'.github/workflows/release.yml',event:'workflow_dispatch',
    head_sha:sha,head_branch:'e08-channel-trunk',actor:{id:44151430},triggering_actor:{id:44151430},run_attempt:1,status:'in_progress',conclusion:null,
    created_at:'2026-11-03T00:00:00Z',updated_at:'2026-11-03T00:00:00Z',display_title:'E08'};
  const workflow={id:3,path:'.github/workflows/release.yml',state:'active'};
  const fixture=(repo,r,w)=>({request:async(method,path)=>{
    assert.equal(method,'GET');let value;
    if(path===`/repos/${central}`)value=repo;
    else if(path===`/repos/${central}/actions/runs/100/attempts/1`)value=r;
    else if(path===`/repos/${central}/actions/workflows/3`)value=w;
    else throw Error('UNEXPECTED_NATIVE_READ');
    return {status:200,bytes:Buffer.from(JSON.stringify(value))};
  }});
  assert.equal((await verifyCentral(executionContext(env),fixture(repository,run,workflow))).id,100);
  for(const changed of [{...run,repository:{id:1296724484}},{...run,head_repository:{id:1}},{...run,run_attempt:2},{...run,status:'completed'},
    {...run,head_sha:'b'.repeat(40)},{...run,path:'.github/workflows/other.yml'},{...run,event:'push'}])
    await assert.rejects(verifyCentral(executionContext(env),fixture(repository,changed,workflow)),/E08_NATIVE_CENTRAL_IDENTITY/);
  await assert.rejects(verifyCentral(executionContext(env),fixture({...repository,archived:true},run,workflow)),/E08_NATIVE_CENTRAL_IDENTITY/);
  await assert.rejects(verifyCentral(executionContext(env),fixture(repository,run,{...workflow,state:'disabled_manually'})),/E08_NATIVE_CENTRAL_IDENTITY/);
});
