import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionContext,centralReadOnly,verifyCentral,main,productEvidenceIo} from './release-worker.mjs';
import {NativeEvidenceReader} from './native/index.js';

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

test('PR adoption and recovery reads use the read-only credential; release operations keep their original credential',()=>{
  const calls=[];
  const transport=kind=>({request:(method,path)=>{calls.push({kind,method,path});return kind;}});
  const io=productEvidenceIo(transport('release'),transport('pr-read')),prefix='/repos/splrad/steward-e08-product/';
  for(const path of ['pulls/1','pulls?state=closed&per_page=100','pulls/1/files','commits/'+sha+'/pulls?page=1','issues/1/events?page=2','issues/events/24'])
    assert.equal(io.request('GET',prefix+path),'pr-read');
  for(const [method,path] of [['POST','pulls'],['PUT','pulls/1/merge'],['GET','git/ref/heads/steward/release-state'],['GET','rulesets'],['GET','actions/runs/123'],['POST','actions/workflows/test.yml/dispatches']])
    assert.equal(io.request(method,prefix+path),'release');
  assert.equal(io.request('GET','/repos/splrad/steward/pulls/1'),'release');
  assert(calls.filter(c=>c.kind==='pr-read').every(c=>c.method==='GET'&&c.path.startsWith(prefix)));
});
test('routed evidence retains native streaming digest and Run-page readers',async()=>{
  const release={request:()=>{},downloadDigest:async()=>({digest:sha}),readRunPage:async()=>({status:200})};
  const io=productEvidenceIo(release,{request:()=>{throw Error('Unexpected PR read');}});
  assert.equal(io.downloadDigest,release.downloadDigest);assert.equal(io.readRunPage,release.readRunPage);
  assert.deepEqual(await io.downloadDigest(),{digest:sha});assert.deepEqual(await io.readRunPage(),{status:200});
});
for(const failPage of [false,true])test(`native missing merge SHA is completed using PR events across read-only pages; second page denied=${failPage}`,async()=>{
  const repository='splrad/steward-e08-product',root=`https://api.github.com/repos/${repository}`,calls=[];
  const pull={id:7,number:7,url:root+'/pulls/7',base:{repo:{full_name:repository,id:1440689534}},state:'closed',merged:true,merged_at:'2026-11-03T00:00:00Z'};
  const read={request:async(method,path)=>{
    calls.push(path);assert.equal(method,'GET');
    const headers=new Headers();let body,status=200;
    if(path.endsWith('/pulls/7'))body=pull;
    else if(path.endsWith('/issues/7/events?per_page=100')){
      body=[{id:1,event:'labeled'}];headers.set('link',`<${root}/issues/7/events?per_page=100&page=2>; rel="next"`);
    }else if(path.endsWith('/issues/7/events?per_page=100&page=2')){
      status=failPage?403:200;
      body=[{id:2,event:'merged',url:root+'/issues/events/2',commit_id:sha,commit_url:root+'/commits/'+sha,actor:{id:44151430},created_at:'2026-11-03T00:00:00Z'}];
    }else throw Error('Unexpected evidence path');
    return {status,headers,bytes:Buffer.from(JSON.stringify(body))};
  }};
  const reader=new NativeEvidenceReader(productEvidenceIo({request:()=>{throw Error('PR evidence leaked to release writer');}},read),repository);
  if(failPage)await assert.rejects(reader.json('pulls/7'));
  else {const completed=await reader.json('pulls/7');assert.equal(completed.merge_commit_sha,sha);assert.equal(completed.merge_commit_evidence.id,2);}
  assert.equal(calls.length,3);assert.equal(Object.hasOwn(pull,'merge_commit_sha'),false);
});
